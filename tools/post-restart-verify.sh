#!/usr/bin/env bash
#
# post-restart-verify — WorkBuddy 沙箱恢复后的一次性补跑与状态核对
# =====================================================================
# 为什么有这个脚本：2026-10-13 凌晨本机 Bash 沙箱失效
#   （`sandbox-exec: data object length 79911 exceeds maximum (65535)`，
#    由 ~/.workbuddy/settings.json 的文件规则撑爆 macOS sandbox profile 硬上限）
#   ⇒ 多项改动落盘但**未经全量回归**。重启 WorkBuddy 让 profile 重新生成后，
#   跑本脚本一次性补齐。
#
# 🔴 根因（2026-10-13 坐实，别再猜）：
#   profile 是 **App 启动时**按 preset 生成的，会话内改 settings.json 对当前会话无效
#   —— 实测删掉 13 条规则后字节数纹丝不动（79911 → 79911）。
#   所以「改配置」必须配合**重启 WorkBuddy** 才生效。已做的两件事：
#     ① 删规则：extraAllowWrite 12 条清空 + file-preset 79~104 共 26 条删除（104 → 78 条）
#        ⇒ 估算 78 × ~753B ≈ 58.7KB < 65535（余量约 6.7KB）
#     ② 置 "customized": true，防止 App 重启时把删掉的 preset 又补回来
#
# 用法：
#   tools/post-restart-verify.sh                        # 只回归 + 报告（不启停服务、不改 dsh）
#   tools/post-restart-verify.sh --reload-18790         # 额外 reload codex-proxy（会短断 Codex）
#   tools/post-restart-verify.sh --fix-dsh              # 额外清 dsh 污染 + 零写入接入（会写一次 ~/.dsh）
#   tools/post-restart-verify.sh --reload-18790 --fix-dsh
#
# 🔴 与 install.sh / manage.sh 的关系：本脚本只读 + 跑测试，不装东西。
#    有副作用的只有上面两个显式 flag，不给 flag 就一步不动。
#
set -uo pipefail   # 刻意不开 -e：某一项挂了也要把后面的状态打完，最后汇总

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAILS=0
note() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; FAILS=$((FAILS + 1)); }

# 修 2026-10-13：$2="" 时 $* 把 $1 自身夹进来导致空 args 也匹配 ⇒ 用 shift 去掉 $1
has_flag() {
  local flag="$1"; shift
  case " $* " in *" $flag "*) return 0 ;; *) return 1 ;; esac
}
ARGS="$*"

# ---------------------------------------------------------------- 1. 回归
# 1.1 / 1.2 = 上次没跑完的两项；1.6 = 本次新增的 SSE 透传
note "1.1 l2 demo（含 route-engine 硬规则 + shadow 算钱 + 新增 SSE 透传）"
(cd l2 && node run-demos.js 2>&1 | tail -3) || bad "l2 run-demos 失败"

note "1.2 manager jest（含 cost-track 的 cache_creation 分项计价）"
(cd multi-proxy-manager && NODE_OPTIONS=--experimental-vm-modules npx --no-install jest --silent 2>&1 | tail -5) \
  || bad "manager jest 失败"

note "1.3 cursor jest"
(cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx --no-install jest --silent 2>&1 | tail -4) \
  || bad "cursor jest 失败"

note "1.4 codex jest"
(cd codex-proxy && npx --no-install jest --silent 2>&1 | tail -4) || bad "codex jest 失败"

note "1.5 hermes pytest"
(cd hermes-proxy && /usr/bin/python3 -m pytest tests/ -q --basetemp="/tmp/pytest-hermes-$(date +%s%N)" 2>&1 | tail -4) || bad "hermes pytest 失败"

note "1.6 savings-gateway SSE 透传（dsh 这类流式客户端的命门）"
(cd l2/savings-gateway && node stream-forward.demo.js 2>&1 | tail -3) || bad "SSE 透传 demo 失败"

# ---------------------------------------------------------------- 2. 服务状态
note "2. 端口实况（--noproxy 绕开系统代理，否则 127.0.0.1 会误报）"
for p in 18790 18792 18793 18794 18795 18796; do
  if /usr/sbin/lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then ok "$p 在监听"
  else bad "$p 未监听"; fi
