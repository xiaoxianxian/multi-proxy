#!/usr/bin/env bash
# check-opencode-free-fallback.sh
# 显式告警：检测 hermes 是否把 opencode-free 模型静默回退到别的 provider。
# 背景：opencode 免费层被 IP gate 时，:18800 仍 healthz 正常、/v1/models 正常，
#       但 hermes 每次调用 403 → 静默 `Fallback activated: <x-free> → agnes-3.0-flash`，
#       表象像"免费在跑"，实际一条 opencode 模型都没用过。
#
# 设计原则（对应 4.4 带病运行 + 别再探已知被标 IP）：
#   默认 log 模式：只读 hermes 自己的日志，零额外 IP 探测（不会再触发滥用检测）。
#   --probe：可选，发一次 1-token opencode chat 探当前 gate 状态（会碰被标 IP，慎用）。
#
# 用法：
#   ./check-opencode-free-fallback.sh            # log 模式（默认，安全）
#   ./check-opencode-free-fallback.sh --minutes 60   # 只看最近 N 分钟
#   ./check-opencode-free-fallback.sh --probe    # 额外发一次 1-token 探测当前 gate
set -euo pipefail

LOGS_DIR="${HERMES_LOGS:-$HOME/.hermes/logs}"
AGENT_LOG="$LOGS_DIR/agent.log"
GATEWAY_LOG="$LOGS_DIR/gateway.log"
PLUGIN_BASE="http://127.0.0.1:18800/v1"
MINUTES="${MINUTES:-}"
DO_PROBE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) DO_PROBE=1; shift ;;
    --minutes) MINUTES="${2:-}"; if [ $# -ge 2 ]; then shift 2; else shift; fi ;;
    --minutes=*) MINUTES="${1#*=}"; shift ;;
    *) echo "unknown arg: $1" >&2; shift ;;
  esac
done

echo "== hermes 日志：${LOGS_DIR} =="
[ -f "$AGENT_LOG" ] || { echo "!! 找不到 $AGENT_LOG"; exit 2; }

# opencode-free 模型 id 一律以 -free 结尾；回退目标(agnes-3.0-flash)不带 -free。
# 命中 "Fallback activated: <...-free> → ..." 即 opencode-free 被静默回退。
FW='Fallback activated: [^ →]+-free '
last=$(grep -aE "$FW" "$AGENT_LOG" 2>/dev/null | tail -1 || true)
count_all=$(grep -acE "$FW" "$AGENT_LOG" 2>/dev/null || true)

if [ -n "${MINUTES}" ]; then
  since=$(date -v "-${MINUTES}M" +%Y-%m-%d\ %H:%M 2>/dev/null || date -d "-${MINUTES} min" +%Y-%m-%d\ %H:%M)
  # 同一天内可按字符串比较时间戳；跨 0 点窗口请用 --minutes 且留意。
  window=$(awk -v s="$since" 'match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+/){ts=substr($0,RSTART,RLENGTH); if(ts>=s){f=1}} f' "$AGENT_LOG" 2>/dev/null | grep -acE "$FW" || true)
  echo "-- 最近 ${MINUTES}min 内 opencode-free 回退事件：${window} 次"
else
  echo "-- 全日志 opencode-free 回退事件累计：${count_all} 次"
fi

if [ -n "${last}" ]; then
  echo "-- 最近一次（原始行，含时间戳/会话/model→fallback）："
  echo "   ${last}"
  echo "   ⚠️ SILENT-FALLBACK：opencode-free 模型正在被静默回退，你以为在跑免费 opencode，实际跑的是右边那个 provider。"
else
  echo "-- 日志中未发现 opencode-free 回退事件（或日志被轮转清空）。"
fi

if [ "$DO_PROBE" = "1" ]; then
  echo
  echo "== --probe：发一次 1-token opencode-free chat（会碰当前被标 IP，慎用）=="
  resp=$(curl -sS -m 30 "$PLUGIN_BASE/chat/completions" \
      -H 'Content-Type: application/json' \
      -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"temperature":0.0001}' 2>&1 || true)
  echo "   ${resp}"
  echo "   （出现 FreeTierError/abusive traffic = 仍被 gate；正常返回 content = 已恢复）"
fi
