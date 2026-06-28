#!/bin/bash
# Multi-Proxy Manager — 一键安装/卸载/重装/启停
# 用法:
#   ./install.sh              # 交互式安装
#   ./install.sh --all        # 静默安装全部
#   ./install.sh --uninstall  # 卸载全部
#   ./install.sh --reinstall  # 卸载后重装
#   ./install.sh --start      # 启动所有服务
#   ./install.sh --stop       # 停止所有服务
#   ./install.sh --status     # 查看状态
#   ./install.sh --autostart  # 启用开机自启
#   ./install.sh --autostop   # 禁用开机自启

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
print_err()   { echo -e "${RED}[✗]${NC} $1"; }
print_info()  { echo -e "${BLUE}[i]${NC} $1"; }
print_warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
print_step()  { echo -e "${CYAN}[→]${NC} $1"; }
print_bold()  { echo -e "${BOLD}$1${NC}"; }

# 端口
CODEx_PORT=18790
HERMES_PORT=18793
CURSOR_PORT=18794
MANAGER_PORT=18792

# 服务名（用于 launchd）
LAUNCHD_NAME="com.multi-proxy-manager"

# ===================== 工具函数 =====================

is_port_in_use() {
  /usr/sbin/lsof -i :$1 >/dev/null 2>&1
  return $?
}

has_node() { command -v node &>/dev/null; }
has_python() { command -v python3 &>/dev/null; }

