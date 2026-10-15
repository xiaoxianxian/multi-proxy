#!/bin/bash
# workbuddy-shim 的 launchd 注册（镜像 tools/bridge-launchd.sh 范式）。
#
# 为什么需要它：shim 是长驻进程（端口 18789，转发给 WorkBuddy 上游）。手工 `node server.js`
# 起的那份活不过一个终端会话：nohup + & 起的进程跨 bash 调用即被回收（2026-10-02 在 bridge 上
# 实测踩过，症状是「shim 明明起过、下一轮请求全 502」）。launchd 才是 macOS 上唯一说得站住的长驻方式。
#
# ⚠️ 这不是「生产环境变更」，但它会启动一个常驻监听 127.0.0.1:18789 的进程：
#   - 只监听 loopback（server.js 默认 BINDING=127.0.0.1），不对外暴露；
#   - 回滚只需一行 `./launchd.sh uninstall`，再把 generic-openai-proxy 里的 WorkBuddy provider 禁用。
#
# 用法（从 workbuddy-shim/ 目录执行，或传绝对路径）：
#   ./launchd.sh status            # 看有没有在跑、端口占用情况、stderr 尾部
#   ./launchd.sh install           # 装到 ~/Library/LaunchAgents 并 bootstrap（现役 plist 自动备份）
#   ./launchd.sh uninstall         # bootout + 删注册（不动 LaunchAgents 里的 plist 文件）
#   ./launchd.sh restart           # kickstart（改了 .env 后必须 kick 才生效，因为 .env 由进程启动读）
#
# 前置：先 `cp .env.example .env` 并填好 WORKBUDDY_ACCESS_TOKEN。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_PLIST="$SCRIPT_DIR/com.multi-proxy.workbuddy-shim.plist"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/com.multi-proxy.workbuddy-shim.plist"
LABEL="com.multi-proxy.workbuddy-shim"
NODE_BIN="/Users/xiaota/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"
SHIM_PORT="${SHIM_PORT:-18789}"
SERVER_JS="$SCRIPT_DIR/server.js"

status() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    echo "已注册：$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1, $2}')"
  else
    echo "未注册（no launchd entry）"
  fi
  local pid=""
  pid="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid" ]; then printf '端口 %s 已被占用（pid %s）\n' "$SHIM_PORT" "$pid"; else printf '端口 %s 空闲\n' "$SHIM_PORT"; fi
  if [ -s "$REPO_DIR/logs/workbuddy-shim.launchd.err.log" ]; then
    echo "stderr tail："; tail -n 5 "$REPO_DIR/logs/workbuddy-shim.launchd.err.log"
  else
    echo "stderr：尚无（launchd 的 StandardErrorPath 指向上面那个文件，没内容 = 没崩）"
  fi
}

install() {
  if [ ! -f "$SRC_PLIST" ]; then echo "找不到源文件 $SRC_PLIST" >&2; exit 1; fi
  plutil -lint "$SRC_PLIST" >/dev/null || { echo "plist 不合法，plutil 报错："; plutil -lint "$SRC_PLIST"; exit 1; }
  mkdir -p "$LAUNCH_DIR"
  [ -f "$PLIST" ] && cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$SRC_PLIST" "$PLIST"
  launchctl bootout gui/"$(id -u)" "$LABEL" 2>/dev/null || true
  launchctl bootstrap gui/"$(id -u)" "$PLIST"
  sleep 1
  status
}

uninstall() {
  launchctl bootout gui/"$(id -u)" "$LABEL" 2>/dev/null || echo "(本来就没注册)"
  echo "已卸载 $LABEL"
  local pid=""
  pid="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pid" ] && { echo "端口仍被 pid $pid 占着，手动确认是不是别的实例"; }
}

# launchd 起不来时的降级：nohup 直起（只活到当前登录会话，reboot 就没了）。
# ⚠️ curl 打 shim 必须 `--noproxy '*'`：本机 HTTP_PROXY=127.0.0.1:57112（Clash），
#   不加会打到代理上，看到的是代理返回的「upstream connect failed」而不是 shim 的真响应。
nohup_fallback() {
  local pid
  pid="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid" ]; then printf '端口 %s 已被 pid %s 占用，认为 shim 已在跑\n' "$SHIM_PORT" "$pid"; return 0; fi
  env WORKBUDDY_SHIM_PORT="$SHIM_PORT" WORKBUDDY_SHIM_BINDING=127.0.0.1 \
      nohup "$NODE_BIN" "$SERVER_JS" \
      >>"$REPO_DIR/logs/workbuddy-shim.manual.log" 2>&1 </dev/null &
  sleep 3
  local pid2
  pid2="$(lsof -nP -iTCP:$SHIM_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid2" ]; then printf '降级启动成功：shim pid %s 正在监听 %s（launchd 不可用，靠 nohup 顶着）\n' "$pid2" "$SHIM_PORT"
  else printf '降级启动失败，看 %s\n' "$REPO_DIR/logs/workbuddy-shim.manual.log"; fi
}

restart() {
  if launchctl kickstart -k gui/"$(id -u)" "$LABEL" 2>/dev/null; then
    sleep 1
    status
  else
    echo "⚠️ launchd 不可用（kickstart 报 Input/output error）⇒ 降级 nohup 常驻。"
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
