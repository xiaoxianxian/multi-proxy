#!/usr/bin/env bash
# multi-proxy — 一键全量回归（2026-10-13）
#
# 背景：multi-proxy 与 Ollama 双模型(~38GB) + H3 同机跑时，内存争抢会让
# manager 的 Express 冷启动 / 真 HTTP 回环首请求偶发 >5s，触发 jest 默认
# 超时假红（已把 jest.config.js 默认超时提到 30s 吸收常规方差，但极端负载
# 仍建议跑前暂停 Ollama/H3）。本脚本默认先暂停 Ollama，跑完提示恢复。
#
# 用法：
#   bash tools/regression-all.sh            # 默认：先暂停 Ollama 再跑
#   bash tools/regression-all.sh --no-stop-ollama   # 不暂停 Ollama（你已手动停/机器空闲）
#
# 退出码：0 = 全部模块 0 失败；1 = 有模块出现失败（含环境超时，请结合上面背景判断）。

set -u

NO_STOP=0
for a in "$@"; do
  [ "$a" = "--no-stop-ollama" ] && NO_STOP=1
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

OLLAMA_STOPPED=0
if [ "$NO_STOP" -eq 0 ]; then
  if pgrep -x ollama >/dev/null 2>&1; then
    echo ">>> 暂停 Ollama 以避免内存争抢（manager 回归常因此 5s 超时假红）..."
    if ollama stop >/dev/null 2>&1; then
      OLLAMA_STOPPED=1
      echo "    Ollama 已停止（跑完用 'ollama serve' 或下次 'ollama run' 自动恢复）"
    else
      echo "    警告：ollama stop 失败，继续（可能仍会偶发超时）"
    fi
  else
    echo ">>> Ollama 未在运行，跳过暂停"
  fi
fi

# 收集每个模块的结果摘要
SUMMARY=()

run_suite() {            # $1=显示名  $2=工作目录  $3..=命令
  local name="$1"; local wd="$2"; shift 2
  echo ""
  echo "=================== $name ==================="
  local out rc
  out="$( ( cd "$wd" && "$@" ) 2>&1 )"; rc=$?
  # 只打印末尾概要，避免刷屏
  printf '%s\n' "$out" | tail -6
  local t
  t="$(printf '%s\n' "$out" | grep -E '^(Tests|Test Suites):' | tr '\n' ' ')"
  SUMMARY+=("$(printf '%-22s %s [rc=%s]' "$name" "${t:-无摘要}" "$rc")")
  return $rc
}

rc_total=0

# 1) manager（1458 测试，默认 30s 超时）
run_suite "multi-proxy-manager" multi-proxy-manager npx jest --forceExit
[ $? -ne 0 ] && rc_total=1

# 2) codex（159 测试）
run_suite "codex-proxy" codex-proxy npx jest --forceExit
[ $? -ne 0 ] && rc_total=1

# 3) cursor（250 测试，需 ESM flag）
run_suite "cursor-proxy" cursor-proxy env NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit
[ $? -ne 0 ] && rc_total=1

# 4) hermes（77 pytest，必须 --basetemp 避沙箱 tmp EEXIST）
run_suite "hermes-proxy" hermes-proxy /usr/bin/python3 -m pytest tests/ -q --basetemp=/tmp/pytest-hermes-$(date +%s)
[ $? -ne 0 ] && rc_total=1

# 5) l2 demo
echo ""
echo "=================== l2 编排 ==================="
l2out="$( ( cd l2 && find . -name '*.demo.js' -print0 | xargs -0 -n1 node ) 2>&1 )"; l2rc=$?
printf '%s\n' "$l2out" | tail -4
SUMMARY+=("$(printf '%-22s %s [rc=%s]' "l2 编排" "$(printf '%s' "$l2out" | grep -cE 'PASS') 个 demo PASS" "$l2rc")")
[ $l2rc -ne 0 ] && rc_total=1

# 6) shell 行为
echo ""
echo "=================== tests/shell ==================="
if command -v bats >/dev/null 2>&1; then
  shout="$( ( cd tests/shell && bats *.bats ) 2>&1 )"; shrc=$?
else
  shout="$( ( cd tests/shell && bash check.sh ) 2>&1 )"; shrc=$?
fi
printf '%s\n' "$shout" | tail -4
SUMMARY+=("$(printf '%-22s %s [rc=%s]' "tests/shell" "$(printf '%s' "$shout" | grep -cE '^ok ') ok" "$shrc")")
[ $shrc -ne 0 ] && rc_total=1

# ---- 汇总 ----
echo ""
echo "########################################################"
echo "# 全量回归汇总"
echo "########################################################"
for s in "${SUMMARY[@]}"; do echo "  $s"; done
echo "########################################################"

if [ "$OLLAMA_STOPPED" -eq 1 ]; then
  echo ""
  echo "提示：Ollama 已被本脚本暂停。恢复方式：'ollama serve' & 或下次 'ollama run <model>' 会自动拉起。"
fi

if [ "$rc_total" -eq 0 ]; then
  echo "结论：全部模块 0 失败 ✅"
else
  echo "结论：存在失败用例 ⚠️  若为 manager 的 'Exceeded timeout'，属 Ollama/H3 内存争抢环境超时（非产品 bug），"
  echo "      请确认已暂停 Ollama 后重跑该模块，或临时调大 jest.config.js 的 testTimeout。"
fi

exit $rc_total
