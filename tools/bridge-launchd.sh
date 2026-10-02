#!/bin/bash
# 旁挂桥（token-policy-bridge）的 launchd 注册。
#
# 为什么需要它：桥是**长驻进程**（端口 18794，转发给 18790）。手工 `node tools/token-policy-bridge.js`
# 起的那份活不过一个终端会话：nohup + & 起的进程跨 bash 调用即被回收（2026-10-02 实测踩过，
# 症状是「桥明明起过、下一轮请求全 502」）。launchd 才是 macOS 上唯一说得站住的长驻方式。
#
# ⚠️ 这不是「生产环境变更」，但它会启动一个常驻监听 127.0.0.1:18794 的进程：
#   - 只监听 loopback（plist 里 BINDING=127.0.0.1），不对外暴露；
#   - 回滚只需一行 `./bridge-launchd.sh uninstall`，再 `codex` 的 base_url 指回 18790。
#
# 用法（从 tools/ 目录执行，或传绝对路径）：
#   ./bridge-launchd.sh status            # 看有没有在跑、跑的哪份配置
#   ./bridge-launchd.sh install           # 装到 ~/Library/LaunchAgents 并 bootstrap（现役 plist 自动备份）
#   ./bridge-launchd.sh uninstall         # bootout + 删注册（不动 LaunchAgents 里的 plist 文件）
#   ./bridge-launchd.sh restart           # kickstart（桥的所有配置都在 env 里，改完 plist 必须 kick 才生效）
#
# 前置：codex 的 base_url 想走桥就指到 http://127.0.0.1:18794/v1；回滚指回 18790。
# 桥本身不改 codex-proxy/proxy.js 一行代码，回滚只动 base_url。

set -u

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TOOLS_DIR/.." && pwd)"
SRC_PLIST="$TOOLS_DIR/token-policy-bridge.plist"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/com.multi-proxy.token-policy-bridge.plist"
LABEL="com.multi-proxy.token-policy-bridge"
NODE_BIN="/Users/xiaota/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"

status() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    echo "已注册：$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1, $2}')"
  else
    echo "未注册（no launchd entry）"
  fi
  local pid=""
  pid="$(lsof -nP -iTCP:18794 -sTCP:LISTEN -t 2>/dev/null || true)"
  # 🔴 用 printf + %s 而不是 echo + "$pid" 插值：这套 shell shim 下 `echo "...$pid..."` 会把
  #    `$pid` 展开错（报 `pid?: unbound variable`），变量明明有值。功能没差别，只是写法换了。
  if [ -n "$pid" ]; then printf '端口 18794 已被占用（pid %s）\n' "$pid"; else printf '端口 18794 空闲\n'; fi
  echo "codex base_url = $(grep -o 'base_url = "[^"]*"' "$HOME/.codex/config.toml" 2>/dev/null | head -1 || echo '(未设置)')"
  if [ -s "$REPO_DIR/logs/token-policy-bridge.launchd.err.log" ]; then
    echo "stderr tail："; tail -n 5 "$REPO_DIR/logs/token-policy-bridge.launchd.err.log"
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
  launchctl bootout gui/"$(id -u)" "$LABEL" 2>/dev/null || true     # 已注册就先摘掉，bootout 未注册会报错
  launchctl bootstrap gui/"$(id -u)" "$PLIST"
  sleep 1
  status
}

uninstall() {
  launchctl bootout gui/"$(id -u)" "$LABEL" 2>/dev/null || echo "(本来就没注册)"
  echo "已卸载 $LABEL"
  local pid=""
  pid="$(lsof -nP -iTCP:18794 -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pid" ] && { echo "端口仍被 pid $pid 占着，手动确认是不是别的实例"; }
}

restart() {
  launchctl kickstart -k gui/"$(id -u)" "$LABEL" 2>/dev/null || install
  sleep 1
  status
}

case "${1:-status}" in
  status)   status ;;
  install)  install ;;
  uninstall) uninstall ;;
  restart)  restart ;;
  *)        echo "用法: $0 [status|install|uninstall|restart]"; exit 1 ;;
esac
