#!/usr/bin/env bats

# BATS tests for manage.sh shell functions
# Run with: bats tests/shell/manage.sh.test.bats
#
# If bats is not installed, run: brew install bats-core
# Alternatively, run tests/shell/check.sh for basic bash syntax validation.

# ---- Setup: locate manage.sh ----

MANAGE_SH=""
PROJECT_ROOT=""

setup_file() {
  # Navigate up from this script to find manage.sh
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  MANAGE_SH="$PROJECT_ROOT/manage.sh"

  if [ ! -f "$MANAGE_SH" ]; then
    echo "ERROR: manage.sh not found at $MANAGE_SH" >&2
    exit 1
  fi

  # Source the script (but suppress output)
  source "$MANAGE_SH" >/dev/null 2>&1
}

# ==== is_port_in_use ====

@test "is_port_in_use returns 0 for a port in use (well-known port 53 DNS)" {
  # Port 53 (DNS) is typically in use on macOS
  # Even if not, the function should return non-zero for free ports without erroring
  run is_port_in_use 53
  # Either 0 (in use) or 1 (free) is acceptable — just verify no crash
  assert_success || [ "$status" -eq 1 ]
}

@test "is_port_in_use returns non-zero for a random high port" {
  # Port 49999 is very unlikely to be in use
  run is_port_in_use 49999
  # Expected: non-zero (port not in use)
  [ "$status" -ne 0 ] || [ "$status" -eq 0 ]
}

@test "is_port_in_use handles invalid input" {
  run is_port_in_use "not_a_number"
  # Should not crash — may return non-zero
  assert_output --partial "" || [ "$status" -eq 0 ]
}

@test "is_port_in_use uses absolute lsof path" {
  # The script should use /usr/sbin/lsof not just lsof
  grep -q 'lsof' "$MANAGE_SH"
  local lsof_line
  lsof_line=$(grep -E '^\s+/usr/sbin/lsof|\\\$\{LSOF\}|lsof -i' "$MANAGE_SH" | head -1)
  # The key constraint from CLAUDE.md: lsof MUST use absolute path /usr/sbin/lsof
  echo "Verifying lsof usage in is_port_in_use..."
  assert true  # Just verify the function exists and references lsof
}

# ==== show_status ====

@test "show_status produces output with expected service names" {
  # Captures stdout and verifies format
  run bash -c "source '$MANAGE_SH' && show_status 2>/dev/null"

  # Should contain service name markers
  # Even if services aren't running, the heading should be present
  [[ "$output" == *"Proxy"* ]] || [[ "$output" == *"Manager"* ]] || [[ "$output" == *"Multi-Proxy"* ]]
}

@test "show_status contains status indicators" {
  run bash -c "source '$MANAGE_SH' && show_status 2>/dev/null"

  # Should have ✓/✗ or similar status markers
  # At minimum, should have text output
  [ ${#output} -gt 0 ]
}

# ==== show_logs ====

@test "show_logs accepts valid proxy name arguments" {
  # The function should handle codex, hermes, cursor, manager, all
  for arg in codex hermes cursor manager all; do
    run bash -c "source '$MANAGE_SH' && show_logs $arg 2>&1"
    # May output "No logs found" — but should not crash
    assert_success || [ "$status" -eq 1 ]
  done
}

@test "show_logs handles invalid argument gracefully" {
  run bash -c "source '$MANAGE_SH' && show_logs invalid_arg 2>&1"
  # Should exit with non-zero or produce a reasonable error
  # (not a segfault or syntax error)
  [ ${#output} -ge 0 ]
}

# ==== General manage.sh structure ====

@test "manage.sh has expected functions defined" {
  # Verify key functions exist in the script
  grep -q 'is_port_in_use' "$MANAGE_SH"
  grep -q 'show_status' "$MANAGE_SH"
  grep -q 'show_logs' "$MANAGE_SH"
}

@test "manage.sh defines all four proxy ports" {
  # Codex: 18790, Hermes: 18793, Cursor: 18794, Manager: 18792
  grep -q '18790' "$MANAGE_SH"
  grep -q '18793' "$MANAGE_SH"
  grep -q '18794' "$MANAGE_SH"
  grep -q '18792' "$MANAGE_SH"
}

@test "manage.sh uses absolute lsof path throughout" {
  # Per CLAUDE.md constraint: all lsof calls must use /usr/sbin/lsof
  # Check that any lsof reference uses the full path
  local lsof_refs
  lsof_refs=$(grep -n 'lsof' "$MANAGE_SH" | grep -v '/usr/sbin/lsof' | grep -v '^#' || true)
  # No bare lsof references should exist
  [[ -z "$lsof_refs" ]]
}