check_deps() {
  local missing=()
  has_node || missing+=("Node.js")
  has_python || missing+=("Python3")

  if [ ${#missing[@]} -gt 0 ]; then
    print_err "缺少依赖: ${missing[*]}"
    print_info "请先安装: brew install node python"
    return 1
  fi
  return 0
}

# ===================== 安装各组件 =====================

install_codex() {
  print_step "安装 Codex Proxy..."
  local dir="$ROOT_DIR/codex-proxy"

  if [ ! -f "$dir/proxy.js" ]; then
    print_err "Codex Proxy 文件不存在: $dir/proxy.js"
    return 1
  fi

  if has_node; then
    if [ -d "$dir/node_modules" ]; then
      print_ok "Codex Proxy 依赖已安装"
    else
      print_info "安装 Node.js 依赖..."
      (cd "$dir" && npm install --production)
      print_ok "Codex Proxy 依赖安装完成"
    fi
  fi

  if [ ! -f "$dir/.env" ]; then
    cp "$dir/.env.example" "$dir/.env" 2>/dev/null || true
    print_info "已创建 .env 文件，请编辑 $dir/.env 配置 API Key"
  fi
}

install_hermes() {
  print_step "安装 Hermes Proxy..."
  local dir="$ROOT_DIR/hermes-proxy"

  if [ ! -f "$dir/proxy.py" ]; then
    print_err "Hermes Proxy 文件不存在: $dir/proxy.py"
    return 1
  fi

  if has_python && [ -f "$dir/requirements.txt" ]; then
    print_info "安装 Python 依赖..."
    pip3 install -r "$dir/requirements.txt" --quiet 2>/dev/null
    print_ok "Hermes Proxy Python 依赖安装完成"
  fi
}

install_cursor() {
  print_step "安装 Cursor Multi-Model Proxy..."
  local dir="$ROOT_DIR/cursor-multi-model-proxy"

  if [ ! -f "$dir/src/index.ts" ]; then
    print_err "Cursor Proxy 文件不存在: $dir/src/index.ts"
    return 1
  fi

  if has_node; then
    if [ -d "$dir/node_modules" ]; then
      print_ok "Cursor Proxy 依赖已安装"
    else
      print_info "安装 Node.js 依赖..."
      (cd "$dir" && npm install)
      print_ok "Cursor Proxy 依赖安装完成"
    fi

    print_info "编译 TypeScript..."
    BUILD_LOG="/tmp/cursor-build.log"
    (cd "$dir" && npm run build > "$BUILD_LOG" 2>&1)
    BUILD_EXIT=$?
    if [ $BUILD_EXIT -ne 0 ]; then
      print_err "Cursor Proxy 编译失败，详情: $BUILD_LOG"
      print_warn "查看日志: cat $BUILD_LOG"
      return 1
    fi
    print_ok "Cursor Proxy 编译完成"
  fi

  if [ ! -f "$dir/.env" ]; then
    cp "$dir/.env.example" "$dir/.env" 2>/dev/null || true
    print_info "已创建 .env 文件，请编辑 $dir/.env 配置 API Key"
  fi
}

install_manager() {
  print_step "安装 Multi-Proxy Manager..."
  local dir="$ROOT_DIR/multi-proxy-manager"

  if [ ! -f "$dir/server.js" ]; then
    print_err "Multi-Proxy Manager 文件不存在: $dir/server.js"
    return 1
  fi

  if has_node; then
    if [ -d "$dir/node_modules" ]; then
      print_ok "Multi-Proxy Manager 依赖已安装"
    else
      print_info "安装 Node.js 依赖..."
      (cd "$dir" && npm install)
      print_ok "Multi-Proxy Manager 依赖安装完成"
    fi
  fi
}

# ===================== 卸载 =====================

uninstall_codex() {
  print_step "卸载 Codex Proxy..."
  local dir="$ROOT_DIR/codex-proxy"
  [ -f "$dir/.env" ] && rm -f "$dir/.env" && print_ok ".env 已移除"
  print_info "Codex Proxy 文件保留（如需完全删除请手动 rm -rf $dir）"
}

uninstall_hermes() {
  print_step "卸载 Hermes Proxy..."
  local dir="$ROOT_DIR/hermes-proxy"
  print_ok "Hermes Proxy 文件保留（如需完全删除请手动 rm -rf $dir）"
}

uninstall_cursor() {
  print_step "卸载 Cursor Proxy..."
  local dir="$ROOT_DIR/cursor-multi-model-proxy"
  [ -f "$dir/.env" ] && rm -f "$dir/.env" && print_ok ".env 已移除"
  print_info "Cursor Proxy 文件保留（如需完全删除请手动 rm -rf $dir）"
}

uninstall_manager() {
  print_step "卸载 Multi-Proxy Manager..."
  local dir="$ROOT_DIR/multi-proxy-manager"
  print_info "Multi-Proxy Manager 文件保留（如需完全删除请手动 rm -rf $dir）"
}

uninstall_launchd() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    print_ok "开机自启已移除"
  fi
}

# ===================== 启动/停止 =====================

start_codex() {
  if is_port_in_use $CODEx_PORT; then
    print_warn "Codex Proxy 已在运行"
    return 0
  fi
  (cd "$ROOT_DIR/codex-proxy" && node proxy.js > /tmp/codex-proxy.log 2>&1 &)
  sleep 1
  is_port_in_use $CODEx_PORT && print_ok "Codex Proxy 已启动" || print_err "Codex Proxy 启动失败"
}

start_hermes() {
  if is_port_in_use $HERMES_PORT; then
    print_warn "Hermes Proxy 已在运行"
    return 0
  fi
  (cd "$ROOT_DIR/hermes-proxy" && python3 proxy.py > /tmp/hermes-proxy.log 2>&1 &)
  sleep 1
  is_port_in_use $HERMES_PORT && print_ok "Hermes Proxy 已启动" || print_err "Hermes Proxy 启动失败"
}

start_cursor() {
  if is_port_in_use $CURSOR_PORT; then
    print_warn "Cursor Proxy 已在运行"
    return 0
  fi
  if [ ! -f "$ROOT_DIR/cursor-multi-model-proxy/dist/server/start.js" ]; then
    print_err "Cursor Proxy 未编译，请先运行: cd cursor-multi-model-proxy && npm run build"
    return 1
  fi
  (cd "$ROOT_DIR/cursor-multi-model-proxy" && node dist/server/start.js > /tmp/cursor-proxy.log 2>&1 &)
  sleep 1
  is_port_in_use $CURSOR_PORT && print_ok "Cursor Proxy 已启动" || print_err "Cursor Proxy 启动失败"
}

start_manager() {
  if is_port_in_use $MANAGER_PORT; then
    print_warn "Manager Shell 已在运行"
    return 0
  fi
  (cd "$ROOT_DIR/multi-proxy-manager" && node server.js > /tmp/manager.log 2>&1 &)
  sleep 1
  is_port_in_use $MANAGER_PORT && print_ok "Manager Shell 已启动" || print_err "Manager Shell 启动失败"
}

stop_codex()  { /usr/sbin/lsof -ti :$CODEx_PORT | xargs kill -9 2>/dev/null; true; }
stop_hermes() { /usr/sbin/lsof -ti :$HERMES_PORT | xargs kill -9 2>/dev/null; true; }
stop_cursor() { /usr/sbin/lsof -ti :$CURSOR_PORT | xargs kill -9 2>/dev/null; true; }
stop_manager() { /usr/sbin/lsof -ti :$MANAGER_PORT | xargs kill -9 2>/dev/null; true; }

show_status() {
  print_bold "=== Multi-Proxy Manager 状态 ==="
  echo ""

  if is_port_in_use $CODEx_PORT; then
    print_ok "Codex Proxy    - 运行中 (端口 $CODEx_PORT)"
  else
    print_err "Codex Proxy    - 未运行"
  fi

  if is_port_in_use $HERMES_PORT; then
    print_ok "Hermes Proxy   - 运行中 (端口 $HERMES_PORT)"
  else
    print_err "Hermes Proxy   - 未运行"
  fi

  if is_port_in_use $CURSOR_PORT; then
    print_ok "Cursor Proxy   - 运行中 (端口 $CURSOR_PORT)"
  else
    print_err "Cursor Proxy   - 未运行"
  fi

  if is_port_in_use $MANAGER_PORT; then
    print_ok "Manager Shell  - 运行中 (端口 $MANAGER_PORT)"
    print_info "  访问: ${CYAN}http://localhost:$MANAGER_PORT${NC}"
  else
    print_err "Manager Shell  - 未运行"
  fi

  # 检查开机自启
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist"
  if [ -f "$plist" ]; then
    print_ok "开机自启 - 已启用"
  else
    print_info "开机自启 - 未启用 (运行 ./install.sh --autostart 启用)"
  fi
  echo ""
}

# ===================== 开机自启 =====================

setup_autostart() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist"

  print_step "配置开机自启..."

  mkdir -p "$HOME/Library/LaunchAgents"

  # Detect nvm and pyenv for PATH expansion
  local nvm_path=""
  local pyenv_path=""
  if [ -d "$HOME/.nvm" ]; then
    nvm_path="$HOME/.nvm/versions/node/*/bin"
  fi
  if [ -d "$HOME/.pyenv" ]; then
    pyenv_path="$HOME/.pyenv/shims:$HOME/.pyenv/bin"
  fi

  # Build PATH with detected toolchains
  local base_path="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"
  local full_path="$base_path"
  [ -n "$nvm_path" ] && full_path="$full_path:$nvm_path"
  [ -n "$pyenv_path" ] && full_path="$full_path:$pyenv_path"

  cat > "$plist" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LAUNCHD_NAME</string>
    <key>ProgramArguments</key>
    <array>
        <string>bash</string>
        <string>$ROOT_DIR/manage.sh</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/multi-proxy-manager-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/multi-proxy-manager-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$full_path</string>
    </dict>
</dict>
</plist>
PLIST_EOF

  launchctl load "$plist" 2>/dev/null || true
  print_ok "开机自启已配置"
  print_info "登录时自动启动所有服务"
}

