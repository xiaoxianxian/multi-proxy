#!/usr/bin/env bash
#
# bridge-lifecycle —— 旁挂桥（token-policy-bridge）的**按需加载**生命周期
# =====================================================================
# 维护者定调（2026-10-02）：「尽量不要加常驻，很占内存的。我本地还部署的有模型，
#  运行的时候对内存很敏感。所以对于不是随时需要用的服务，用的时候加载就够了，
#  不要常驻。」
#
# ⇒ 本脚本就是这条定调的落码：桥**不注册 launchd**（本脚本从不碰
#   ~/Library/LaunchAgents），只在需要的时候拉起来，用完就撤。
#
#   on    起桥（已在跑就复用），等到 /health 真的返回，打印模式与内存占用
#   off   撤桥（优雅 SIGTERM → 等退 → SIGKILL）
#   status 看 pid / 端口 / 模式（从 /health 反推）/ RSS
#
# 用法：
#   ./tools/bridge-lifecycle.sh on
#   ./tools/bridge-lifecycle.sh off
#   ./tools/bridge-lifecycle.sh status
#
#   🔴 必须在**真 Terminal** 里跑：WorkBuddy/CodeBuddy 的 Bash 沙箱每次调用都是
#     独立进程组，nohup 起的桥跨调用必被回收（2026-10-02 实测 setsid 也不行，
#     且 macOS 没有 setsid）。在真 Terminal 里 nohup+disown 能活过会话。
#
# 环境变量（都能覆盖）：
#   CURATOR_PORT    桥端口，默认 18795（18794 是 cursor 的既定端口，别抢）
#   UPSTREAM        上游，默认 http://127.0.0.1:18790
#   BRIDGE_HEAP_MB  node 旧空间上限（默认 256），维护者内存敏感，别放大
#   NODE_BIN        node 路径

set -uo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TOOLS_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-/Users/xiaota/.workbuddy/binaries/node/versions/22.22.2-3/bin/node}"
PORT="${CURATOR_PORT:-18795}"
UPSTREAM="${UPSTREAM:-http://127.0.0.1:18790}"
HEAP_MB="${BRIDGE_HEAP_MB:-256}"
LOG="$REPO_DIR/logs/token-policy-bridge.manual.log"
PIDFILE="$REPO_DIR/logs/bridge.pid"

# 🔴 curl 打桥必须 --noproxy '*'：本机 HTTP_PROXY 指向 Clash，不加会打到代理上，
#   看到的是「upstream connect failed」而不是桥的真响应，会被误读成「桥挂了」。
CURL() { curl -s --noproxy '*' --max-time 5 "$@"; }

