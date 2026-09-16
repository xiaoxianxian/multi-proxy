---
name: l2-orchestrator
description: Use when working on the L2 orchestration core (l2/ directory: agent-registry, orchestrator, alert, cost, route-engine, plugin-runtime, decomposer, memory-merge, skill-service) — orients the developer to the 10-module kernel, the 4 non-invasive iron guardrails, the plugin/adapter contract, and the 13-demo verification workflow.
---

# L2 Orchestrator — Core Kernel Orientation

## What you get

Orientation into the `l2/` orchestration core: the 10 kernel modules, 3 adapter contracts, non-invasive design, and how to verify with the 13 demo suite.

## When to use

- Adding or debugging a new L2 kernel module.
- Implementing or fixing an adapter (h3web, AIGC, L1-chat).
- Wiring L2 routes into `multi-proxy-manager/routes/` (`orchestration.js`, `alert.js`).
- Running the L2 demo verification suite.

## L2 Module Map

| Module | Entry | Responsibility |
|--------|-------|----------------|
| Agent Registry | `agent-registry.js` | Capability-based agent discovery + routing match |
| Plugin Runtime | `plugin-runtime.js` |