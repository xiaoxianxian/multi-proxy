#!/bin/bash
set -e

# Multi-Proxy Manager - 一键管理脚本（新版扁平目录结构）
# 用法: ./manage.sh [start|stop|restart|status|logs]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 日志目录
LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"
if [ $? -ne 0 ]; then
  print_error "无法创建日志目录: $LOG_DIR"
  exit 1
fi

# 各代理目录（扁平结构，平级关系）
CODEx_PROXY_DIR="$SCRIPT_DIR/codex-proxy"
HERMES_PROXY_DIR="$SCRIPT_DIR/hermes-proxy"
CURSOR_PROXY_DIR="$SCRIPT_DIR/cursor-proxy"
DSH_PROXY_DIR="$SCRIPT_DIR/dsh-proxy"
CLAUDE_PROXY_DIR="$SCRIPT_DIR/claude-proxy"
OPENCODE_PROXY_DIR="$SCRIPT_DIR/opencode-proxy"
GENERIC_OPENAI_PROXY_DIR="$SCRIPT_DIR/generic-openai-proxy"
MANAGER_DIR="$SCRIPT_DIR/multi-proxy-manager"

# 端口
CODEx_PORT=18790
HERMES_PORT=18793
CURSOR_PORT=18794
DSH_PORT=18797
CLAUDE_PORT=18791
OPENCODE_PORT=18798
GENERIC_PORT=18799
MANAGER_PORT=18792

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 用 printf 不用 echo -e：macOS 自带 bash 3.2 的 echo 在多字节场景下会吃字符，
# 而且 printf 不会把消息里的反斜杠再解释一遍。
print_status() { printf "${GREEN}[✓]${NC} %s\n" "$1"; }
print_error()  { printf "${RED}[✗]${NC} %s\n" "$1"; }
print_warning() { printf "${YELLOW}[!]${NC} %s\n" "$1"; }

# lsof 可执行文件解析（ADR-0001 + 2026-10-13 跨平台修订）：
# launchd 启动的进程 PATH 可能不含 /usr/sbin，裸 lsof 会 ENOENT → isProcessRunning
# 静默误判「未运行」（历史事故，见 docs/03-adr/0001）。跨平台移植后裁决更新为：
# macOS 仍优先绝对路径 /usr/sbin/lsof；Linux 等平台 lsof 在 PATH 中（/usr/bin/lsof），
# 回退 command -v 查找；找不到则 LSOF 为空，端口检测回退 ss / /proc/net/tcp。
if [ -x /usr/sbin/lsof ]; then
  LSOF=/usr/sbin/lsof
elif command -v lsof >/dev/null 2>&1; then
  LSOF=lsof
else
  LSOF=""
fi

# 检查端口是否被占用（跨平台：优先 lsof，回退 ss，再回退 /proc/net/tcp）
is_port_in_use() {
  local port=$1
  if [ -n "$LSOF" ]; then
    "$LSOF" -i :"$port" >/dev/null 2>&1 && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]${port}[[:space:]]" && return 0
  fi
  if [ -f /proc/net/tcp ] 2>/dev/null; then
    local hex
    hex="$(printf '%04X' "$port" 2>/dev/null)"
    [ -n "$hex" ] && grep -i -q ":$hex " /proc/net/tcp 2>/dev/null && return 0
  fi
  return 1
}

# 取占用端口的 PID（跨平台）
pid_on_port() {
  local port=$1
  if [ -n "$LSOF" ]; then
    "$LSOF" -ti :"$port" 2>/dev/null | head -1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep -oE ":$port[[:space:]]" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2
  fi
}

# 等待端口绑定（轮询 lsof，最长 WAIT_FOR_PORT_TIMEOUT 毫秒，默认 10 秒）
WAIT_FOR_PORT_TIMEOUT=${WAIT_FOR_PORT_TIMEOUT:-10000}
wait_for_port() {
  local port=$1
  local waited=0
  local step=200
  while [ $waited -lt $WAIT_FOR_PORT_TIMEOUT ]; do
    if is_port_in_use "$port"; then
      return 0
    fi
    sleep 0.2
    waited=$((waited + step))
  done
  return 1
}