port_pid() {
  /usr/sbin/lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# 桥起来没？看 /health（比 lsof 强：能顺带读出 mode，确认不是 observe 白起了）
health() {
  CURL "http://127.0.0.1:$PORT/health" 2>/dev/null || true
}

rss_mb() {
  local pid="$1"
  [ -n "$pid" ] || { printf 'n/a'; return; }
  # 🔴 沙箱里 ps aux 会报 operation not permitted，用 vmmap 之外的路子：ps -o rss
  local kb
  kb="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
  [ -n "$kb" ] && awk -v k="$kb" 'BEGIN{printf "%.0f", k/1024}' || printf 'n/a'
}

do_on() {
  local pid
  pid="$(port_pid)"
  if [ -n "$pid" ]; then
    printf '桥已在跑：pid %s / 内存 %s MB\n' "$pid" "$(rss_mb "$pid")"
    print_health
    return 0
  fi

  mkdir -p "$REPO_DIR/logs"
  # 🔴 env 必须带全：BRIDGE_MODE=rewrite 是**省钱的前提**（observe 只转发不改写，
  #    切了 curator 照样一分不省）；CURATOR_* 那几个是 curator pack 的档位参数。
  env PORT="$PORT" BINDING=127.0.0.1 UPSTREAM="$UPSTREAM" \
      BRIDGE_MODE=rewrite BRIDGE_CURATOR=1 \
      NODE_OPTIONS="--max-old-space-size=$HEAP_MB" \
      CURATOR_PRUNE_MODE=suffix CURATOR_MAX_HIDE_RATIO=0.3 \
      CURATOR_TOOL_GUARD=1 CURATOR_TOOL_GUARD_MAX_CHARS=600 CURATOR_TOOL_GUARD_MAX_OUTPUTS=4 \
      CURATOR_RESPONSE_INSIGHT=1 CURATOR_EST_BIAS_BEFORE=1.056 \
      BRIDGE_LOG_DIR="$REPO_DIR/logs" \
      nohup "$NODE_BIN" "$REPO_DIR/tools/token-policy-bridge.js" \
      >>"$LOG" 2>&1 </dev/null &
  local bgpid=$!
  disown "$bgpid" 2>/dev/null || true
  echo "$bgpid" > "$PIDFILE" 2>/dev/null || true

  # 等 /health 真的回（最多 ~10s），别 sleep 完就当起来了
  local i=0
  while [ $i -lt 20 ]; do
    if [ -n "$(health)" ]; then break; fi
    sleep 0.5
    i=$((i + 1))
  done

  pid="$(port_pid)"
  if [ -z "$pid" ]; then
    printf '❌ 起桥失败（%ss 内 %s 没监听），日志：%s\n' "$((i / 2))" "$PORT" "$LOG"
    tail -n 5 "$LOG" 2>/dev/null
    rm -f "$PIDFILE"
    return 1
  fi
  printf '✅ 桥已起：pid %s / 内存 %s MB（堆上限 %s MB）\n' "$pid" "$(rss_mb "$pid")" "$HEAP_MB"
  print_health
}

print_health() {
  local h
  h="$(health)"
  [ -n "$h" ] || { printf '  /health 没回（进程在但没起来？）\n'; return 0; }
  printf '  模式 %s\n' "$h" | /usr/bin/head -c 400
  echo
  # 🔴 observe 模式下切 curator 是不省钱的（只转发不改写），必须显式报出来
  if printf '%s' "$h" | grep -q '"mode":"observe"'; then
    printf '  ⚠️ 桥是 observe 模式（不改写）⇒ 切了 curator 也一分不省。修：删掉旧的桥进程重起。\n'
  fi
}

do_off() {
  local pid
  pid="$(port_pid)"
  if [ -z "$pid" ]; then
    printf '桥没在跑（%s 空闲），无需撤\n' "$PORT"
    rm -f "$PIDFILE"
    return 0
  fi
  printf '撤桥：pid %s ... ' "$pid"
  kill -TERM "$pid" 2>/dev/null
  local i=0
  while [ $i -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.3; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null
    printf 'SIGKILL（%ss 内没自己退）\n' "$(awk -v i="$i" 'BEGIN{printf "%.1f", i*0.3}')"
  else
    printf '已退出（%.1fs）\n' "$(awk -v i="$i" 'BEGIN{printf "%.1f", i*0.3}')"
  fi
  rm -f "$PIDFILE"
  local still
  still="$(port_pid)"
  [ -n "$still" ] && printf '⚠️ %s 仍被 pid %s 占着（不是我们起的，别乱杀）\n' "$PORT" "$still" || printf '端口 %s 已释放 ✓\n' "$PORT"
}

do_status() {
  local pid
  pid="$(port_pid)"
  printf '桥：%s\n' "$([ -n "$pid" ] && printf '在跑 pid %s（内存 %s MB）' "$pid" "$(rss_mb "$pid")" || printf '未运行（按需加载，用的时候 ./bridge-lifecycle.sh on）')"
  printf '端口 %s        : %s\n' "$PORT" "$([ -n "$pid" ] && printf 'LISTEN' || printf '空闲')"
  printf 'launchd 常驻   : %s\n' "$(launchctl list 2>/dev/null | grep -q com.multi-proxy.token-policy-bridge && printf '有（与「按需加载」定调冲突）' || printf '无（符合维护者定调：不用就不占内存）')"
  printf 'pid 文件       : %s\n' "$PIDFILE"
  [ -n "$pid" ] && print_health
}

case "${1:-status}" in
  on)      do_on ;;
  off)     do_off ;;
  status)  do_status ;;
  *)       echo "用法: $0 [on|off|status]"; exit 1 ;;
esac
