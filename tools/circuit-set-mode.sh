#!/usr/bin/env bash
# multi-proxy — 切换 18790 codex-proxy 的熔断模式（observe ⇄ block）
#
#   observe（默认/现状）：只记账不拦，行为与门控关时完全一致，用来攒数据
#   block              ：provider OPEN 时直接 503 CIRCUIT_OPEN（快速失败）
#
# ⚠️ 默认 dry-run，只打印将要做什么。真改必须显式加 --apply。
#
# 用法：
#   ./tools/circuit-set-mode.sh block            # 预演
#   ./tools/circuit-set-mode.sh block --apply    # 真的切
#   ./tools/circuit-set-mode.sh observe --apply  # 回滚
#
# 失败自动回滚：改完起不来（/health 10s 内不回 mode）就把 plist 还原并重载。
#
# multi-proxy — Copyright © 2026 xiaoxian (Jason)
# Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
set -uo pipefail

MODE="${1:-}"
APPLY=0
for a in "${@:2}"; do [ "$a" = "--apply" ] && APPLY=1; done

PLIST="$HOME/Library/LaunchAgents/com.multi-proxy.codex-proxy-18790.plist"
KEY=":EnvironmentVariables:PROXY_CIRCUIT_MODE"
PORT=18790

die() { echo "✗ $*" >&2; exit 1; }

[ "$MODE" = "observe" ] || [ "$MODE" = "block" ] || die "用法: $0 <observe|block> [--apply]"
[ -f "$PLIST" ] || die "找不到 plist: $PLIST"

CUR="$(/usr/libexec/PlistBuddy -c "Print $KEY" "$PLIST" 2>/dev/null || echo '<未设置>')"

echo "服务     : 18790 codex-proxy（Codex 直连）"
echo "当前模式 : $CUR"
echo "目标模式 : $MODE"
echo "plist    : $PLIST"
echo

if [ "$CUR" = "$MODE" ]; then
  echo "→ 已经是 $MODE，无需改动。"
  exit 0
fi

if [ "$APPLY" -eq 0 ]; then
  echo "[dry-run] 将执行："
  echo "  1) cp $PLIST ${PLIST}.bak-\$(date +%Y%m%d-%H%M%S)"
  echo "  2) PlistBuddy Set $KEY $MODE"
  echo "  3) launchctl unload/load $PLIST   ← 注意：不用 kickstart -k，它会把服务 kill 掉且可能拉不回来"
  echo "  4) 轮询 /health ≤10s，确认 circuit.mode == $MODE"
  echo "  5) 不通过 → 还原 plist 并重载"
  echo
  echo "真要切，加 --apply。切之前建议先看一眼：node tools/circuit-status.js"
  exit 0
fi

BAK="${PLIST}.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PLIST" "$BAK" || die "备份失败"
echo "✓ 已备份 $BAK"

/usr/libexec/PlistBuddy -c "Set $KEY $MODE" "$PLIST" || die "改 plist 失败"
echo "✓ plist 已改为 $MODE"

launchctl unload "$PLIST" >/dev/null 2>&1
launchctl load "$PLIST" >/dev/null 2>&1

OK=0
for i in $(seq 1 20); do
  M="$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("circuit",{}).get("mode",""))
except Exception: print("")' 2>/dev/null)"
  if [ -n "$M" ] && [ "$M" = "$MODE" ]; then OK=1; break; fi
  sleep 0.5
done

if [ "$OK" -eq 1 ]; then
  echo "✓ 已生效：circuit.mode = $MODE（/health 已确认）"
  exit 0
fi

echo "✗ 切换后 /health 未回到 $MODE —— 回滚"
cp "$BAK" "$PLIST"
launchctl unload "$PLIST" >/dev/null 2>&1
launchctl load "$PLIST" >/dev/null 2>&1
sleep 1
curl -s -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null && echo "✓ 已回滚到 $CUR 且服务在线" || echo "⚠️ 回滚后服务仍未起来，手动检查：launchctl list | grep codex-proxy"
exit 1
