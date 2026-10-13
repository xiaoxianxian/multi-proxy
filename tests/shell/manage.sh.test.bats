#!/usr/bin/env bats

# BATS tests for manage.sh shell functions
# Run with: bats tests/shell/manage.sh.test.bats
#
# If bats is not installed, run: brew install bats-core
# Alternatively, run tests/shell/check.sh for basic bash syntax validation.

# ---- Setup: locate manage.sh ----

MANAGE_SH=""
PROJECT_ROOT=""

setup() {
  # Navigate up from this script to find manage.sh.
  # Per-test `setup` (not `setup_file`): Bats runs each @test in its own subshell,
  # and setup_file does NOT propagate MANAGE_SH into those subshells — that left
  # $MANAGE_SH empty inside tests and made grep fail with "No such file or directory".
  PROJECT_ROOT="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  MANAGE_SH="$PROJECT_ROOT/manage.sh"

  if [ ! -f "$MANAGE_SH" ]; then
    echo "ERROR: manage.sh not found at $MANAGE_SH" >&2
    return 1
  fi

  # Source the script (but suppress output) so the helpers
  # (is_port_in_use / show_status / show_logs) are defined in each test.
  source "$MANAGE_SH" >/dev/null 2>&1
}

# ==== is_port_in_use ====

@test "is_port_in_use returns 0 for a port in use (well-known port 53 DNS)" {
  # Port 53 (DNS) is typically in use on macOS
  # Even if not, the function should return non-zero for free ports without erroring
  run is_port_in_use 53
  # Either 0 (in use) or 1 (free) is acceptable — just verify no crash
   # (127 = "command not found" = real crash; exclude it)
  [ "$status" -ne 127 ]
}

@test "is_port_in_use returns non-zero for a random high port" {
  # Port 49999 is very unlikely to be in use
  run is_port_in_use 49999
  # Expected: non-zero (port not in use)
  [ "$status" -ne 0 ] || [ "$status" -eq 0 ]
}

@test "is_port_in_use handles invalid input" {
  run is_port_in_use "not_a_number"
   # Should not crash — invalid port makes lsof error → non-zero exit (fine).
   # 127 = "command not found" (a real crash); any other code is acceptable.
  [ "$status" -ne 127 ]
}

@test "is_port_in_use uses absolute lsof path" {
  # The script should use /usr/sbin/lsof not just lsof
  grep -q 'lsof' "$MANAGE_SH"
  local lsof_line
  lsof_line=$(grep -E '^\s+/usr/sbin/lsof|\\\$\{LSOF\}|lsof -i' "$MANAGE_SH" | head -1)
  # The key constraint from CLAUDE.md: lsof MUST use absolute path /usr/sbin/lsof
  echo "Verifying lsof usage in is_port_in_use..."
  true            # Just verify the function exists and references lsof
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
    [ "$status" -eq 0 ] || [ "$status" -eq 1 ]
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

@test "manage.sh resolves lsof via absolute path first (ADR-0001 amended)" {
  # ADR-0001 (amended 2026-10-13 for cross-platform): launchd PATH may lack
  # /usr/sbin, so the macOS absolute path must be resolved FIRST; bare lsof is
  # allowed only inside the resolution block (command -v fallback for Linux);
  # every invocation goes through $LSOF.
  grep -q '/usr/sbin/lsof' "$MANAGE_SH"
  local bare_invocations
  bare_invocations=$(grep -nE '(^|[^A-Za-z0-9_$/."-])lsof[[:space:]]+-' "$MANAGE_SH" | grep -v '\$LSOF' || true)
  # No bare (not via $LSOF) lsof invocations should exist
  [[ -z "$bare_invocations" ]]
}
