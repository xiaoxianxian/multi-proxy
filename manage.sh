#!/bin/bash

# Multi-Proxy Manager - 一键管理脚本（新版扁平目录结构）
# 用法: ./manage.sh [start|stop|restart|status|logs]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 各代理目录（扁平结构，平级关系）
CODEx_PROXY_DIR="$SCRIPT_DIR/codex-proxy"
HERMES_PROXY_DIR="$SCRIPT_DIR/hermes-proxy"
CURSOR_PROXY_DIR="$SCRIPT_DIR/cursor-multi-model-proxy"
MANAGER_DIR="$SCRIPT_DIR/multi-proxy-manager"

# 端口
CODEx_PORT=18790
HERMES_PORT=18793
CURSOR_PORT=18794
MANAGER_PORT=18792

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() { echo -e "${GREEN}[✓]${NC} $1"; }
print_error() { echo -e "${RED}[✗]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[!]${NC} $1"; }

# 检查端口是否被占用
is_port_in_use() {
  lsof -i :$1 >/dev/null 2>&1
  return $?
}

# 启动 Codex Proxy
start_codex() {
  if [ ! -f "$CODEx_PROXY_DIR/proxy.js" ]; then
    print_warning "Codex Proxy 未安装: $CODEx_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  if is_port_in_use $CODEx_PORT; then
    print_warning "Codex Proxy 已在运行 (端口 $CODEx_PORT)"
    return 0
  fi

  cd "$CODEx_PROXY_DIR" || exit 1
  print_status "启动 Codex Proxy..."
  node proxy.js > /tmp/codex-proxy.log 2>&1 &
  local pid=$!

  sleep 2
  if is_port_in_use $CODEx_PORT; then
    print_status "Codex Proxy 启动成功 (PID: $pid, 端口: $CODEx_PORT)"
    return 0
  else
    print_error "Codex Proxy 启动失败"
    return 1
  fi
}

# 启动 Hermes Proxy
start_hermes() {
  if [ ! -f "$HERMES_PROXY_DIR/proxy.py" ]; then
    print_warning "Hermes Proxy 未安装: $HERMES_PROXY_DIR/proxy.py 不存在"
    return 1
  fi

  if is_port_in_use $HERMES_PORT; then
    print_warning "Hermes Proxy 已在运行 (端口 $HERMES_PORT)"
    return 0
  fi

  cd "$HERMES_PROXY_DIR" || exit 1
  print_status "启动 Hermes Proxy..."
  python3 proxy.py > /tmp/hermes-proxy.log 2>&1 &
  local pid=$!

  sleep 2
  if is_port_in_use $HERMES_PORT; then
    print_status "Hermes Proxy 启动成功 (PID: $pid, 端口: $HERMES_PORT)"
    return 0
  else
    print_error "Hermes Proxy 启动失败"
    return 1
  fi
}

# 启动 Cursor Proxy
start_cursor() {
  if [ ! -f "$CURSOR_PROXY_DIR/dist/server/start.js" ]; then
    print_warning "Cursor Proxy 未编译: $CURSOR_PROXY_DIR/dist/server/start.js 不存在"
    print_warning "请先运行: cd cursor-multi-model-proxy && npm run build"
    return 1
  fi

  if is_port_in_use $CURSOR_PORT; then
    print_warning "Cursor Proxy 已在运行 (端口 $CURSOR_PORT)"
    return 0
  fi

  cd "$CURSOR_PROXY_DIR" || exit 1
  print_status "启动 Cursor Proxy..."
  node dist/server/start.js > /tmp/cursor-proxy.log 2>&1 &
  local pid=$!

  sleep 2
  if is_port_in_use $CURSOR_PORT; then
    print_status "Cursor Proxy 启动成功 (PID: $pid, 端口: $CURSOR_PORT)"
    return 0
  else
    print_error "Cursor Proxy 启动失败"
    return 1
  fi
}