# 启动 Codex Proxy
start_codex() {
  if [ ! -f "$CODEx_PROXY_DIR/proxy.js" ]; then
    print_warning "Codex Proxy 未安装: $CODEx_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$CODEx_PROXY_DIR/node_modules" ]; then
    print_warning "Codex Proxy 依赖未安装，正在安装..."
    (cd "$CODEx_PROXY_DIR" && npm install --production) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "Codex Proxy 依赖安装失败"
      return 1
    fi
    print_status "Codex Proxy 依赖安装完成"
  fi

  if is_port_in_use $CODEx_PORT; then
    print_warning "Codex Proxy 已在运行 (端口 $CODEx_PORT)"
    return 0
  fi

  cd "$CODEx_PROXY_DIR" || exit 1
  print_status "启动 Codex Proxy..."
  nohup node proxy.js > "$LOG_DIR/codex-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $CODEx_PORT; then
    print_status "Codex Proxy 启动成功 (PID: $pid, 端口: $CODEx_PORT)"
    return 0
  else
    print_error "Codex Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs codex"
    return 1
  fi
}

# 启动 DSH Proxy（DSH 桌面端专属 lane，2026-10-13 建）
# 背景：DSH 原先借用 codex lane（18790），与 Codex 混日志/混成本/混模型列表，
# 且 codex lane 会读 ~/.codex/config.toml 当 provider 源（agent 耦合）。
# 本 lane 与 codex-proxy 同引擎（proxy.js 拷贝），端口独立、配置独立（.env PORT=18797）。
start_dsh() {
  if [ ! -f "$DSH_PROXY_DIR/proxy.js" ]; then
    print_warning "DSH Proxy 未安装: $DSH_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$DSH_PROXY_DIR/node_modules" ]; then
    print_warning "DSH Proxy 依赖未安装，正在安装..."
    (cd "$DSH_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "DSH Proxy 依赖安装失败"
      return 1
    fi
    print_status "DSH Proxy 依赖安装完成"
  fi

  if is_port_in_use $DSH_PORT; then
    print_warning "DSH Proxy 已在运行 (端口 $DSH_PORT)"
    return 0
  fi

  cd "$DSH_PROXY_DIR" || exit 1
  print_status "启动 DSH Proxy..."
  nohup node proxy.js > "$LOG_DIR/dsh-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $DSH_PORT; then
    print_status "DSH Proxy 启动成功 (PID: $pid, 端口: $DSH_PORT)"
    return 0
  else
    print_error "DSH Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs dsh"
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
  nohup python3 proxy.py > "$LOG_DIR/hermes-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $HERMES_PORT; then
    print_status "Hermes Proxy 启动成功 (PID: $pid, 端口: $HERMES_PORT)"
    return 0
  else
    print_error "Hermes Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs hermes"
    return 1
  fi
}

