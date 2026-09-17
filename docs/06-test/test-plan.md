---
title: "测试方案（test-plan）"
status: current
doc_type: test-plan
confidence: high
last_updated: 2026-09-17
related_code:
    - multi-proxy-manager/tests/
    - cursor-proxy/tests/
    - codex-proxy/tests/
    - hermes-proxy/tests/
    - l2/*.demo.js
    - l2/adapters/*.demo.js
    - tests/shell/
related_docs:
    - docs/06-test/test-cases.md
    - docs/01-feature-matrix.md
    - docs/09-review/risk-register.md
---

# 测试方案（test-plan）

> 回答「怎么组织测试、以什么标准判定放行」。用例明细见 `docs/06-test/test-cases.md`；本文件只管策略与退出准则。
> 所有数字 2026-09-17 真跑坐实（HEAD `8a1e3bc`）。

---

## 一、测试策略与分层

| 层 | 覆盖 | 工具 | 现状 |
|----|------|------|------|
| 单元测试 | 各模块 lib/route/service | Jest（Node/TS）+ pytest | ✅ 主力 |
| 集成测试 | 多模块协同 + 路由 + 成本 | Jest e2e | ✅ 部分 |
| E2E | 4 前端页面 UI 流 | Jest（manager） | ✅ manager 7 e2e |
| Demo / 冒烟 | L2 内核 + adapter | node 原生 demo | ✅ 13 demo |
| Shell 冒烟 | 启停脚本 | bats | ✅ 11 |
| 验收 | 数字/端口/模块一致性 | grep + 实测 | ✅ 见 `consistency-report` |

---

## 二、测试环境与工具（关键坑，真跑坐实）

| 模块 | 框架 | 运行命令 | 关键环境约束 |
|------|------|---------|------------|
| multi-proxy-manager | Jest | `cd multi-proxy-manager && npx jest --silent` | Node |
| cursor-proxy | Jest + ts-jest | `cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --silent` | **必须 node24 + ESM flag**，否则 11 suites 全 FAIL 是**假红** |
| codex-proxy | Jest | `cd codex-proxy && npx jest --silent` | Node |
| hermes-proxy | pytest | `cd hermes-proxy && /usr/bin/python3 -m pytest -q` | **必须 `/usr/bin/python3`**（flask 3.0.0）；uv 的 python3.11 无 flask 会 collection error |
| L2 demo | node | `node l2/<name>.demo.js` | 通过标记 `✅ Demo complete`（非 `PASS`） |
| Shell | bats | `cd tests/shell && bats *.bats` | macOS bash 3.x **无 `mapfile`**，用 for + Python |

> 总约束：根目录无 `package.json`，jest 必须在**子目录**跑；RTK 压缩需**串行**（并发 flaky，幂等但 TmuxKeepalive 冲突）。

---

## 三、各模块测试覆盖现状

| 模块 | 框架 | 文件 / suites | 测试数 | 状态 |
|------|------|--------------|--------|------|
| multi-proxy-manager | Jest | 46 files（39 unit + 7 e2e）/ 40 suites | **635** | ✅ 全绿 |
| cursor-proxy | Jest/TS | 11 files / 11 suites | **131** | ✅ 全绿（ESM flag） |
| codex-proxy | Jest | 3 files / 3 suites | **53** | ✅ 全绿 |
| hermes-proxy | pytest | 3 files | **63** | ✅ 全绿（无 E2E） |
| L2 demo | node | 13 demos（10 内核 + 3 adapter） | **~169 checks** | ✅ 全 PASS |
| Shell | bats | 1 file | **11** | ✅ 全绿 |
| **合计** | — | — | **882 / 882** | **✅ 全绿** |

依据：`docs/06-test/test-cases.md` 总览表 + 2026-09-17 实测。

---

## 四、未覆盖区域补测计划（见 risk-register §五）

| 盲区 | 优先级 | 计划 |
|------|--------|------|
| hermes-proxy E2E | P2 | 后续 P? 补（当前 3 文件 / 63 pytest 够用） |
| codex-proxy 流式断流/超时 pipeTo | P2 | 需 mock upstream 流，非当前范围 |
| kimi 路由价校准 | P3 | 真价接入时统一 |
| install.sh --uninstall 完整性 | P1 | 扫描移除已知 plist 集合 |

---

## 五、退出准则（什么条件下判定「可发布」）

1. **全绿**：635 + 131 + 53 + 63 + ~169 + 11（合计 882）测试/demo/checks 全 PASS，**无假红**（cursor 用 ESM flag、hermes 用 /usr/bin/python3）。
2. **数字一致**：`consistency-report.md` doc↔code grep 核对无漂移。
3. **风险收口**：`risk-register.md` 无未决 P0/P1 阻塞（仅 P2/P3 挂账可放行）。
4. **真跑不臆造**：每个数字可追溯到一条真实命令 + 输出（AGENTS §4 铁律）。
5. **L2 demo 通过**：13 demo（10 内核 + 3 adapter）输出 `✅ Demo complete`。

---

## 六、数据源
- 用例明细：`docs/06-test/test-cases.md`
- 功能完成度：`docs/01-feature-matrix.md`
- 风险/盲区：`docs/09-review/risk-register.md`
- 一致核对：`docs/09-review/consistency-report.md`