# 启动 Manager Shell
start_manager() {
  if [ ! -f "$MANAGER_DIR/server.js" ]; then
    print_error "Multi-Proxy Manager 未安装: $MANAGER_DIR/server.js 不存在"
    return 1
  fi

  if is_port_in_use $MANAGER_PORT; then
    print_warning "Manager Shell 已在运行 (端口 $MANAGER_PORT)"
    return 0
  fi

  cd "$MANAGER_DIR" || exit 1
  print_status "启动 Multi-Proxy Manager Shell..."
  node server.js > /tmp/manager.log 2>&1 &
  local pid=$!

  sleep 2
  if is_port_in_use $MANAGER_PORT; then
    print_status "Manager Shell 启动成功 (PID: $pid, 端口: $MANAGER_PORT)"
    print_status "访问地址: http://localhost:$MANAGER_PORT"
    return 0
  else
    print_error "Manager Shell 启动失败"
    return 1
  fi
}

# 停止服务
stop_service() {
  local name=$1
  local port=$2

  if ! is_port_in_use $port; then
    print_warning "$name 未在运行"
    return 0
  fi

  local pid=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pid" ]; then
    print_status "停止 $name (PID: $pid)..."
    kill $pid 2>/dev/null
    sleep 1

    if is_port_in_use $port; then
      print_warning "$name 未能正常停止，尝试强制终止..."
      kill -9 $pid 2>/dev/null
    else
      print_status "$name 已停止"
    fi
  fi
}

stop_codex() { stop_service "Codex Proxy" $CODEx_PORT; }
stop_hermes() { stop_service "Hermes Proxy" $HERMES_PORT; }
stop_cursor() { stop_service "Cursor Proxy" $CURSOR_PORT; }
stop_manager() { stop_service "Manager Shell" $MANAGER_PORT; }

# 重启服务
restart_codex() { stop_codex; sleep 1; start_codex; }
restart_hermes() { stop_hermes; sleep 1; start_hermes; }
restart_cursor() { stop_cursor; sleep 1; start_cursor; }
restart_manager() { stop_manager; sleep 1; start_manager; }

# 查看状态
show_status() {
  echo "=========================================="
  echo "  Multi-Proxy Manager 状态"
  echo "=========================================="
  echo ""

  # Codex Proxy
  if is_port_in_use $CODEx_PORT; then
    local codex_pid=$(lsof -ti :$CODEx_PORT 2>/dev/null)
    echo -e "${GREEN}✓ Codex Proxy${NC} - 运行中 (PID: $codex_pid, 端口: $CODEx_PORT)"
  else
    echo -e "${RED}✗ Codex Proxy${NC} - 未运行"
  fi

  # Hermes Proxy
  if is_port_in_use $HERMES_PORT; then
    local hermes_pid=$(lsof -ti :$HERMES_PORT 2>/dev/null)
    echo -e "${GREEN}✓ Hermes Proxy${NC} - 运行中 (PID: $hermes_pid, 端口: $HERMES_PORT)"
  else
    echo -e "${RED}✗ Hermes Proxy${NC} - 未运行"
  fi

  # Cursor Proxy
  if is_port_in_use $CURSOR_PORT; then
    local cursor_pid=$(lsof -ti :$CURSOR_PORT 2>/dev/null)
    echo -e "${GREEN}✓ Cursor Proxy${NC} - 运行中 (PID: $cursor_pid, 端口: $CURSOR_PORT)"
  else
    echo -e "${RED}✗ Cursor Proxy${NC} - 未运行"
  fi

  # Manager Shell
  if is_port_in_use $MANAGER_PORT; then
    local manager_pid=$(lsof -ti :$MANAGER_PORT 2>/dev/null)
    echo -e "${GREEN}✓ Manager Shell${NC} - 运行中 (PID: $manager_pid, 端口: $MANAGER_PORT)"
    echo -e "  访问地址: ${YELLOW}http://localhost:$MANAGER_PORT${NC}"
  else
    echo -e "${RED}✗ Manager Shell${NC} - 未运行"
  fi

  echo ""
  echo "=========================================="
}

