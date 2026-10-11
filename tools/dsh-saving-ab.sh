#!/bin/bash
# dsh 场景的 token 省钱 A/B（可复跑）。
#
# 是什么：拿 dsh（DeepSeek Harness）真实会发的**请求形状**——system + 多轮 user + 嵌套 tools——
#         做 A/B 双发，量化旁挂桥（token-policy-bridge）对 dsh 到底省不省。
#   A 组 = dsh 不开 curator：请求直连 18790（multi-proxy 的 codex-proxy），桥不在路径上。
#   B 组 = dsh 开 curator：请求过桥 18795（上游同样是 18790），桥做 rewrite。
#   ⇒ 唯一变量是「桥在不在路径上」，A/B 可归因。
#
# 🔴 三条硬纪律（踩过，别改）：
#   1. curl 一律 `--noproxy '*'`。本机 HTTP_PROXY=http://127.0.0.1:57112（Clash Verge Rev），
#      不加会打到代理上，看到的是代理的「upstream connect failed」而不是上游/桥的真响应。
#   2. 必须**交错发**（for r in 1..N {A;B}），顺序发 A 基线会因为缓存命中漂移被读成「优化没用」。
#   3. 只看 **cache miss**（DeepSeek 口径：miss 才是真花钱输入）。cached 是顺序副作用，
#      只看 cached 会把「B 更省」的假象算出来。
#
# 🔴 两个已知的形状天花板（不是桥的锅，别往桥上推）：
#   · DeepSeek 上游只收**纯 role:'user' 轮次**；带 assistant+tool 轮 + tools 直连 18790 也是 400。
#     ⇒ 这里用「user 轮里夹大段文本」来模拟工具输出膨胀，触发桥的 onHistory/lazyload。
#   · agnes 只收**嵌套 tools**（{type:'function', function:{...}}），扁平一律 400。
#
# 用法： ./tools/dsh-saving-ab.sh [轮数，默认 3]
set -u

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TOOLS_DIR/.." && pwd)"
UPSTREAM="http://127.0.0.1:18790"
BRIDGE="http://127.0.0.1:18795"
BRIDGE_HEALTH="$BRIDGE/health"
MODELS="${MODELS:-deepseek-v4-flash}"
ROUNDS="${1:-3}"
NODE_BIN="/Users/xiaota/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
PAYLOAD="$REPO_DIR/logs/dsh-ab-payload.json"

# ---- 0. 起桥（launchd 挂了就降级 nohup；桥死了后面全是废话）----
"$TOOLS_DIR/bridge-launchd.sh" restart >/dev/null 2>&1 || true
if ! curl -s --noproxy '*' --max-time 4 "$BRIDGE_HEALTH" | grep -q '"ok"'; then
  echo "❌ 桥没起来（18795 不响应 /health）。launchd 若报 Input/output error 是环境级故障，" >&2
  echo "   需要在真 Terminal 里执行：launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.multi-proxy.token-policy-bridge.plist" >&2
  exit 1
fi

# ---- 1. 造 dsh 形状的请求体 ----
# 🔴 默认走**真 dsh 会话**（tools/dsh-session-rebuild.js 从 ~/.dsh/sessions 重建），
#    不再用合成样本。原因（实测）：合成样本是 [system, user, user]，历史里一条
#    assistant tool_calls 都没有 ⇒ tools-lazyload 的 activeToolNames 扫不到证据 ⇒
#    每次都 fallback no-usage-evidence ⇒「省 0」是**样本没造对**，不是桥没用。
#    FAKE=1 才回退到合成样本（用来对照 / 扫参数）。
if [ "${FAKE:-0}" != "1" ]; then
  echo "样本来源：真 dsh 会话（tools/dsh-session-rebuild.js，默认最大那个会话）"
  TMPP="$REPO_DIR/logs/dsh-ab-real-payload.json"
  "$NODE_BIN" "$TOOLS_DIR/dsh-session-rebuild.js" "$TMPP" "$MODELS" --max-msgs 60 --max-chars 250000 || exit 1
  PAYLOAD="$TMPP"
else
  echo "样本来源：合成样本（FAKE=1）"
  TMPP="$REPO_DIR/logs/dsh-ab-fake-payload.json"
"$NODE_BIN" -e '
const fs = require("fs");
const NAMES = ["read_file","search_code","apply_patch","run_terminal","list_dir","grep_files",
               "fetch_url","write_file","git_diff","todo_write"];
const tools = NAMES.map(n => ({
  type: "function",
  function: {
    name: n,
    description: "dsh agent built-in tool: " + n + ". Use it to inspect or mutate the repository while working through the current task list.",
    parameters: { type: "object", properties: {
      path:       { type: "string", description: "absolute or repo-relative path" },
      pattern:    { type: "string", description: "regex to match" },
      limit:      { type: "integer", description: "max lines to return" },
      content:    { type: "string", description: "new file content for write operations" }
    }, required: ["path"] }
  }
}));
const big = ("[tool:search_code] hits 214\n" + "  src/index.js:42  for (const m of mods) { /* ... */ }\n").repeat(90);
fs.writeFileSync(process.argv[1], JSON.stringify({
  model: process.argv[2],
  stream: false,
  tools,
  messages: [
    { role: "system", content: "You are dsh, a coding agent running inside DeepSeek Harness. You have access to file and shell tools." },
    { role: "user", content: "Fix the failing tests in this repo and summarize what you changed." },
    { role: "user", content: big }
  ]
}, null, 0));
' "$TMPP" "$MODELS" || exit 1
  PAYLOAD="$TMPP"
