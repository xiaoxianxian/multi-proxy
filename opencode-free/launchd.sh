#!/bin/bash
# opencode-free 的 launchd 注册（镜像 workbuddy-shim/launchd.sh 范式）。
#
# 为什么需要它：shim 是长驻进程（端口 18800，转发 opencode）。手工 `node server.mjs` 起的那份活不过
# 一个终端会话；launchd 才是 macOS 上唯一说得站住的长驻方式。
#
# ⚠️ 这不是「生产环境变更」，但它会启动一个常驻监听 127.0.0.1:18800 的进程：
#    - 只监听 loopback（server.mjs 固定 127.0.0.1），不对外暴露；
#    - 回滚只需一行 `./launchd.sh uninstall` + 在 hermes/dsh 删掉指向 18800 的 provider。
#
# 用法（从 opencode-free/ 目录执行，或传绝对路径）：
#    ./launchd.sh status             # 看有没有在跑、端口占用、stderr 尾部
#    ./launchd.sh install            # 装到 ~/Library/LaunchAgents 并 bootstrap（现役 plist 自动备份）
#    ./launchd.sh uninstall          # bootout + 删注册
#    ./launchd.sh restart            # kickstart（改了 .env 后必须 kick，因 .env 进程启动读）

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_PLIST="$SCRIPT_DIR/com.multi-proxy.opencode-free.plist"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/com.multi-proxy.opencode-free.plist"
LABEL="com.multi-proxy.opencode-free"
SHIM_PORT="${OPENCODE_FREE_PORT:-18800}"
SERVER_MJS="$SCRIPT_DIR/server.mjs"

# node 真实路径（launchd 的 PATH 很窄，必须绝对）
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="/Users/xiaota/.hermes/node/bin/node"

status() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    echo "已注册：$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1, $2}')"
  else
    echo "未注册（no launchd entry）"
  fi
  local pid
  pid="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid" ]; then printf '端口 %s 已被占用（pid %s）\n' "$SHIM_PORT" "$pid"; else printf '端口 %s 空闲\n' "$SHIM_PORT"; fi
  if [ -s "$REPO_DIR/logs/opencode-free.launchd.err.log" ]; then
    echo "stderr tail："; tail -n 5 "$REPO_DIR/logs/opencode-free.launchd.err.log"
  else
    echo "stderr：尚无"
  fi
}

install() {
  if [ ! -f "$SRC_PLIST" ]; then echo "找不到源文件 $SRC_PLIST" >&2; exit 1; fi
  mkdir -p "$REPO_DIR/logs"
  # 把 node 真实路径写进 plist
  local tmp="$PLIST.in"
  sed "s#/Users/xiaota/.hermes/node/bin/node#$NODE_BIN#g" "$SRC_PLIST" > "$tmp"
  plutil -lint "$tmp" >/dev/null || { echo "plist 不合法，plutil 报错："; plutil -lint "$tmp"; rm -f "$tmp"; exit 1; }
  mkdir -p "$LAUNCH_DIR"
  [ -f "$PLIST" ] && cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$tmp" "$PLIST"; rm -f "$tmp"
  launchctl bootout gui/"$(id -u)"/"$LABEL" 2>/dev/null || launchctl bootout gui/"$(id -u)" "$LABEL" 2>/dev/null || true
  launchctl bootstrap gui/"$(id -u)" "$PLIST"
  sleep 1
  status
}

uninstall() {
  launchctl bootout gui/"$(id -u)"/"$LABEL" 2>/dev/null || launchctl bootout gui/"$(id -u)" "$LABEL" 2>/dev/null || echo "(本来就没注册)"     # macOS12+ 两段式 bootout 失效⇒单参数优先、两段式兜底
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  local pid
  pid="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pid" ] && { echo "端口仍被 pid $pid 占着，确认是不是别的实例"; }
}

# launchd 起不来时降级：nohup 直起（只活到当前登录会话）
nohup_fallback() {
  local pid
  pid="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid" ]; then printf '端口 %s 已被 pid %s 占用，认为已在跑\n' "$SHIM_PORT" "$pid"; return 0; fi
  mkdir -p "$REPO_DIR/logs"
  OPENCODE_FREE_PORT="$SHIM_PORT" \
      nohup "$NODE_BIN" "$SERVER_MJS" \
       >>"$REPO_DIR/logs/opencode-free.manual.log" 2>&1 </dev/null &
  sleep 3
  local pid2
  pid2="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid2" ]; then printf '降级启动成功：pid %s 监听 %s（launchd 不可用，nohup 顶着）\n' "$pid2" "$SHIM_PORT"
  else printf '降级启动失败，看 %s\n' "$REPO_DIR/logs/opencode-free.manual.log"; fi
}

restart() {
  # 新版 launchctl(macOS 12+/本机 27) service-target 须写成 gui/UID/label 单一参数；
  # 旧的两段式 `gui/UID label` 会 rc=64，被误判成 launchd 不可用而降级 nohup(端口被占→空跑)。
  if launchctl kickstart -k gui/"$(id -u)"/"$LABEL" 2>/dev/null; then
    sleep 1; status
  elif launchctl kickstart -k gui/"$(id -u)" "$LABEL" 2>/dev/null; then
    sleep 1; status
  else
    echo "⚠️ launchd 不可用 ⇒ 降级 nohup 常驻。"
    nohup_fallback
  fi
}

case "${1:-status}" in
  status)    status ;;
  install)   install ;;
  uninstall) uninstall ;;
  restart)   restart ;;
  *)         echo "用法: $0 [status|install|uninstall|restart]"; exit 1 ;;
esac
