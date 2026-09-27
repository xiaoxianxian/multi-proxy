#!/usr/bin/env bash
# =============================================================================
# demo-tour.sh — 3 分钟展示 multi-proxy 核心能力（零副作用）
# =============================================================================
# 用法:
#   bash scripts/demo-tour.sh          # 全量：全部 29 个 L2 demo + 测试基线（约 3 分钟）
#   bash scripts/demo-tour.sh --quick  # 快速：5 个精选 demo + 冲突检测活体（约 30 秒）
#
# 零副作用保证（可放心跑，不会改本机任何东西）:
#   - L2 demo 默认「影子模式」：只记录决策、不改真实路由；历史写 os.tmpdir()，
#     绝不写 ~/.codex / ~/.hermes 等任何 agent 文件（见各 demo 头部「非侵入」注释）
#   - agent-proxy-switch 不带 owner 参数 = 只读「当前所有者 + 端口状态」总览，不改配置
#   - manage.sh status = 只读端口探测；测试套件是纯断言，不碰网络
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MODE="full"
[ "${1:-}" = "--quick" ] && MODE="quick"

# 演示主色（终端不支持也不报错）
if [ -t 1 ]; then BOLD=$'\e[1m'; DIM=$'\e[2m'; OK=$'\e[32m'; BAD=$'\e[31m'; ACC=$'\e[36m'; RST=$'\e[0m'; else BOLD=""; DIM=""; OK=""; BAD=""; ACC=""; RST=""; fi

banner() {
  echo ""
  echo "${BOLD}${ACC}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
  echo "${BOLD}  multi-proxy · 3 分钟演示${RST}${DIM}  ($(date '+%H:%M'))${RST}"
  echo "${BOLD}${ACC}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RST}"
}

# 单个 demo：解说 + 真跑 + 判定（demo 自己会打印 PASS x/x，原样展示）
run_demo() {
  local file="$1" title="$2" note="$3"
  echo ""
  echo "${BOLD}${ACC}▶ ${title}${RST}"
  echo "${DIM}  ${note}${RST}"
  if node "l2/$file"; then
    echo "${OK}  ✓ ${file} 通过${RST}"
  else
    echo "${BAD}  ✗ ${file} 非零退出${RST}"
    return 1
  fi
}

# ---------------- 精选 5 段（quick 用，也是 full 的开场） ----------------
QUICK_STEPS() {
  run_demo "orchestrator.demo.js" \
    "编排引擎：一个任务拆成 4 个子任务，自动路由、并行执行、结果聚合" \
    "拆解→路由→执行→聚合 的完整闭环；flaky 任务会自动重试再降级，全程影子（不碰真实 executor）"

  run_demo "memory-merge.demo.js" \
    "记忆服务：公共层跨 agent 复用，个性层 per-agent 隔离" \
    "多个 agent 共享同一份项目记忆、又各留各的个性层；跑完校验整库 env 零泄漏（非侵入）"

  run_demo "route-engine.demo.js" \
    "影子路由：决策先记录、不动真实流量" \
    "route-engine 判定该把请求发给谁，默认 shadow=true 只打日志、不改实际路由（门控默认关铁律）"

  run_demo "skill-service.demo.js" \
    "技能服务：跨 agent 技能复用 + 热插拔" \
    "registerAdapter 运行时插拔技能，跑完校验 process.env 无泄漏"

  echo ""
  echo "${BOLD}${ACC}▶ 所有权冲突检测（活体）：这台机器此刻各 agent 的 base_url 归谁管${RST}"
  echo "${DIM}  只读状态总览，不改任何配置。这就是本项目和『模型切换器』的分界线${RST}"
  if bash tools/agent-proxy-switch; then
    echo "${OK}  ✓ 冲突检测状态总览（只读）${RST}"
  else
    echo "${DIM}  （本机未配相应 agent，该项跳过，不影响演示）${RST}"
  fi
}

# ---------------- 测试基线（full 用） ----------------
run_tests() {
  echo ""
  echo "${BOLD}${ACC}▶ 测试基线（真跑，非抄文档）${RST}"
  local line

  echo "${DIM}  multi-proxy-manager (jest)${RST}"
  line=$(cd multi-proxy-manager && npx jest --silent --forceExit 2>&1 | grep -E "^Tests:" | tr -d ' ')
  echo "  ${line:-'  (未捕获结果)'}"

  echo "${DIM}  codex-proxy (jest)${RST}"
  line=$(cd codex-proxy && npx jest --silent --forceExit 2>&1 | grep -E "^Tests:" | tr -d ' ')
  echo "  ${line:-'  (未捕获结果)'}"

  echo "${DIM}  cursor-proxy (jest)${RST}"
  line=$(cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --silent --forceExit 2>&1 | grep -E "^Tests:" | tr -d ' ')
  echo "  ${line:-'  (未捕获结果)'}"

  echo "${DIM}  hermes-proxy (pytest)${RST}"
  line=$(cd hermes-proxy && python3 -m pytest tests/ -q 2>&1 | grep -E "passed|failed" | tail -1 | tr -d ' ')
  echo "  ${line:-'  (未捕获结果)'}"

  echo "${DIM}  shell (bats)${RST}"
  if command -v bats >/dev/null 2>&1; then
    line=$(cd tests/shell && bats *.bats 2>&1 | grep -cE "^ok" | tr -d ' ')
    echo "  ${line:-0}/11 通过"
  else
    echo "  (本机无 bats，CI 走 tests/shell/check.sh 零依赖回退)"
  fi
}

# ---------------- 全量 demo（full 用） ----------------
run_all_demos() {
  echo ""
  echo "${BOLD}${ACC}▶ 全部 L2 E2E demo（29 个）${RST}"
  local n=0 fails=0 f out
  while IFS= read -r f; do
    n=$((n+1))
    out=$(node "$f" 2>&1); local ec=$?
    if [ $ec -eq 0 ]; then
      echo "  ${OK}✓${RST} [${n}] $(basename "$f")"
    else
      echo "  ${BAD}✗${RST} [${n}] $(basename "$f")  非零退出"
      echo "$out" | tail -5 | sed 's/^/      /'
      fails=$((fails+1))
    fi
  done < <(find l2 -name '*.demo.js' 2>/dev/null | sort)
  echo "  ${BOLD}${n} 个 demo，${fails} 个失败${RST}"
  [ $fails -eq 0 ]
}

# =============================================================================
banner
if [ "$MODE" = "quick" ]; then
  echo "  模式：${BOLD}quick${RST}（5 精选 demo + 冲突检测活体，约 30 秒）"
  QUICK_STEPS
  echo ""
  echo "${BOLD}全量：${RST} bash scripts/demo-tour.sh   （加测试基线，约 3 分钟）"
else
  echo "  模式：${BOLD}full${RST}（全部 demo + 测试基线，约 3 分钟）"
  QUICK_STEPS
  run_all_demos
  run_tests
  banner
  echo "  完成。非侵入：以上全程未写任何 agent 文件、未改本机配置。"
fi
