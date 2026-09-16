---
name: multi-proxy
description: Use when managing the multi-proxy AI agent system (Codex/Hermes/Cursor proxies on ports 18790/18793/18794), running diagnostics on proxy liveness, or operating the web manager at multi-proxy-manager/18792 — orients the operator to project architecture, the 4 non-invasive L2 guardrails, the NO_PROXY iron rule, and how to run the full test suite.
---

# multi-proxy — Project Orientation Skill

## What you get

This skill is a lightweight orientation layer for the `multi-proxy` repo. It tells you where to start, the safety guardrails, and how to verify the system is healthy — without loading the entire codebase.

## When to use

- Managing proxy lifecycle: start / stop / status / logs of Codex(18790) / Hermes(18793) / Cursor(18794) / Manager(18792).
- Diagnosing proxy liveness: when Manager shows "not running" but agents appear to work.
- Adding new adapters to the L2 orchestration core.
- Running the full test matrix.

## Architecture at a glance

| Module | Tech | Port |
|--------|------|------|
| `multi-proxy-manager/` | Node.js + Express | 18792 |
| `codex-proxy/` | Node.js + Express | 18790 |
| `hermes-proxy/` | Python + Flask | 18793 |
| `cursor-proxy/` | TypeScript + SQLite (better-sqlite3) | 18794 |
| `l2/` | Node.js kernel + 3 adapters | — |

## Safety guardrails (non-negotiable)

1. **`/usr/sbin/lsof` absolute path** — Node.js child processes (`launchd` context) lack `/usr/sbin` in PATH; `execSync('lsof …')` will silently fail if not absolute.
2. **NO_PROXY: never inject bare `*` globally** — `launchctl setenv NO_PROXY '…,*,…'` poisons all