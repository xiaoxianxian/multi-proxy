#!/bin/bash
# R2 回归测试：install.sh --uninstall 的孤儿 plist 清理逻辑
# Usage: bash tests/shell/check-uninstall.sh
#
# 覆盖 risk-register R2（P1）：卸载只删 manager plist、遗留 com.codex.*/com.xiaoxian.* 旧 per-agent 自启。
# 修复后 uninstall_launchd 按 label 白名单：含 multi-proxy 的家族内自动清；com.apple.* 绝不动；
# 跨家族（codex/hermes/cursor/xiaoxian）仅检测不自动删；坏 plist 跳过。
#
# 安全：全程用注入的临时 LAUNCHD_DIR（$TMPDIR 下），绝不触碰真实 ~/Library/LaunchAgents。
# 依赖：source install.sh（其 BASH_SOURCE 守卫使 main 不执行，仅加载函数定义）。

set +e   # 测试自身不启用 set -e；install.sh 的 set -e 在 source 时不影响本 shell 的 +e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 定位 install.sh：
#   1) 优先外部 INSTALL_SH 覆盖
#   2) 中文路径下 "$SCRIPT_DIR/.." 字符串解析会因 locale 字节比较失败（实测 test -f 返回 MISSING），
#      故用 git rev-parse --show-toplevel 取仓库根（无 .. 拼接，CJK-safe）
#   3) 回退 $PWD/install.sh（在仓库根运行时的常见情形）
if [ -z "$INSTALL_SH" ]; then
  INSTALL_SH=""
  if command -v git >/dev/null 2>&1; then
    _ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
    if [ -n "$_ROOT" ] && [ -f "$_ROOT/install.sh" ]; then
      INSTALL_SH="$_ROOT/install.sh"
    fi
  fi
  if [ -z "$INSTALL_SH" ] && [ -f "$PWD/install.sh" ]; then
    INSTALL_SH="$PWD/install.sh"
  fi
  INSTALL_SH="${INSTALL_SH:-$SCRIPT_DIR/../install.sh}"
fi

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 造一个合法 plist（Label=$2）
mk_plist() {
  cat > "$1/$2.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$2</string>
<key>ProgramArguments</key><array><string>/bin/true</string></array>
</dict></plist>
EOF
}

echo "=== install.sh (R2 卸载) Syntax & Behavior Validation ==="

# 1. 语法
echo "1. Checking bash syntax with bash -n..."
if bash -n "$INSTALL_SH" 2>&1; then pass "Syntax OK"; else fail "Syntax failed"; fi

# 2. 关键函数/常量存在
echo "2. Checking R2 functions & constants exist..."
for token in 'plist_label()' 'label_is_orphan()' 'label_is_suspect()' 'uninstall_launchd()' 'LAUNCHD_DIR=' 'LAUNCHD_DRY_RUN=' 'BASH_SOURCE\[0\]'; do
  if grep -q "$token" "$INSTALL_SH"; then pass "Found: $token"; else fail "Missing: $token"; fi
done

# 3. set -e 兜底（|| label=""，遇坏 plist 不中断整个卸载）
echo "3. Checking set -e safeguard in uninstall_launchd..."
if grep -q 'label="\$(plist_label "\$plist")" || label=""' "$INSTALL_SH"; then
  pass "set -e fallback present"
else
  fail "set -e fallback missing (label 兜底未到位)"
fi

# 加载函数到当前 shell（BASH_SOURCE 守卫下 main 不执行，仅定义函数）
L="$TMP/LA"; mkdir -p "$L"; export LAUNCHD_DIR="$L"
. "$INSTALL_SH" 2>/dev/null