# 启动 Cursor Proxy
start_cursor() {
  # Check and compile TypeScript if dist missing
  if [ ! -d "$CURSOR_PROXY_DIR/dist" ]; then
    print_warning "Cursor Proxy 未编译，正在编译..."
    BUILD_LOG="$LOG_DIR/cursor-build.log"
    (cd "$CURSOR_PROXY_DIR" && npm run build 2>&1) > "$BUILD_LOG"
    BUILD_EXIT=$?
    if [ $BUILD_EXIT -ne 0 ]; then
      print_error "Cursor Proxy 编译失败，详情: $BUILD_LOG"
      print_warning "查看日志: cat $BUILD_LOG"
      return 1
    fi
    print_status "Cursor Proxy 编译完成"
  fi

  if [ ! -f "$CURSOR_PROXY_DIR/dist/server/start.js" ]; then
    print_warning "Cursor Proxy 未编译: $CURSOR_PROXY_DIR/dist/server/start.js 不存在"
    print_warning "请先运行: cd cursor-proxy && npm run build"
    return 1
  fi

  # Rebuild native modules (better-sqlite3) to ensure correct platform/arch
  if [ -f "$CURSOR_PROXY_DIR/node_modules/better-sqlite3/package.json" ]; then
    print_status "重建 Cursor Proxy 原生模块..."
    (cd "$CURSOR_PROXY_DIR" && npm rebuild better-sqlite3 2>&1)
    if [ $? -ne 0 ]; then
      print_warning "原生模块重建失败，尝试重新安装..."
      (cd "$CURSOR_PROXY_DIR" && rm -rf node_modules && npm install 2>&1)
      # Rebuild after full reinstall
      (cd "$CURSOR_PROXY_DIR" && npm rebuild better-sqlite3 2>&1)
      if [ $? -ne 0 ]; then
        print_error "Cursor Proxy 原生模块修复失败"
        print_warning "请检查: cd cursor-proxy && npm rebuild better-sqlite3"
        return 1
      fi
      print_status "原生模块重新安装完成"
    else
      print_status "原生模块重建完成"
    fi
  fi

  if is_port_in_use $CURSOR_PORT; then
    print_warning "Cursor Proxy 已在运行 (端口 $CURSOR_PORT)"
    return 0
  fi

  cd "$CURSOR_PROXY_DIR" || exit 1
  print_status "启动 Cursor Proxy..."

  # M6 固化 (2026-09-30): coding 任务路由 override 开关
  # 非侵入铁律 (ADR-0003): 默认 NOT 注入 PROXY_ROUTE_OVERRIDE →
  #   生产 18794 行为逐字节不变 (shadow 稳态), 绝不全局 launchctl setenv。
  #   开 override: CURSOR_ROUTE_OVERRIDE=1 ./manage.sh start cursor
  #     → 子进程 env 注入 PROXY_ROUTE_OVERRIDE=1 (子进程局部, §3 允许)
  #     → coding 任务路由到 deepseek-v4-pro (B 验证 18801 隔离 200)
  #     → 审计落 cursor-proxy/data/override-audit.jsonl
  #   回退: 不设 CURSOR_ROUTE_OVERRIDE 重启即回 shadow 稳态。
  local CURSOR_OVERENV=()
  if [ "${CURSOR_ROUTE_OVERRIDE:-}" = "1" ]; then
    CURSOR_OVERENV=(PROXY_ROUTE_OVERRIDE=1)
    print_warning "M6 override 已开: coding 任务路由到 deepseek-v4-pro (审计: cursor-proxy/data/override-audit.jsonl)"
  fi

  nohup env "${CURSOR_OVERENV[@]}" node dist/server/start.js > "$LOG_DIR/cursor-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $CURSOR_PORT; then
    print_status "Cursor Proxy 启动成功 (PID: $pid, 端口: $CURSOR_PORT)"
    return 0
  else
    print_error "Cursor Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs cursor"
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
  nohup node server.js > "$LOG_DIR/manager.log" 2>&1 &
  local pid=$!

  if wait_for_port $MANAGER_PORT; then
    print_status "Manager Shell 启动成功 (PID: $pid, 端口: $MANAGER_PORT)"
    print_status "访问地址: http://localhost:$MANAGER_PORT"
    return 0
  else
    print_error "Manager Shell 启动失败"
    print_warning "查看日志: ./manage.sh logs manager"
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

  local pid=$(pid_on_port $port)
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
start_claude() {
  if [ ! -f "$CLAUDE_PROXY_DIR/proxy.js" ]; then
    print_warning "Claude Proxy 未安装: $CLAUDE_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$CLAUDE_PROXY_DIR/node_modules" ]; then
    print_warning "Claude Proxy 依赖未安装，正在安装..."
    (cd "$CLAUDE_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "Claude Proxy 依赖安装失败"
      return 1
    fi
    print_status "Claude Proxy 依赖安装完成"
  fi

  if is_port_in_use $CLAUDE_PORT; then
    print_warning "Claude Proxy 已在运行 (端口 $CLAUDE_PORT)"
    return 0
  fi

  cd "$CLAUDE_PROXY_DIR" || exit 1
  print_status "启动 Claude Proxy..."
  nohup node proxy.js > "$LOG_DIR/claude-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $CLAUDE_PORT; then
    print_status "Claude Proxy 启动成功 (PID: $pid, 端口: $CLAUDE_PORT)"
    return 0
  else
    print_error "Claude Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs claude"
    return 1
  fi
}

stop_claude() { stop_service "Claude Proxy" $CLAUDE_PORT; }

start_opencode() {
  if [ ! -f "$OPENCODE_PROXY_DIR/proxy.js" ]; then
    print_warning "OpenCode Proxy 未安装: $OPENCODE_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$OPENCODE_PROXY_DIR/node_modules" ]; then
    print_warning "OpenCode Proxy 依赖未安装，正在安装..."
    (cd "$OPENCODE_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "OpenCode Proxy 依赖安装失败"
      return 1
    fi
    print_status "OpenCode Proxy 依赖安装完成"
  fi

  if is_port_in_use $OPENCODE_PORT; then
    print_warning "OpenCode Proxy 已在运行 (端口 $OPENCODE_PORT)"
    return 0
  fi

  cd "$OPENCODE_PROXY_DIR" || exit 1
  print_status "启动 OpenCode Proxy..."
  nohup node proxy.js > "$LOG_DIR/opencode-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $OPENCODE_PORT; then
    print_status "OpenCode Proxy 启动成功 (PID: $pid, 端口: $OPENCODE_PORT)"
    return 0
  else
    print_error "OpenCode Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs opencode"
    return 1
  fi
}

start_generic_openai() {
  if [ ! -f "$GENERIC_OPENAI_PROXY_DIR/proxy.js" ]; then
    print_warning "Generic OpenAI Proxy 未安装: $GENERIC_OPENAI_PROXY_DIR/proxy.js 不存在"
    return 1
  fi

  # Check and install dependencies if node_modules missing
  if [ ! -d "$GENERIC_OPENAI_PROXY_DIR/node_modules" ]; then
    print_warning "Generic OpenAI Proxy 依赖未安装，正在安装..."
    (cd "$GENERIC_OPENAI_PROXY_DIR" && npm install --production --no-audit --no-fund) 2>/dev/null
    if [ $? -ne 0 ]; then
      print_error "Generic OpenAI Proxy 依赖安装失败"
      return 1
    fi
    print_status "Generic OpenAI Proxy 依赖安装完成"
  fi

  if is_port_in_use $GENERIC_PORT; then
    print_warning "Generic OpenAI Proxy 已在运行 (端口 $GENERIC_PORT)"
    return 0
  fi

  cd "$GENERIC_OPENAI_PROXY_DIR" || exit 1
  print_status "启动 Generic OpenAI Proxy..."
  nohup node proxy.js > "$LOG_DIR/generic-openai-proxy.log" 2>&1 &
  local pid=$!
  sleep 1

  if wait_for_port $GENERIC_PORT; then
    print_status "Generic OpenAI Proxy 启动成功 (PID: $pid, 端口: $GENERIC_PORT)"
    return 0
  else
    print_error "Generic OpenAI Proxy 启动失败"
    print_warning "查看日志: ./manage.sh logs generic"
    return 1
  fi
}

stop_opencode() { stop_service "OpenCode Proxy" $OPENCODE_PORT; }
stop_generic_openai() { stop_service "Generic OpenAI Proxy" $GENERIC_PORT; }

stop_dsh() { stop_service "DSH Proxy" $DSH_PORT; }
stop_manager() { stop_service "Manager Shell" $MANAGER_PORT; }

# 重启服务
restart_codex() { stop_codex; sleep 1; start_codex; }
restart_hermes() { stop_hermes; sleep 1; start_hermes; }
restart_cursor() { stop_cursor; sleep 1; start_cursor; }
restart_dsh() { stop_dsh; sleep 1; start_dsh; }
restart_claude() { stop_claude; sleep 1; start_claude; }
restart_opencode() { stop_opencode; sleep 1; start_opencode; }
restart_generic_openai() { stop_generic_openai; sleep 1; start_generic_openai; }
restart_manager() { stop_manager; sleep 1; start_manager; }

# 查看状态
show_status() {
  echo "=========================================="
  echo "  Multi-Proxy Manager 状态"
  echo "=========================================="
  echo ""

  # Codex Proxy
  if is_port_in_use $CODEx_PORT; then
    local codex_pid=$(pid_on_port $CODEx_PORT)
    echo -e "${GREEN}✓ Codex Proxy${NC} - 运行中 (PID: $codex_pid, 端口: $CODEx_PORT)"
  else
    echo -e "${RED}✗ Codex Proxy${NC} - 未运行"
  fi

  # Hermes Proxy
  if is_port_in_use $HERMES_PORT; then
    local hermes_pid=$(pid_on_port $HERMES_PORT)
    echo -e "${GREEN}✓ Hermes Proxy${NC} - 运行中 (PID: $hermes_pid, 端口: $HERMES_PORT)"
  else
    echo -e "${RED}✗ Hermes Proxy${NC} - 未运行"
  fi

  # Cursor Proxy
  if is_port_in_use $CURSOR_PORT; then
    local cursor_pid=$(pid_on_port $CURSOR_PORT)
    echo -e "${GREEN}✓ Cursor Proxy${NC} - 运行中 (PID: $cursor_pid, 端口: $CURSOR_PORT)"
  else
    echo -e "${RED}✗ Cursor Proxy${NC} - 未运行"
  fi

  # DSH Proxy
  if is_port_in_use $DSH_PORT; then
    local dsh_pid=$(pid_on_port $DSH_PORT)
    echo -e "${GREEN}✓ DSH Proxy${NC} - 运行中 (PID: $dsh_pid, 端口: $DSH_PORT)"
  else
    echo -e "${RED}✗ DSH Proxy${NC} - 未运行"
  fi

  # Claude Proxy
  if is_port_in_use $CLAUDE_PORT; then
    local claude_pid=$(pid_on_port $CLAUDE_PORT)
    echo -e "${GREEN}✓ Claude Proxy${NC} - 运行中 (PID: $claude_pid, 端口: $CLAUDE_PORT)"
  else
    echo -e "${RED}✗ Claude Proxy${NC} - 未运行"
  fi

  # OpenCode Proxy
  if is_port_in_use $OPENCODE_PORT; then
    local opencode_pid=$(pid_on_port $OPENCODE_PORT)
    echo -e "${GREEN}✓ OpenCode Proxy${NC} - 运行中 (PID: $opencode_pid, 端口: $OPENCODE_PORT)"
  else
    echo -e "${RED}✗ OpenCode Proxy${NC} - 未运行"
  fi

  # Generic OpenAI Proxy
  if is_port_in_use $GENERIC_PORT; then
    local generic_pid=$(pid_on_port $GENERIC_PORT)
    echo -e "${GREEN}✓ Generic OpenAI Proxy${NC} - 运行中 (PID: $generic_pid, 端口: $GENERIC_PORT)"
  else
    echo -e "${RED}✗ Generic OpenAI Proxy${NC} - 未运行"
  fi

  # Manager Shell
  if is_port_in_use $MANAGER_PORT; then
    local manager_pid=$(pid_on_port $MANAGER_PORT)
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
      tail -50 "$LOG_DIR/codex-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    hermes)
      echo "=== Hermes Proxy 日志 ==="
      tail -50 "$LOG_DIR/hermes-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    cursor)
      echo "=== Cursor Proxy 日志 ==="
      tail -50 "$LOG_DIR/cursor-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    dsh)
      echo "=== DSH Proxy 日志 ==="
      tail -50 "$LOG_DIR/dsh-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    claude)
      echo "=== Claude Proxy 日志 ==="
      tail -50 "$LOG_DIR/claude-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    opencode)
      echo "=== OpenCode Proxy 日志 ==="
      tail -50 "$LOG_DIR/opencode-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    generic)
      echo "=== Generic OpenAI Proxy 日志 ==="
      tail -50 "$LOG_DIR/generic-openai-proxy.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    manager)
      echo "=== Manager Shell 日志 ==="
      tail -50 "$LOG_DIR/manager.log" 2>/dev/null || echo "日志文件不存在"
      ;;
    all)
      echo "=== Codex Proxy 日志 ==="
      tail -20 "$LOG_DIR/codex-proxy.log" 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Claude Proxy 日志 ==="
      tail -20 "$LOG_DIR/claude-proxy.log" 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== OpenCode Proxy 日志 ==="
      tail -20 "$LOG_DIR/opencode-proxy.log" 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Generic OpenAI Proxy 日志 ==="
      tail -20 "$LOG_DIR/generic-openai-proxy.log" 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Hermes Proxy 日志 ==="
      tail -20 "$LOG_DIR/hermes-proxy.log" 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Cursor Proxy 日志 ==="
      tail -20 "$LOG_DIR/cursor-proxy.log" 2>/dev/null || echo "日志文件不存在"
      echo ""
      echo "=== Manager Shell 日志 ==="
      tail -20 "$LOG_DIR/manager.log" 2>/dev/null || echo "日志文件不存在"
      ;;
  esac
}