remove_autostart() {
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_NAME.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    print_ok "开机自启已禁用"
  else
    print_info "开机自启未启用"
  fi
}

# ===================== 交互安装 =====================

interactive_install() {
  echo ""
  print_bold "============================================"
  print_bold "  Multi-Proxy Manager — 一键安装"
  print_bold "============================================"
  echo ""

  # 检测环境
  if ! check_deps; then
    print_err "请安装 Node.js 和 Python3 后重试"
    print_info "安装命令: brew install node python"
    exit 1
  fi

  # 选择安装组件
  print_info "请选择要安装的组件："
  echo ""
  echo "  ${CYAN}[1]${NC} Codex Proxy"
  echo "  ${CYAN}[2]${NC} Hermes Proxy"
  echo "  ${CYAN}[3]${NC} Cursor Multi-Model Proxy"
  echo "  ${CYAN}[4]${NC} Multi-Proxy Manager（共享管理后台，强制）"
  echo ""
  read -p "请输入选项 (空格分隔, 默认 1 2 3 4): " choice

  choice="${choice:-1 2 3 4}"

  # 强制安装管理后台
  if ! echo "$choice" | grep -q "4"; then
    choice="$choice 4"
  fi

  echo ""
  print_step "开始安装..."
  echo ""

  if echo "$choice" | grep -q "1"; then install_codex; fi
  if echo "$choice" | grep -q "2"; then install_hermes; fi
  if echo "$choice" | grep -q "3"; then install_cursor; fi
  if echo "$choice" | grep -q "4"; then install_manager; fi

  echo ""
  print_bold "============================================"
  print_ok "  安装完成！"
  print_bold "============================================"
  echo ""
  print_info "接下来："
  echo ""
  echo "  1. 编辑各代理的 .env 文件配置 API Key"
  echo "     例如: nano codex-proxy/.env"
  echo ""
  echo "  2. 启动服务（三种方式任选其一）："
  echo "     方式 A: 运行 ./install.sh --start"
  echo "     方式 B: 运行 ./manage.sh start"
  echo "     方式 C: 启用开机自启: ./install.sh --autostart"
  echo ""
  echo "  3. 打开管理后台："
  echo "     ${CYAN}http://localhost:$MANAGER_PORT${NC}"
  echo ""
  echo "  4. 如果需要卸载："
  echo "     ./install.sh --uninstall"
  echo ""
}

