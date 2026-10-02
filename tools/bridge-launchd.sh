#!/bin/bash
# 旁挂桥（token-policy-bridge）的 launchd 注册。
#
# 为什么需要它：桥是**长驻进程**（端口 18795，转发给 18790）。手工 `node tools/token-policy-bridge.js`
# 起的那份活不过一个终端会话：nohup + & 起的进程跨 bash 调用即被回收（2026-10-02 实测踩过，
# 症状是「桥明明起过、下一轮请求全 502」）。launchd 才是 macOS 上唯一说得站住的长驻方式。
#
# ⚠️ 这不是「生产环境变更」，但它会启动一个常驻监听 127.0.0.1:18795 的进程：
#   - 只监听 loopback（plist 里 BINDING=127.0.0.1），不对外暴露；
#   - 回滚只需一行 `./bridge-launchd.sh uninstall`，再 `codex` 的 base_url 指回 18790。
#
# 用法（从 tools/ 目录执行，或传绝对路径）：
#   ./bridge-launchd.sh status            # 看有没有在跑、跑的哪份配置
#   ./bridge-launchd.sh install           # 装到 ~/Library/LaunchAgents 并 bootstrap（现役 plist 自动备份）
#   ./bridge-launchd.sh uninstall         # bootout + 删注册（不动 LaunchAgents 里的 plist 文件）
#   ./bridge-launchd.sh restart           # kickstart（桥的所有配置都在 env 里，改完 plist 必须 kick 才生效）
#
# 前置：codex 的 base_url 想走桥就指到 http://127.0.0.1:18795/v1；回滚指回 18790。
# 桥本身不改 codex-proxy/proxy.js 一行代码，回滚只动 base_url。

set -u

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$TOOLS_DIR/.." && pwd)"
SRC_PLIST="$TOOLS_DIR/token-policy-bridge.plist"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/com.multi-proxy.token-policy-bridge.plist"
LABEL="com.multi-proxy.token-policy-bridge"
NODE_BIN="/Users/xiaota/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"
# 🔴 桥的端口从 18794 挪到 18795（18794 是 cursor-proxy 的正式端口，manage.sh:26）。
#    全文件统一用这个变量，别再写死端口。
CURATOR_PORT="${CURATOR_PORT:-18795}"
UPSTREAM="http://127.0.0.1:18790"

status() {
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    echo "已注册：$(launchctl list 2>/dev/null | grep "$LABEL" | awk '{print $1, $2}')"
  else
    echo "未注册（no launchd entry）"
  fi
  local pid=""
  pid="$(lsof -nP -iTCP:18795 -sTCP:LISTEN -t 2>/dev/null || true)"
  # 🔴 用 printf + %s 而不是 echo + "$pid" 插值：这套 shell shim 下 `echo "...$pid..."` 会把
  #    `$pid` 展开错（报 `pid?: unbound variable`），变量明明有值。功能没差别，只是写法换了。
  if [ -n "$pid" ]; then printf '端口 18795 已被占用（pid %s）\n' "$pid"; else printf '端口 18795 空闲\n'; fi
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
  pid="$(lsof -nP -iTCP:18795 -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -n "$pid" ] && { echo "端口仍被 pid $pid 占着，手动确认是不是别的实例"; }
}

# launchd 起不来时的降级：nohup 直起（**只活到当前登录会话**， reboot 就没了）。
# 🔴 2026-10-02 实测：这台机器上 launchctl bootstrap/bootout 对**任何** plist（含全新 Label 的
#    极简 plist）一律 `Input/output error`，是 launchd daemon 层的环境故障，不是配置写错。
#    此时唯一能跑桥的方式就是 nohup —— 代价是跨 bash 调用会被回收，得每次会话重起。
#    ⚠️ curl 打桥必须 `--noproxy '*'`：本机 HTTP_PROXY=127.0.0.1:57112（Clash），
#       不加会打到代理上，看到的是代理返回的「upstream connect failed」而不是桥的真响应。
nohup_fallback() {
  local pid
  pid="$(lsof -nP -iTCP:$CURATOR_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid" ]; then printf '端口 %s 已被 pid %s 占用，认为桥已在跑\n' "$CURATOR_PORT" "$pid"; return 0; fi
  env PORT="$CURATOR_PORT" BINDING=127.0.0.1 UPSTREAM="$UPSTREAM" \
      BRIDGE_MODE=rewrite BRIDGE_CURATOR=1 \
      CURATOR_PRUNE_MODE=suffix CURATOR_MAX_HIDE_RATIO=0.3 \
      CURATOR_TOOL_GUARD=1 CURATOR_TOOL_GUARD_MAX_CHARS=600 CURATOR_TOOL_GUARD_MAX_OUTPUTS=4 \
      CURATOR_RESPONSE_INSIGHT=1 CURATOR_EST_BIAS_BEFORE=1.056 \
      BRIDGE_LOG_DIR="$REPO_DIR/logs" \
      nohup "$NODE_BIN" "$REPO_DIR/tools/token-policy-bridge.js" \
      >>"$REPO_DIR/logs/token-policy-bridge.manual.log" 2>&1 </dev/null &
  sleep 3
  local pid2
  pid2="$(lsof -nP -iTCP:$CURATOR_PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pid2" ]; then printf '降级启动成功：桥 pid %s 正在监听 %s（launchd 不可用，靠 nohup 顶着）\n' "$pid2" "$CURATOR_PORT"
  else printf '降级启动失败，看 %s\n' "$REPO_DIR/logs/token-policy-bridge.manual.log"; fi
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
  status)   status ;;
  install)  install ;;
  uninstall) uninstall ;;
  restart)  restart ;;
  *)        echo "用法: $0 [status|install|uninstall|restart]"; exit 1 ;;
esac