# 单服务路由（带目标参数）：$2 ∈ {codex,hermes,cursor,manager,all}，缺省 all。
# 镜像已有日志路由风格（logs 读 $2）。裸 start/stop/restart（无 $2）= all，行为不变。
run_target() {
  local verb=$1       # start | stop | restart
  local target=${2:-all}
  case "$target" in
    codex)
      case $verb in
        start) start_codex ;;
        stop) stop_codex ;;
        restart) restart_codex ;;
       esac ;;
    hermes)
      case $verb in
        start) start_hermes ;;
        stop) stop_hermes ;;
        restart) restart_hermes ;;
       esac ;;
    cursor)
      case $verb in
        start) start_cursor ;;
        stop) stop_cursor ;;
        restart) restart_cursor ;;
       esac ;;
    dsh)
      case $verb in
        start) start_dsh ;;
        stop) stop_dsh ;;
        restart) restart_dsh ;;
       esac ;;
    claude)
      case $verb in
        start) start_claude ;;
        stop) stop_claude ;;
        restart) restart_claude ;;
       esac ;;
    opencode)
      case $verb in
        start) start_opencode ;;
        stop) stop_opencode ;;
        restart) restart_opencode ;;
       esac ;;
    generic)
      case $verb in
        start) start_generic_openai ;;
        stop) stop_generic_openai ;;
        restart) restart_generic_openai ;;
       esac ;;
    manager)
      case $verb in
        start) start_manager ;;
        stop) stop_manager ;;
        restart) restart_manager ;;
       esac ;;
    all|"")
      case $verb in
        start)
          start_codex || true
          start_hermes || true
          start_cursor || true
          start_dsh || true
          start_claude || true
          start_opencode || true
          start_generic_openai || true
          start_manager
          ;;
        stop)
          stop_codex
          stop_hermes
          stop_cursor
          stop_dsh
          stop_claude
          stop_opencode
          stop_generic_openai
          stop_manager
          ;;
        restart)
          restart_codex || true
          restart_hermes || true
          restart_cursor || true
          restart_dsh || true
          restart_claude || true
          restart_opencode || true
          restart_generic_openai || true
          restart_manager
          ;;
       esac ;;
    *)
      print_error "未知目标: $target"
      echo "用法: $0 {start|stop|restart} [codex|claude|hermes|cursor|dsh|opencode|generic|manager|all]"
      return 1 ;;
  esac
}