# ===================== 主入口 =====================

usage() {
  print_bold "Multi-Proxy Manager — 一键管理工具"
  echo ""
  echo "用法: $0 [命令]"
  echo ""
  echo "命令:"
  echo "  (无参数)          交互式安装向导"
  echo "  --all             静默安装全部组件"
  echo "  --start           启动所有服务"
  echo "  --stop            停止所有服务"
  echo "  --restart         重启所有服务"
  echo "  --status          查看服务状态"
  echo "  --uninstall       卸载（移除依赖和编译产物）"
  echo "  --reinstall       卸载后重新安装"
  echo "  --autostart       启用开机自启"
  echo "  --autostop        禁用开机自启"
  echo "  --help            显示帮助"
  echo ""
  echo "示例:"
  echo "  $0                  # 交互式安装"
  echo "  $0 --all            # 静默安装全部"
  echo "  $0 --start          # 启动所有服务"
  echo "  $0 --autostart      # 开机自启"
  echo "  $0 --status         # 查看状态"
  echo "  $0 --uninstall      # 卸载（仅移除 .env，保留 node_modules）"
  echo ""
  print_info "注意: 安装后请先编辑各代理的 .env 文件配置 API Key"
  echo ""
}

main() {
  case "${1:-}" in
    --all)
      # 静默安装全部组件
      echo ""
      print_bold "============================================"
      print_bold "  Multi-Proxy Manager — 一键安装全部"
      print_bold "============================================"
      echo ""

      if ! check_deps; then
        print_err "请安装 Node.js 和 Python3 后重试"
        print_info "安装命令: brew install node python"
        exit 1
      fi

      install_codex
      install_hermes
      install_cursor
      install_manager

      echo ""
      print_bold "============================================"
      print_ok "  安装完成！"
      print_bold "============================================"
      echo ""
      print_info "接下来："
      echo ""
      echo "  1. 编辑各代理的 .env 文件配置 API Key"
      echo "     例如: nano codex-proxy/.env"
      echo ""
      echo "  2. 启动服务："
      echo "     bash manage.sh start"
      echo ""
      echo "  3. 打开管理面板："
      echo "     http://localhost:$MANAGER_PORT"
      echo ""
      ;;
    --start)
      start_codex; start_hermes; start_cursor; start_manager
      print_ok "所有服务已启动"
      ;;
    --stop)
      stop_codex; stop_hermes; stop_cursor; stop_manager
      print_ok "所有服务已停止"
      ;;
    --restart)
      bash "$0" --stop
      sleep 1
      bash "$0" --start
      ;;
    --status)
      show_status
      ;;
    --uninstall)
      echo ""
      print_bold "============================================"
      print_bold "  卸载 Multi-Proxy Manager"
      print_bold "============================================"
      echo ""

      # 先停止服务
      print_step "停止所有服务..."
      $0 --stop 2>/dev/null || true

      # 卸载各组件
      uninstall_codex
      uninstall_hermes
      uninstall_cursor
      uninstall_manager
      uninstall_launchd

      echo ""
      print_bold "============================================"
      print_ok "  卸载完成！"
      print_bold "============================================"
      echo ""
      print_info "所有代理文件保留在目录中，如需完全删除请手动删除整个项目目录。"
      echo ""
      ;;
    --reinstall)
      print_step "正在卸载..."
      $0 --uninstall
      echo ""
      print_step "正在重新安装..."
      echo ""
      interactive_install
      ;;
    --autostart)
      setup_autostart
      ;;
    --autostop)
      remove_autostart
      ;;
    --help|-h|"")
      usage
      ;;
    *)
      print_err "未知命令: $1"
      echo ""
      usage
      exit 1
      ;;
  esac
}

main "$@"
