# docs/09-review/archive/ — 过程文件归档

> 本目录存放**已被取代或已收口的过程文件**，归档 ≠ 删除（用 `git mv` 保留历史，可随时回滚）。

## 归档规则

| 维度 | 规则 |
|------|------|
| **什么进** | 过程/时间戳类：`HANDOVER-*.md`、`MEMORY-<日期>.md`、`PROJECT-STATUS.md`、`review-<日期>/`、被主文档取代的评估（如 `PLUGGABLE-ARCH-ASSESSMENT`） |
| **何时进** | ① 已被长期入口取代（`MEMORY.md` 活入口 / `INDEX.md` / `01-feature-matrix.md`）② 一次评审收口、结论已并入主文档 ③ 纯时间戳快照，后续以新日期文件替代 |
| **是否维护** | 归档后**不再更新**；新内容写入主文档，不回填历史归档 |
| **可回滚** | `git mv` 而非 `git rm`，历史完整保留 |

## 入档清单（2026-09-17 收口）

| 文件 | 原位置 | 归档理由 |
|------|--------|----------|
| `HANDOVER-2026-08-24/25/26/09-10.md` | 根目录 | 交接快照，后续以 `MEMORY.md` + `INDEX.md` 替代 |
| `MEMORY-2026-09-10/11/12/16/17.md` | 根目录 | 过程记忆，活入口为根目录 `MEMORY.md` |
| `PROJECT-STATUS.md` | 根目录 | 项目状态快照，被 `INDEX.md` + `01-feature-matrix.md` 取代 |
| `PLUGGABLE-ARCH-ASSESSMENT-2026-08-25.md` | 根目录 | 架构评估，结论已并入 `architecture.md` |
| `WORK-SUMMARY-2026-08-16.md` / `MUNDER-REFERENCE-NOTE.md` | 根目录 | 一次性过程记录 |
| `architecture.html` / `architecture-v2.html` | 根目录 | 旧版可视化，被 `architecture.md` 取代 |
| `review-2026-08-24/` | 根目录 | 九角色评审，已收口，结论并入主文档 |

## 不归档（保留根目录，仍是活入口/活引用）

- `MEMORY.md` — 活记忆入口（CLAUDE.md 引用）
- `P0-FIXES.md` — 安全修复清单（CLAUDE.md 引用、活跃）

## 入口

评估完成度只读 `docs/INDEX.md` + `docs/01-feature-matrix.md`，无需翻本目录。