# 主函数
# Source 保护：被 source（测试/调用 helper）时 BASH_SOURCE[0]≠$0，函数已定义完，直接返回、不跑 main；
# 直接执行（./manage.sh / bash manage.sh）时 BASH_SOURCE 缺失回退 $0，照旧跑 case。
# 这样 bats 等可 source 本脚本调用 is_port_in_use / show_* 等，而 main 只在直接执行时运行。
if [ "${BASH_SOURCE[0]:-$0}" != "$0" ]; then
  return 0 2>/dev/null || exit 0
fi
case "${1:-status}" in
  start)
    print_status "启动服务${2:+ ($2)}..."
    run_target start "$2"
    echo ""
    show_status
     ;;
  stop)
    print_status "停止服务${2:+ ($2)}..."
    run_target stop "$2"
    echo ""
    show_status
     ;;
  restart)
    print_status "重启服务${2:+ ($2)}..."
    run_target restart "$2"
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
    dsh)
      case "${2:-status}" in
        start) start_dsh ;;
        stop) stop_dsh ;;
        restart) restart_dsh ;;
        status)
          if is_port_in_use $DSH_PORT; then
            echo -e "${GREEN}✓ DSH Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ DSH Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs dsh ;;
        *) print_error "未知命令: $2"; echo "用法: $0 dsh [start|stop|restart|status|logs]" ;;
      esac
      ;;
    claude)
      case "${2:-status}" in
        start) start_claude ;;
        stop) stop_claude ;;
        restart) restart_claude ;;
        status)
          if is_port_in_use $CLAUDE_PORT; then
            echo -e "${GREEN}✓ Claude Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ Claude Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs claude ;;
        *) print_error "未知命令: $2"; echo "用法: $0 claude [start|stop|restart|status|logs]" ;;
      esac
      ;;
    opencode)
      case "${2:-status}" in
        start) start_opencode ;;
        stop) stop_opencode ;;
        restart) restart_opencode ;;
        status)
          if is_port_in_use $OPENCODE_PORT; then
            echo -e "${GREEN}✓ OpenCode Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ OpenCode Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs opencode ;;
        *) print_error "未知命令: $2"; echo "用法: $0 opencode [start|stop|restart|status|logs]" ;;
      esac
      ;;
    generic)
      case "${2:-status}" in
        start) start_generic_openai ;;
        stop) stop_generic_openai ;;
        restart) restart_generic_openai ;;
        status)
          if is_port_in_use $GENERIC_PORT; then
            echo -e "${GREEN}✓ Generic OpenAI Proxy${NC} - 运行中"
          else
            echo -e "${RED}✗ Generic OpenAI Proxy${NC} - 未运行"
          fi
          ;;
        logs) show_logs generic ;;
        *) print_error "未知命令: $2"; echo "用法: $0 generic [start|stop|restart|status|logs]" ;;
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
  # 桌面壳：打开 Electron 壳（自包含：复用/启动后端 + 装载 UI + 开壳前占检测）
 gui)
    cd "$MANAGER_DIR" || exit 1
    if [ ! -d "node_modules/electron" ]; then
      print_warning "electron 未安装，正在安装（走 .npmrc mirror）..."
      npm install electron --save-dev --no-audit --no-fund 2>/dev/null
    fi
    print_status "启动桌面壳 Manager Desktop (端口 $MANAGER_PORT)..."
    # exec 替换：壳退出即脚本退出。后端由壳自管（见 main.js ensureBackend）。
    exec npx electron main.js
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
    echo "  $0 dsh [start|stop|restart|status|logs]"
    echo "  $0 manager [start|stop|restart|status|logs]"
    exit 1
    ;;
esac