# 4. dry-run：0 删除
echo "4. dry-run preview (no deletion)..."
mk_plist "$L" "com.multi-proxy-manager"
mk_plist "$L" "com.multi-proxy-codex-proxy"
mk_plist "$L" "com.apple.some-service"
echo "garbage" > "$L/broken.plist"
before=$(ls "$L"/*.plist 2>/dev/null | wc -l | tr -d ' ')
export LAUNCHD_DRY_RUN=1
out=$(uninstall_launchd 2>&1)
LAUNCHD_DRY_RUN=""
after=$(ls "$L"/*.plist 2>/dev/null | wc -l | tr -d ' ')
if [ "$before" = "$after" ]; then pass "dry-run deleted 0 plists"; else fail "dry-run deleted plists ($before -> $after)"; fi
echo "$out" | grep -q "dry-run" && pass "dry-run output visible" || fail "dry-run not reported"

# 5. 真删：家族清 / 系统留 / 跨家族检测 / 坏plist跳过
echo "5. real delete (family cleanup / system preserved / cross-family detected / broken skipped)..."
# 用独立目录，避免复用上面 dry-run 的
# 关键：section 4 的 LAUNCHD_DRY_RUN=1 在前台 subshell 没外传，但 install.sh L48 在 source 时已把
#   LAUNCHD_DRY_RUN 固定为空；这里显式确认空串，确保 uninstall_launchd 走真删分支。
L2="$TMP/LA2"; mkdir -p "$L2"; LAUNCHD_DIR="$L2"
export LAUNCHD_DRY_RUN=""
mk_plist "$L2" "com.multi-proxy-manager"        # 家族 → 清
mk_plist "$L2" "com.multi-proxy-codex-proxy"    # 家族(历史 per-agent 残留) → 清
mk_plist "$L2" "com.apple.foo"                  # 系统 → 留
mk_plist "$L2" "com.cc-switch.old"              # 跨家族(suspect关键词? cc-switch 不含 4 关键词) → 检测/留
mk_plist "$L2" "com.xiaoxian.codex-proxy.old"   # 跨家族(含 xiaoxian/codex) → 检测/留
echo "garbage-not-plist" > "$L2/broken.plist"   # 坏 → 跳过
out5=$(uninstall_launchd 2>&1)
# echo "$out5"
# 家族内已清
for gone in com.multi-proxy-manager com.multi-proxy-codex-proxy; do
  if [ ! -f "$L2/$gone.plist" ]; then pass "family cleaned: $gone"; else fail "family NOT cleaned: $gone"; fi
done
# 系统保留
[ -f "$L2/com.apple.foo.plist" ] && pass "system preserved: com.apple.foo" || fail "system plist wrongly deleted!"
# 跨家族保留（仅检测）
[ -f "$L2/com.xiaoxian.codex-proxy.old.plist" ] && pass "cross-family preserved: com.xiaoxian.codex-proxy.old" || fail "cross-family wrongly deleted!"
[ -f "$L2/broken.plist" ] && pass "broken plist preserved (skipped)" || fail "broken plist wrongly handled"
# 检测到跨家族
echo "$out5" | grep -q "疑似相关残留" && pass "cross-family detected" || fail "cross-family not detected"
# 坏 plist 被跳过
echo "$out5" | grep -q "无法解析\|跳过" && pass "broken plist skipped" || fail "broken plist not skipped"

# 6. 空目录优雅跳过
echo "6. empty LaunchAgents dir (graceful skip)..."
L3="$TMP/EMPTY"; mkdir -p "$L3"
LAUNCHD_DIR="$L3"; export LAUNCHD_DRY_RUN=""
out6=$(uninstall_launchd 2>&1)
rc=$?
[ "$rc" -eq 0 ] && pass "empty dir returns 0" || fail "empty dir rc=$rc"
echo "$out6" | grep -q "未发现\|跳过" && pass "empty dir reported gracefully" || fail "empty dir not handled"

# 7. label 判定单测
echo "7. label classification unit checks..."
label_is_orphan "com.multi-proxy-manager"   && pass "orphan: multi-proxy-family"    || fail "orphan misclassified"
label_is_orphan "com.apple.foo"             || pass "com.apple.* NOT orphan"         || fail "com.apple wrongly orphan"
label_is_orphan "com.cc-switch.old"         || pass "cross-family NOT auto-orphan"   || fail "cross-family wrongly auto-orphan"
label_is_suspect "com.xiaoxian.codex-proxy" && pass "suspect: codex/xiaoxian"       || fail "suspect misclassified"
label_is_suspect "com.apple.foo"            || pass "com.apple.* NOT suspect"        || fail "com.apple wrongly suspect"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -gt 0 ] && exit 1
echo "ALL PASS ✅"
