#!/bin/bash
# Fallback shell script validation for manage.sh
# Usage: bash tests/shell/check.sh
#
# This runs bash -n syntax checks and basic function verification.
# For full integration tests, install bats-core: brew install bats-core

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
MANAGE_SH="$PROJECT_ROOT/manage.sh"

PASS=0
FAIL=0

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

echo "=== manage.sh Syntax & Structure Validation ==="

# 1. Syntax check
echo "1. Checking bash syntax with bash -n..."
if bash -n "$MANAGE_SH" 2>&1; then
  pass "Syntax check passed"
else
  fail "Syntax check failed"
  echo "   Errors above"
fi

# 2. Verify functions exist
echo "2. Checking required functions..."
for func in is_port_in_use show_status show_logs start_codex start_hermes start_cursor start_manager stop_service; do
  if grep -q "^${func}()" "$MANAGE_SH"; then
    pass "Function $func exists"
  else
    fail "Function $func not found"
  fi
done

# 3. Verify lsof uses absolute path (critical constraint)
echo "3. Checking lsof paths (critical constraint)..."
bare_lsof=$(grep -n 'lsof' "$MANAGE_SH" | grep -v '/usr/sbin/lsof' | grep -v '^#' | grep -v '#' || true)
if [ -z "$bare_lsof" ]; then
  pass "All lsof references use /usr/sbin/lsof"
else
  fail "Found bare lsof references (must use /usr/sbin/lsof):"
  echo "   $bare_lsof"
fi

# 4. Verify port constants
echo "4. Checking port assignments..."
declare -A EXPECTED_PORTS=( [CODEx_PORT]=18790 [HERMES_PORT]=18793 [CURSOR_PORT]=18794 [MANAGER_PORT]=18792 )
for var in CODEx_PORT HERMES_PORT CURSOR_PORT MANAGER_PORT; do
  if grep -q "${var}=" "$MANAGE_SH"; then
    pass "$var is defined"
  else
    fail "$var not defined"
  fi
done

# 5. Check shebang
echo "5. Checking script shebang..."
first_line=$(head -1 "$MANAGE_SH")
if [[ "$first_line" == "#!/bin/bash"* ]] || [[ "$first_line" == "#!/usr/bin/env bash"* ]]; then
  pass "Valid shebang"
else
  fail "Unexpected shebang: $first_line"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
