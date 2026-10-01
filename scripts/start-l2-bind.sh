#!/usr/bin/env bash
# start-l2-bind.sh —— L2 executor 生产接线「真开」启动器（2026-10-01 维护者拍板）
#
# 背景：
#   l2/executor-bind.js 具备真执行能力，但**三重门控默认全关**（0 外发、0 扣费）。
#   本脚本把门控一次性打开并按配置启动 manager —— 这是全项目第一个
#   **会真花钱、真外发数据**的运行形态，所以做成显式脚本而不是随手 export：
#   每次启动都强制看到下面的账单表。
#
# ⚠️ 打开后谁会真花钱（2026-10-01 curl 实测，非推断）：
#   ┌ 绑定 ────────┬ 下游 ─────────────────┬ 成本 ────────────────────┐
#   │ codex       │ codex-proxy :18790   │ 付费：按 model 转发外网  │
#   │ agnes(small)│ codex-proxy :18790   │ 付费：apihub.agnes-ai.com│
#   │ deepseek(me)│ codex-proxy :18790   │ 付费：api.deepseek.com   │
#   │ qwen(large) │ 本地 Ollama :11434   │ 0 成本                   │
#   │ h3web       │ 本地 h3web :8731     │ 0 成本（但需 h3web 在跑）│
#   │ claude      │ Anthropic API        │ 付费：需 ANTHROPIC_API_KEY│
#   └─────────────┴──────────────────────┴──────────────────────────┘
#   另注意：PROXY_TIER_LOCAL_ONLY **只管三档**（agnes/deepseek/qwen），
#   管不到 codex / claude —— 想 0 成本必须连 codex 一起处理，见 LOCAL_ONLY 分支。
#
# 用法：
#   bash scripts/start-l2-bind.sh              # 预检 + 启动 + 自检（默认：全开，含付费外网）
#   bash scripts/start-l2-bind.sh --check      # 只做预检，不启动
#   bash scripts/start-l2-bind.sh --stop       # 停掉本脚本拉起的实例
#   LOCAL_ONLY=1 bash scripts/start-l2-bind.sh # 0 成本演练：三档全指本地 qwen
#
# 回退（成本恒为零，无需改代码）：
#   PROXY_EXECUTOR_BIND 不设 → executor=undefined → 真执行退化为「仅路由」，不触下游
#   PROXY_TIER_BIND 不设     → 三档仍 UnboundAdapterError
#   PROXY_ADAPTER_REAL 不设  → orchestrate 恒 shadow（默认 true）
#   PROXY_L2_MCP=0           → /api/mcp 全体 403
#
# 三重门控缺一即「零外发」，这就是为什么这只 operator-facing 脚本敢做加法。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MGR_DIR="multi-proxy-manager"
LOG="/tmp/multi-proxy-l2-bind.log"
PIDFILE="/tmp/multi-proxy-l2-bind.pid"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PORT="${PORT:-18792}"

# ---------- 门控（用户可 export 覆盖；默认 = 2026-10-01 拍板的「全开」）----------
export PROXY_L2_MCP="${PROXY_L2_MCP:-1}"            # MCP 入口闸门；0 → /api/mcp 403
export PROXY_EXECUTOR_BIND="${PROXY_EXECUTOR_BIND:-1}"  # 绑真实 adapter（核心开关）
export PROXY_ADAPTER_REAL="${PROXY_ADAPTER_REAL:-1}"    # orchestrate 真执行而非 shadow
export PROXY_TIER_BIND="${PROXY_TIER_BIND:-1}"      # 三档 text-tier 接执行落点

# LOCAL_ONLY=1 → 三档全指本地 qwen（0 成本演练）。
# ⚠️ 它**不覆盖 codex/claude**（那两条是 BINDING_DEFS 的固定项），故这里同时把 codex
#    端口指到本地 Ollama，才是真正「一分钱不花」的形态。
if [ "${LOCAL_ONLY:-0}" = "1" ]; then
  export PROXY_TIER_LOCAL_ONLY=1
  export PROXY_CODEX_PORTS="${PROXY_CODEX_PORTS:-11434}"
  echo "[mode] LOCAL_ONLY=1 —— 三档 + codex 全指本地，0 扣费 / 0 外发"
else
  export PROXY_TIER_LOCAL_ONLY="${PROXY_TIER_LOCAL_ONLY:-0}"
  echo "[mode] FULL —— codex/agnes/deepseek/claude 走付费外网，会产生真实账单"
fi

