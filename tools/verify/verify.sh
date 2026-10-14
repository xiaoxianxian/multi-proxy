#!/usr/bin/env bash
# multi-proxy 跨平台一键验证脚本（Linux / macOS）
#
# 目的：在没有上游 API Key 的前提下，验证「安装 → 依赖 → 启动 → 端口 → 健康检查」
#       这条链路在真机上是否跑得通，并产出一份可直接回传的报告。
#
# 用法（一键，推荐）：
#   curl -fsSL https://raw.githubusercontent.com/xiaoxianxian/multi-proxy/main/tools/verify/verify.sh | bash
#
# 或先克隆再跑：
#   git clone https://github.com/xiaoxianxian/multi-proxy.git
#   cd multi-proxy && bash tools/verify/verify.sh
#
# 可选环境变量：
#   MP_FULL=1    额外跑全量回归 tools/regression-all.sh（慢，约 30-40 分钟，默认关）
#   MP_KEEP=1    结束后保留服务运行 + 保留开机自启（默认测完即停、即清理）
#   DEEPSEEK_API_KEY=sk-xxx   填了才会做一次真实上游调用（会消耗极少量额度，默认跳过）
#
# 产出报告：~/multi-proxy-verify-report.txt（把这个文件发回即可）

set -u

REPORT="${MP_REPORT:-$HOME/multi-proxy-verify-report.txt}"
WORK="${MP_WORK:-$HOME/multi-proxy-verify}"
REPO="${MP_REPO:-https://github.com/xiaoxianxian/multi-proxy.git}"
FULL="${MP_FULL:-0}"
KEEP="${MP_KEEP:-0}"

: > "$REPORT"

say() { echo "$*" | tee -a "$REPORT"; }
hr()  { say ""; say "============================================================"; }

# 执行一条 shell 命令，把输出尾部与 PASS/FAIL 写进报告；不因失败中断
sh_step() {
  local desc="$1" cmd="$2" out rc
  say ""
  say "### $desc"
  say "\$ $cmd"
  out="$(bash -c "$cmd" 2>&1)"; rc=$?
  say "$(printf '%s' "$out" | tail -40)"
  if [ "$rc" -eq 0 ]; then say "结果: PASS"; else say "结果: FAIL (exit=$rc)"; fi
  return 0
}

hr
say "multi-proxy 真机验证报告"
say "生成时间: $(date '+%Y-%m-%d %H:%M:%S %Z')"
say "报告路径: $REPORT"
hr

# ---------- 1. 环境信息 ----------
say ""
say "## 1. 环境信息"
sh_step "系统版本"        "uname -a"
sh_step "发行版信息"      "cat /etc/os-release 2>/dev/null | head -5 || sw_vers 2>/dev/null || true"
sh_step "架构"            "uname -m"
sh_step "git 版本"        "git --version"
sh_step "node 版本"       "node -v"
sh_step "npm 版本"        "npm -v"
sh_step "python3 版本"    "python3 --version 2>&1 || echo 'python3 未安装'"
sh_step "curl 版本"       "curl --version | head -1"

