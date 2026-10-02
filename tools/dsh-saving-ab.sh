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
NODE_BIN="/Users/xiaota/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"
PAYLOAD="$REPO_DIR/logs/dsh-ab-payload.json"

# ---- 0. 起桥（launchd 挂了就降级 nohup；桥死了后面全是废话）----
"$TOOLS_DIR/bridge-launchd.sh" restart >/dev/null 2>&1 || true
if ! curl -s --noproxy '*' --max-time 4 "$BRIDGE_HEALTH" | grep -q '"ok"'; then
  echo "❌ 桥没起来（18795 不响应 /health）。launchd 若报 Input/output error 是环境级故障，" >&2
  echo "   需要在真 Terminal 里执行：launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/com.multi-proxy.token-policy-bridge.plist" >&2
  exit 1
fi

# ---- 1. 造 dsh 形状的请求体 ----
# 工具名/形状刻意贴 dsh 的 agent 会话（10 把嵌套 tools + 一轮 3KB 的「工具输出」）。
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
' "$PAYLOAD" "$MODELS" || exit 1

echo "模型 = $MODELS ｜ 轮数 = $ROUNDS ｜ payload = $(wc -c < "$PAYLOAD" | tr -d ' ') B"
echo "A = 直连 ${UPSTREAM}（桥不在路径）  B = 过桥 ${BRIDGE}（桥 rewrite）"
echo

# ---- 2. 交错 A/B，收集 usage ----
probe() {
  local url="$1" label="$2"
  local body status
  # 🔴 路径是 /v1/chat/completions（桥和 codex-proxy 都是 /v1 前缀），少 /v1 会 404。
  body="$(curl -s --noproxy '*' --max-time 60 -X POST "$url/v1/chat/completions" \
    -H 'content-type: application/json' --data-binary @"$PAYLOAD")"
  status="$(printf '%s' "$body" | "$NODE_BIN" -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { const u=JSON.parse(s).usage||{};
    console.log([u.prompt_tokens||0, u.prompt_cache_hit_tokens||0, u.prompt_cache_miss_tokens||0].join(" "));
  } catch(e) { console.log("ERR " + String(s).slice(0,120)); }
});')"
  # 提示行走 stderr，别混进 rows（rows 是要被解析的数字行）。
  printf '  %-16s pt=%s hit=%s miss=%s\n' "$label" $status >&2
  printf '%s\n' "$status"
}

rows=""
for r in $(seq 1 "$ROUNDS"); do
  echo "--- round $r ---"
  # 🔴 zsh 下 "$UPSTREAM" 紧跟中文会被当成变量名的一部分（报 `UPSTREAM?: unbound variable`），
  #    变量引用一律加花括号。
  a="$(probe "${UPSTREAM}" "A(直连18790)")"
  b="$(probe "${BRIDGE}"   "B(过桥18795)")"
  rows="$(printf '%s\n%s|%s\n' "$rows" "$a" "$b")"
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
echo "===== 汇总（pt = prompt_tokens，只看 miss 的绝对量）====="
printf '%s\n' "$rows" | grep -v '^$' | "$NODE_BIN" -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  const rows = s.trim().split("\n").map(l=>l.split("|")).filter(x=>x.length===2)
                     .map(([a,b])=>[a.trim().split(" "),b.trim().split(" ")]);
  if (!rows.length) { console.log("（没有可用样本）"); return; }
  const sum = k => { const v = rows.map(r=>r.map(x=>parseInt(x[k])||0)); return v; };
  const mean = arr => arr.reduce((x,y)=>x+y,0)/arr.length;
  const A_pt = sum(0).map(mean), B_pt = sum(1).map(mean);
  const a=[rows.map(r=>r[0]),rows.map(r=>r[1])];
  const ms = (i)=>a[1][i].map(x=>parseInt(x[2])||0);            // 第 i 列 = miss
  const A_miss = ms(0), B_miss = ms(1);
  const A_ptV = a[0].map(x=>parseInt(x[0])||0), B_ptV = a[1].map(x=>parseInt(x[0])||0);
  const fmt = n => n.toFixed ? n.toFixed(1) : String(n);
  console.log("轮数                     A(直连)   B(过桥)");
  console.log("prompt_tokens 均值       " + fmt(mean(A_ptV)).padStart(8) + "   " + fmt(mean(B_ptV)).padStart(8));
  console.log("cache miss 均值          " + fmt(mean(A_miss)).padStart(8) + "   " + fmt(mean(B_miss)).padStart(8));
  const d = mean(A_miss) - mean(B_miss);
  if (mean(A_miss) > 0) {
    console.log("真实变化（A−B，正=省）   " + fmt(d).padStart(8) + "   " + (100*d/mean(A_miss)).toFixed(1) + "%");
  } else {
    console.log("真实变化（A−B）          无意义：A 的 miss 是 0（上游没给 miss 口径），别拿这个数下结论。");
  }
});'