fi

echo "模型 = $MODELS ｜ 轮数 = $ROUNDS ｜ payload = $(wc -c < "$PAYLOAD" | tr -d ' ') B"
echo "A = 直连 ${UPSTREAM}（桥不在路径）  B = 过桥 ${BRIDGE}（桥 rewrite）"
echo

# ---- 2. 交错 A/B，收集 usage ----
probe() {
  local url="$1" label="$2"
  local body status
  # 🔴 路径是 /v1/chat/completions（桥和 codex-proxy 都是 /v1 前缀），少 /v1 会 404。
  # 🔴 必须把 http 码一起取回来：4xx 时 response 里没有 usage，混进均值会算成
  #    「省了 N token」，其实是请求根本没成功（实测踩过，一次 400 被读成 0）。
  # 🔴 max-time 给到 180：42k token 的真会话 + 思考型模型单次能到几十秒。
  local raw
  raw="$(curl -s --noproxy '*' --max-time 180 -X POST "$url/v1/chat/completions" \
    -H 'content-type: application/json' --data-binary @"$PAYLOAD" -w '
%{http_code}')"
  body="$(printf '%s' "$raw" | sed '$d')"
  status="$(printf '%s\n%s' "$body" "$(printf '%s' "$raw" | tail -n 1)" | "$NODE_BIN" -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const p=s.trim().split("\n");
  const code=String(p.pop()).trim();
  const rest=p.join("\n");
  if (code!=="200") { console.log("HTTP"+code+" "); return; }
  try { const u=JSON.parse(rest).usage||{};
    console.log([u.prompt_tokens||0, u.prompt_cache_hit_tokens||0, u.prompt_cache_miss_tokens||0].join(" "));
  } catch(e) { console.log("BADJSON "); }
});')"
  # 提示行走 stderr，别混进 rows（rows 是要被解析的数字行）。
  printf '  %-16s pt=%s hit=%s miss=%s\n' "$label" $status >&2
  printf '%s\n' "$status"
}

rows=""
# 🔴 原始 usage 落盘：汇总以后可以**离线重放**（node tools/dsh-ab-summarize.js <raw>），
#    不必为了看一张表再花 4 次上游请求（DeepSeek 限流很凶，实测一次 429 就白跑一轮）。
RAWLOG="$REPO_DIR/logs/dsh-ab-raw-$(date +%Y-%m-%d-%H%M%S).jsonl"
: > "$RAWLOG"
PAYHASH="$(shasum -a 256 "$PAYLOAD" | cut -c1-12)"
echo "$PAYHASH payload" >> "$RAWLOG"
for r in $(seq 1 "$ROUNDS"); do
  echo "--- round $r ---"
  # 🔴 zsh 下 "$UPSTREAM" 紧跟中文会被当成变量名的一部分（报 `UPSTREAM?: unbound variable`），
  #    变量引用一律加花括号。
  a="$(probe "${UPSTREAM}" "A(直连18790)")"
  b="$(probe "${BRIDGE}"   "B(过桥18795)")"
  rows="$(printf '%s\n%s|%s\n' "$rows" "$a" "$b")"
  printf '%s|%s\n' "$a" "$b" >> "$RAWLOG"
  # B 组顺手打一下桥的 metrics，看桥自己报了什么
  tail -n 1 "$REPO_DIR/logs/token-policy-bridge-$(date +%Y-%m-%d).jsonl" 2>/dev/null \
    | "$NODE_BIN" -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const o=JSON.parse(s);
    if (o.estSaved!==undefined || o.appliedFields)
      console.log("   桥自报: estSaved=" + (o.estSaved||0) + " reason=" + (o.reason||"-") + " applied=" + JSON.stringify(o.appliedFields||[]));
  } catch(e) {}
});'
done