# Node >= 20 是硬门槛（manager / 各 proxy 依赖 node:test runner 等语法）
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
if [ -n "${NODE_MAJOR:-}" ] && [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
  say ""
  say "Node 版本检查: PASS (v$NODE_MAJOR >= 20)"
else
  say ""
  say "Node 版本检查: FAIL（需要 Node.js >= 20，当前: $(node -v 2>/dev/null || echo '未安装')）"
fi

# ---------- 2. 获取代码 ----------
say ""
say "## 2. 获取代码"
if [ -f "install.sh" ] && [ -f "manage.sh" ]; then
  WORK="$(pwd)"
  say "检测到当前就在 multi-proxy 目录，直接使用: $WORK"
else
  sh_step "克隆仓库到 $WORK" "git clone --depth 1 '$REPO' '$WORK'"
fi

if [ ! -d "$WORK" ]; then
  say ""
  say "代码获取失败，后续步骤无法继续。请把本文件发回，谢谢！"
  hr
  exit 1
fi
cd "$WORK" || exit 1
say ""
say "工作目录: $WORK"
sh_step "当前 HEAD" "git log --oneline -1"

# ---------- 3. 安装 ----------
say ""
say "## 3. 安装（install.sh --all，静默全量）"
sh_step "安装全部组件" "cd '$WORK' && bash install.sh --all"

# ---------- 4. Linux systemd 自启路径（本次重点验证项） ----------
say ""
say "## 4. 开机自启路径（Linux systemd --user）"
if command -v systemctl >/dev/null 2>&1; then
  sh_step "配置 systemd 用户服务" "cd '$WORK' && bash install.sh --autostart"
  sh_step "查询服务是否已启用"    "systemctl --user is-enabled multi-proxy-manager.service 2>&1 || true"
  sh_step "查询服务状态"          "systemctl --user status multi-proxy-manager.service --no-pager 2>&1 | head -15 || true"
else
  say "未检测到 systemctl（非 systemd 系统），跳过自启验证。"
fi

# ---------- 5. 启动服务 ----------
say ""
say "## 5. 启动服务"
sh_step "启动全部服务" "cd '$WORK' && bash manage.sh start all"

# 等服务起来（cursor-proxy 初始化较慢，给足 90s）
say ""
say "等待服务就绪（最多 90s）..."
WAITED=0
while [ "$WAITED" -lt 90 ]; do
  UP=0
  for p in 18790 18792; do
    if curl -s -o /dev/null -m 2 "http://127.0.0.1:$p/health" 2>/dev/null; then UP=$((UP+1)); fi
  done
  [ "$UP" -ge 1 ] && break
  sleep 5; WAITED=$((WAITED+5))
done
say "已等待 ${WAITED}s"

say ""
say "## 5b. 服务状态"
sh_step "manage.sh status" "cd '$WORK' && bash manage.sh status 2>&1 | head -40"

# ---------- 6. 端口与健康检查 ----------
say ""
say "## 6. 端口与健康检查"
for p in 18790 18791 18792 18793 18794 18798 18799; do
  code="$(curl -s -o /tmp/mpv_health -w '%{http_code}' -m 5 "http://127.0.0.1:$p/health" 2>/dev/null || echo '000')"
  body="$(head -c 160 /tmp/mpv_health 2>/dev/null | tr -d '\n')"
  say ""
  say "端口 $p -> HTTP $code"
  say "  响应: ${body:-（无响应体）}"
  if [ "$code" = "200" ]; then say "  结果: PASS"; else say "  结果: 未通过/未启动（若该服务本就不在启动列表内属正常）"; fi
done

# ---------- 7. 可选：真实上游调用 ----------
say ""
say "## 7. 真实上游调用（可选）"
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  sh_step "chat/completions（deepseek，max_tokens 极小）" \
    "curl -s -m 40 http://127.0.0.1:18790/v1/chat/completions -H 'Content-Type: application/json' -d '{\"model\":\"deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":8}' | head -c 500"
else
  say "未设置 DEEPSEEK_API_KEY，跳过真实上游调用（不影响其它验证结论）。"
fi

# ---------- 8. 可选：全量回归 ----------
say ""
say "## 8. 全量回归（可选）"
if [ "$FULL" = "1" ]; then
  sh_step "tools/regression-all.sh" "cd '$WORK' && bash tools/regression-all.sh 2>&1 | tail -60"
else
  say "默认跳过（设置 MP_FULL=1 可开启，约 30-40 分钟）。"
fi

# ---------- 9. 清理 ----------
say ""
say "## 9. 清理"
if [ "$KEEP" = "1" ]; then
  say "MP_KEEP=1，保留服务运行与开机自启，不做清理。"
else
  sh_step "停止全部服务" "cd '$WORK' && bash manage.sh stop all"
  if command -v systemctl >/dev/null 2>&1; then
    sh_step "移除开机自启" "cd '$WORK' && bash install.sh --autostop"
  fi
  say "已停止服务并移除开机自启（仓库代码保留在 $WORK，可自行删除）。"
fi

hr
say "验证结束。"
say "请把本文件发回：$REPORT"
hr
