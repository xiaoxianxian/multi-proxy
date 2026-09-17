---
title: "证据存档（_evidence）"
doc_type: evidence
status: current
last_updated: 2026-09-17
parent: docs/INDEX.md
---

# _evidence — 验收证据存档

> 存放测试/运行的**真实证据**：测试输出日志、运行截图、性能报告、验收快照。
> 铁律（见 AGENTS.md §4）：**所有性能数字、测试通过数必须来自真实运行结果，不得从文档摘录**。
> 本目录就是"数字可追溯"的落点——文档里引用的每个数字，都应能在本目录或一条可复现命令找到证据。

## 用法

1. 跑测试 / demo，把输出重定向到本目录：`<模块>/tests ... > docs/_evidence/<date>_<module>.log`
2. 截图用 `<date>_<name>.png` 命名，放本目录。
3. 在 `docs/01-feature-matrix.md` / `06-test/acceptance.md` 引用证据时，标注相对路径或复现命令。

## 验收快照（882/882 全绿，2026-09-17 真跑）

| 证据 | 内容 | 复现命令 |
|------|------|----------|
| `manager` | 635 passed / 40 suites | `cd multi-proxy-manager && npx jest --silent --forceExit` |
| `codex` | 53 passed / 3 suites | `cd codex-proxy && npx jest --silent --forceExit` |
| `cursor` | 131 passed / 11 suites | `cd cursor-proxy && NODE_OPTIONS='--experimental-vm-modules' npx jest --silent --forceExit` |
| `hermes` | 63 passed | `cd hermes-proxy && /usr/bin/python3 -m pytest tests/ -q` |
| `l2` | 13/13 demo PASS（~182 checks）| `cd l2 && for d in *.demo.js adapters/*.demo.js; do node "$d"; done` |
| `shell` | 11/11 bats | `bats tests/shell/` |
| **合计** | **882/882 全绿** | see `ACCEPTANCE-CHECKLIST.md` |

## 命名规范

- 日志：`YYYY-MM-DD_<module>_<kind>.log`（如 `2026-09-17_cursor_jest.log`）
- 截图：`YYYY-MM-DD_<name>.png`（如 `2026-09-17_p5-gui-dashboard.png`）
- 性能：`YYYY-MM-DD_<topic>-perf.md`

## 注意

- 本目录文件**不入 git 历史正文**（大日志/截图单独存档，INDEX 只引用相对路径）。
- 数字过期即重跑覆盖旧快照，保留时间戳可追溯。