# ---- 3. 汇总 ----
echo
echo "== raw = $RAWLOG （离线可重放，不用再花上游请求：node tools/dsh-ab-summarize.js <raw>）=="
echo
printf '%s\n' "$rows" | grep -v '^$' | "$NODE_BIN" -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows = s.trim().split("\n").map(l=>l.split("|")).filter(x=>x.length===2)
                     .map(([a,b])=>[a.trim().split(" "),b.trim().split(" ")])
                     .filter(([a,b])=>a.length===3 && b.length===3 && !isNaN(parseInt(a[0])));
  if (!rows.length) { console.log("（没有可用样本，看看是不是上游 429/4xx 了）"); return; }
  const mean = arr => arr.reduce((x,y)=>x+y,0)/arr.length;
  // 🔴 列：a[0]=A(直连) a[1]=B(过桥)；行内 3 个数 = pt hit miss。
  const A = rows.map(r=>r[0]), B = rows.map(r=>r[1]);
  const ptV = (c,i)=>parseInt(c[i][0])||0, htV = (c,i)=>parseInt(c[i][1])||0, msV = (c,i)=>parseInt(c[i][2])||0;
  const f = n => (Math.round(n*10)/10).toFixed(1);
  const pct = (x,y) => (y!==0 ? (100*(x-y)/y).toFixed(1)+"%" : "n/a");

  const A_pt = mean(A.map((_,i)=>ptV(A,i))), B_pt = mean(B.map((_,i)=>ptV(B,i)));
  const A_ms = mean(A.map((_,i)=>msV(A,i))), B_ms = mean(B.map((_,i)=>msV(B,i)));
  // 🔴 上游不回缓存分档时（实测 agnes 不回 prompt_cache_hit/miss），口径二/三会全 0。
  //    0 会被读成「没省钱」，跟口径一的 −35% 直接打架 —— 宁可显式标 n/a，不硬凑数字。
  const cacheSplit = [...A, ...B].some(r => (parseInt(r[1])||0) > 0 || (parseInt(r[2])||0) > 0);

  console.log("===== 汇总（pt = prompt_tokens = hit + miss）=====");
  console.log("");
  console.log("[口径一] 少传了多少 —— 确定性，不依赖缓存");
  console.log("   A(直连) pt 均值 = " + f(A_pt).padStart(9) + "    B(过桥) pt 均值 = " + f(B_pt).padStart(9));
  console.log("   Δ = " + f(B_pt-A_pt).padStart(9) + "   " + pct(B_pt,A_pt));
  console.log("   ⚠️ pt 是「这一轮要喂进去的量」，不是「这一轮花钱的量」。但 hit 也按量打折计价，");
  console.log("      所以历史缩短 ⇒ 打折那一路的基数也小了 ⇒ 这个 Δ 在任何计费口径下都是真的省。");
  console.log("");
  console.log("[口径二] 真付钱多少 —— miss 才是每次全价新算的那一截");
  console.log("   A(直连) miss 均值 = " + f(A_ms).padStart(6) + "    B(过桥) miss 均值 = " + f(B_ms).padStart(6));
  console.log("   Δ = " + f(B_ms-A_ms).padStart(6) + "   " + pct(B_ms,A_ms));
  if (!cacheSplit)
    console.log("   ⚠️ n/a：上游未回 prompt_cache_hit/miss 分档，miss 恒 0 —— 本口径不可用，别读成「没省」");
  console.log("   🔴 别把口径一的 −32% 读成「每轮每轮都省三成」。miss 只反映「这轮新变的尾巴」，");
  console.log("      稳态下它跟桥没关系。要看桥有没有省钱，看口径一 + 下面的钱。");
  console.log("");
  console.log("[口径二·拆] 首轮 vs 稳态（交错发 ⇒ 两边共用上游缓存，round1 也已不是冷启动，只能看趋势）");
  const line = (t,i) => "   " + t.padEnd(6) + " A pt=" + String(ptV(A,i)).padStart(6) +
                        " miss=" + String(msV(A,i)).padStart(5) +
                        "   | B pt=" + String(ptV(B,i)).padStart(6) +
                        " miss=" + String(msV(B,i)).padStart(5);
  console.log(line("r1",0));
  for (let i=1;i<Math.min(A.length,3);i++) console.log(line("r"+(i+1),i));
  console.log("");
  // 🔴 按钱说话（DeepSeek news0802 价：未命中 1 元/M，命中 0.1 元/M —— 不是通用价，换上游重算）。
  //    注意这里**没有**任何单引号：整段 node 代码在 shell 单引号里，写一个单引号就会截断脚本。
  const yuan = (hit, miss) => (miss/1e6)*1 + (hit/1e6)*0.1;
  const AH = mean(A.map((_,i)=>htV(A,i))), AM = mean(A.map((_,i)=>msV(A,i)));
  const BH = mean(B.map((_,i)=>htV(B,i))), BM = mean(B.map((_,i)=>msV(B,i)));
  const ac = yuan(AH,AM), bc = yuan(BH,BM);
  console.log("[口径三] 钱（输入侧；DeepSeek 未命中 1 元/M + 命中 0.1 元/M）");
  if (!cacheSplit) {
    console.log("   n/a —— 上游未回 prompt_cache_hit/miss，无法按缓存分档计价");
    console.log("         （硬算会得到 0 元，被读成「没省钱」，跟口径一打架，故不凑数）");
    console.log("   👉 省钱结论看口径一（pt Δ）：确定性，不依赖缓存分档。");
  } else {
    console.log("   A(直连) = " + ac.toFixed(5) + " 元    B(过桥) = " + bc.toFixed(5) + " 元    变化 = " + pct(bc,ac));
  }
  console.log("   ⚠️ 不含输出；换上游/换价要重算这一行。");
});'