done

note "3. 门控是否真生效（/health 读回来才算数，配了 env 不等于生效）"
for p in 18790 18796; do
  printf '  %s: ' "$p"
  curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:${p}/health" | head -c 400
  printf '\n'
done
echo "  （18796 的 stream 字段应为 forward；是 none 说明 PROXY_SAVINGS_EXECUTOR 没生效）"

note "4. launchd 注册 vs 实际（2026-10-12 坐实：18790 的 launchd 日志停在 10-09，进程不是 launchd 拉的）"
launchctl list 2>/dev/null | grep -i multi-proxy || echo "  （launchctl 无输出或不可用）"

# ---------------------------------------------------------------- 5. reload（可选）
if has_flag --reload-18790 "$ARGS"; then
  note "5. reload 18790（使 PROXY_BUDGET_GUARD / PROXY_MODEL_SYNC 等 plist 门控生效）"
  echo "  ⚠️ 会短断当前 Codex 会话。"
  launchctl unload ~/Library/LaunchAgents/com.multi-proxy.codex-proxy-18790.plist 2>&1
  sleep 1
  launchctl load ~/Library/LaunchAgents/com.multi-proxy.codex-proxy-18790.plist 2>&1
  sleep 3
  curl -s --noproxy '*' --max-time 5 http://127.0.0.1:18790/health | head -c 400
  printf '\n'
else
  note "5. reload 18790 —— 已跳过（需显式 --reload-18790）"
  echo "     plist 门控配了但进程不是 launchd 拉的 ⇒ 不 reload 就永远是死代码。"
fi

# ---------------------------------------------------------------- 6. dsh（可选写）
# 维护者 2026-10-13 要求：「在 multi-proxy 里配好就能用，不能污染 dsh 里原本配的模型」。
# 判定标准只有一个：切 curator 前后 ~/.dsh 的指纹必须一致。
dsh_fp() {
  [ -d "$HOME/.dsh" ] || { echo ""; return; }
  /usr/bin/find "$HOME/.dsh" -type f -exec md5 -q {} + 2>/dev/null | sort | md5 -q
}

note "6. dsh 现状（只读报告）"
if [ -d "$HOME/.dsh" ]; then
  "$ROOT/tools/agent-proxy-switch" dsh 2>&1 | sed 's/^/  /' || true
else
  echo "  （~/.dsh 不存在，跳过）"
fi

if has_flag --fix-dsh "$ARGS"; then
  note "6.1 清理 2026-10-11 takeover 留在 ~/.dsh 的污染"
  echo "  这一步**会**写 ~/.dsh：把真 upstream（https://apihub.agnes-ai.cn/v1）写回去。"
  echo "  真值在我们库里（~/.multi-proxy-manager/takeover-dsh.json），不靠你记得原值。"
  "$ROOT/tools/agent-proxy-switch" dsh off 2>&1 | sed 's/^/  /' || true

  note "6.2 零写入接入：从这里开始 ~/.dsh 必须一个字节不变"
  FP1="$(dsh_fp)"
  "$ROOT/tools/agent-proxy-switch" dsh curator 2>&1 | sed 's/^/  /' || true
  FP2="$(dsh_fp)"
  if [ -n "$FP1" ] && [ "$FP1" = "$FP2" ]; then
    ok "~/.dsh 全程零写入（指纹 $FP1 前后一致）"
  else
    bad "~/.dsh 被改动，零写入被破坏：$FP1 → $FP2"
  fi
  if [ -x "$HOME/.local/bin/dsh-curator" ]; then ok "shim 已装：~/.local/bin/dsh-curator"
  else bad "shim 没装上（dsh-curator 跑不起来）"; fi
  echo "  生效方式：终端跑 \`dsh-curator\`（HOME 隔离）。Dock 双击仍走原生 ~/.dsh，别当成坏了。"
else
  echo "     （清污染 + 实际接入需显式 --fix-dsh；默认只报告，不动 ~/.dsh）"
fi

printf '\n===== 汇总：失败项 %d =====\n' "$FAILS"
[ "$FAILS" -eq 0 ] && echo "全绿。" || echo "有失败项，见上。"
exit 0