# ---------- 下游端口（全部 env 注入，代码里不写死）----------
export PROXY_CODEX_PORTS="${PROXY_CODEX_PORTS:-18790}"
export PROXY_AGNES_PORTS="${PROXY_AGNES_PORTS:-18790}"
export PROXY_DEEPSEEK_PORTS="${PROXY_DEEPSEEK_PORTS:-18790}"
export PROXY_QWEN_PORTS="${PROXY_QWEN_PORTS:-11434}"
export PROXY_H3WEB_PORTS="${PROXY_H3WEB_PORTS:-8731}"

# 本地 Ollama 档给足超时：超时小于真实生成耗时会制造僵尸请求，
# 而 Ollama 的 runner 是串行的 → 后面所有请求全部排队（见 runbook §4.5.1）。
export PROXY_H3WEB_POLL_MS="${PROXY_H3WEB_POLL_MS:-2000}"
export PROXY_H3WEB_MAX_TRIES="${PROXY_H3WEB_MAX_TRIES:-600}"

port_up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

precheck() {
  echo "== 预检：下游是否在线 =="
  local warn=0
  for spec in "11434:Ollama(qwen本地,免费)" "18790:codex-proxy(付费外网)" "8731:h3web(本地视频)"; do
    local p="${spec%%:*}" label="${spec#*:}"
    if port_up "$p"; then echo "  ✅ :$p $label"; else
      echo "  ⚠️  :$p $label 未监听 —— 路由到它的子任务会硬失败（显式报错，不静默降级）"
      warn=1
    fi
  done
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  ⚠️  ANTHROPIC_API_KEY 未设置 —— claude 绑定无端口候选，命中即显式报错"
    warn=1
  else
    echo "  ✅ ANTHROPIC_API_KEY 已设置（claude 走付费 API）"
  fi
  [ "$warn" = "1" ] && echo "  → 以上缺失不影响启动，只影响命中该 adapter 的子任务能否完成"
  return 0
}

selfcheck() {
  echo "== 自检 =="
  if ! port_up "$PORT"; then echo "  ❌ :$PORT 未监听，manager 没起来"; echo "  → 日志尾："; tail -20 "$LOG"; exit 1; fi
  echo "  ✅ :$PORT 已监听"
  local body
  body="$(curl -s --max-time 10 "http://127.0.0.1:$PORT/api/mcp" || true)"
  if [ -z "$body" ]; then echo "  ❌ GET /api/mcp 无响应"; exit 1; fi
  echo "--- executorBind 可见性（一眼看清接没接上真下游）---"
  echo "$body" | jq '{gate, executorBind: {bound: .executorBind.bound, adapters: [.executorBind.adapters[]? | {adapterId, kind, desc}]}}' 2>/dev/null \
    || echo "$body"
  echo "--- 结论 ---"
  echo "$body" | jq -r 'if .executorBind.bound then "  ✅ executor 已绑定（真执行 = 真触下游，注意账单）" else "  ⚠️ executor 未绑定（仍是「仅路由」零外发形态）" end' 2>/dev/null
}

do_stop() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE")"
    if kill "$pid" 2>/dev/null; then echo "已停止 manager pid=$pid"; else echo "pid=$pid 已不存在"; fi
    rm -f "$PIDFILE"
  else
    echo "无 pidfile（$PIDFILE），未启动或已停止"
  fi
  exit 0
}

case "${1:-}" in
  --stop) do_stop ;;
  --check) precheck ;;
  *)
    precheck
    if port_up "$PORT"; then
      echo "  ⚠️  :$PORT 已有进程在跑：$(lsof -nP -iTCP:$PORT -sTCP:LISTEN | tail -1 | tr -s ' ' | cut -d' ' -f1-2)"
      echo "  → 先 bash $0 --stop，或确认那就是你要的实例。"
    fi
    echo "== 启动 manager（门控全开）=="
    cd "$MGR_DIR"
    nohup "$NODE_BIN" server.js > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    cd "$ROOT"
    echo "  pid=$(cat "$PIDFILE")  log=$LOG"
    echo -n "  等待 :$PORT 就绪"
    local_ok=0
    for _ in $(seq 1 60); do
      if port_up "$PORT"; then local_ok=1; echo " ✅"; break; fi
      echo -n "."; sleep 0.5
    done
    echo
    [ "$local_ok" = "1" ] || { echo "  ❌ 启动超时，日志尾："; tail -30 "$LOG"; exit 1; }
    selfcheck
    echo
    echo "停止：bash $0 --stop    查看日志：tail -f $LOG"
    ;;
esac