# 查看日志
show_logs() {
  local service=$1

  case $service in
    codex)
      echo "=== Codex Proxy 日志 ==="
      tail -50 /tmp/codex-proxy.log 2>/dev/null || echo "日志文件不存在"
      ;;
    hermes)
      echo "=== Hermes Proxy 日志 ==="
      tail -50 /tmp/hermes-proxy.log 2>/dev/null || echo "日志文件不存在"
      ;;
    cursor)
      echo "=== Cursor Proxy 日志 ==="
      tail -50 /tmp/cursor-proxy.log 2>/dev/null || echo "日志文件不存在"
      ;;
    manager)
      echo "=== Manager Shell 日志 ==="
      tail -50 /tmp/manager.log 2>/dev/null || echo "日志文件不存在"
      ;;
    all)
      echo "=== Codex Proxy 日志 ==="
      tail -20 /tmp/codex-proxy.log 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Hermes Proxy 日志 ==="
      tail -20 /tmp/hermes-proxy.log 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Cursor Proxy 日志 ==="
      tail -20 /tmp/cursor-proxy.log 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Manager Shell 日志 ==="
      tail -20 /tmp/manager.log 2>/dev/null || echo "日志文件不存在"
      ;;
  esac
}

# 主函数
case "${1:-status}" in
  start)
    print_status "启动所有服务..."
    start_codex || true
    start_hermes || true
    start_cursor || true
    start_manager
    echo ""
    show_status
    ;;
  stop)
    print_status "停止所有服务..."
    stop_codex
    stop_hermes
    stop_cursor
    stop_manager
    echo ""
    show_status
    ;;
  restart)
    print_status "重启所有服务..."
    restart_codex || true
    restart_hermes || true
    restart_cursor || true
    restart_manager
    echo ""
    show_status
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs "${2:-all}"
    ;;
  codex)
    case "${2:-status}" in
      start) start_codex ;;
      stop) stop_codex ;;
      restart) restart_codex ;;
      status)
        if is_port_in_use $CODEx_PORT; then
          echo -e "${GREEN}✓ Codex Proxy${NC} - 运行中"
        else
          echo -e "${RED}✗ Codex Proxy${NC} - 未运行"
        fi
        ;;
      logs) show_logs codex ;;
      *) print_error "未知命令: $2"; echo "用法: $0 codex [start|stop|restart|status|logs]" ;;
    esac
    ;;
  hermes)
    case "${2:-status}" in
      start) start_hermes ;;
      stop) stop_hermes ;;
      restart) restart_hermes ;;
      status)
        if is_port_in_use $HERMES_PORT; then
          echo -e "${GREEN}✓ Hermes Proxy${NC} - 运行中"
        else
          echo -e "${RED}✗ Hermes Proxy${NC} - 未运行"
        fi
        ;;
      logs) show_logs hermes ;;
      *) print_error "未知命令: $2"; echo "用法: $0 hermes [start|stop|restart|status|logs]" ;;
    esac
    ;;
  cursor)
    case "${2:-status}" in
      start) start_cursor ;;
      stop) stop_cursor ;;
      restart) restart_cursor ;;
      status)
        if is_port_in_use $CURSOR_PORT; then
          echo -e "${GREEN}✓ Cursor Proxy${NC} - 运行中"
        else
          echo -e "${RED}✗ Cursor Proxy${NC} - 未运行"
        fi
        ;;
      logs) show_logs cursor ;;
      *) print_error "未知命令: $2"; echo "用法: $0 cursor [start|stop|restart|status|logs]" ;;
    esac
    ;;
  manager)
    case "${2:-status}" in
      start) start_manager ;;
      stop) stop_manager ;;
      restart) restart_manager ;;
      status)
        if is_port_in_use $MANAGER_PORT; then
          echo -e "${GREEN}✓ Manager Shell${NC} - 运行中"
        else
          echo -e "${RED}✗ Manager Shell${NC} - 未运行"
        fi
        ;;
      logs) show_logs manager ;;
      *) print_error "未知命令: $2"; echo "用法: $0 manager [start|stop|restart|status|logs]" ;;
    esac
    ;;
  *)
    echo "Multi-Proxy Manager 管理脚本"
    echo ""
    echo "用法: $0 [command]"
    echo ""
    echo "命令:"
    echo "  start       启动所有服务"
    echo "  stop        停止所有服务"
    echo "  restart     重启所有服务"
    echo "  status      查看服务状态"
    echo "  logs [all|codex|hermes|cursor|manager]  查看日志"
    echo ""
    echo "单个服务管理:"
    echo "  $0 codex [start|stop|restart|status|logs]"
    echo "  $0 hermes [start|stop|restart|status|logs]"
    echo "  $0 cursor [start|stop|restart|status|logs]"
    echo "  $0 manager [start|stop|restart|status|logs]"
    ;;
esac
