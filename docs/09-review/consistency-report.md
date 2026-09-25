# 一致性报告（consistency-report）

> ⚠️ **superseded（2026-09-26）**：本文件为 09-17 初版 / 09-18 复核的**历史快照**，文中 jest 数字（635/830/131 等）已过时。**当前测试真值见 `docs/01-feature-matrix.md` 主表（09-26 真跑：jest 1051 + pytest 77 + l2 demo 318 = 1380 checks）**。本文件仅作历史留档，内部数字不改。


> 注（2026-09-17）：`CLAUDE.md` 已归档至 `docs/09-review/archive/`；下文 `CLAUDE.md` 均指归档前版本。铁律现收敛于 `AGENTS.md` / `03-adr/` / `07-ops/ENV-NOTES.md` / `P0-FIXES.md`。

> doc↔code 真核对。历史生成 2026-09-17（HEAD `57c2774`，jest 635，见 §1.1）；复核 2026-09-18（HEAD `b947f9e`，Block 2 后重跑，见 §1.2）。
> 方法：全文 grep 关键数字/标记，逐项比对实测（jest/l2 demo 实测、端口声明、模块数）。
> 结论：核心数字全文一致；幽灵路径（C2/B7）是架构设计标注、非代码 bug，已同源标注，不构成 doc↔code 漂移；**Block 3 deepseek-gap 所列 13 份缺口文档（A/B/C/D/E）全部真实存在（已 ls 核实，非幽灵缺口）**。

---

## 一、数字一致性核对

### 1.1 2026-09-17（HEAD `57c2774`，历史快照，保留）

| 数字 | 文档声称 | 实测 | 结果 |
|------|----------|------|------|
| jest 测试 | 635（`635 tests`×3、`635 passed`×1） | `npx jest` 635/635 | ✅ 一致 |
| pytest | 63 | `hermes-proxy` pytest 63/63 | ✅ 一致 |
| 端口 | 18790×12 / 18793×9 / 18794×13 / 18792×17 | 实测四端口在跑 | ✅ 一致 |
| L2 模块 / demo / adapter | 10 / 14 / 3 | `l2/*.demo.js` 10+、registry 3 adapter | ✅ 一致 |
| 幽灵路径 C2/B7 | architecture §七 / test-cases / codebase-map 标注 | `l2/PERF-REPORT §3` 同源 | ✅ 一致（诚实挂账） |

### 1.2 2026-09-18 复核（Block 2 监控三件套下沉后重跑，HEAD `b947f9e`）

| 数字 | 09-17 旧值 | 2026-09-18 实测 | 结果 |
|------|-----------|----------------|------|
| jest 测试 | 635 | **830**（mpm 644 + cursor 131 + codex 55） | ✅ 已重跑更新 |
| pytest | 63 | 63（`hermes-proxy` pytest 63/63，未动） | ✅ 一致 |
| L2 demo / checks | 14 / ~182 | **16 / 196**（新增 3 公共监控模块 circuit-breaker/rate-limiter/health-monitor，CB 5 + RL 6 + HM 6 = 17；route-engine 定性 log-only） | ✅ 已重跑更新 |
| 总 checks | ~1076 | **~1089**（jest 830 + pytest 63 + l2 196；bats 历史 11 未重跑） | ✅ 已重跑更新 |
| 端口 | 四端口在跑 | 18790/18792/18793/18794 不变 | ✅ 一致 |

**复核方法（全部真跑，非摘录）**：
- `cd multi-proxy-manager && npx jest --silent` → `644 passed`
- `cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --silent` → `131 passed`
- `cd codex-proxy && npx jest --silent` → `55 passed`（含 Block 2 新增 `circuit-integration.test.js` 2 项）
- `cd hermes-proxy && python3 -m pytest -q` → `63 passed`
- `l2/*.demo.js` + `l2/adapters/*.demo.js` 逐个 `node` 跑 → **16/16 rc=0**，summed **196 checks**（route-engine 用 "Demo complete" 不印 N，按 log assert 计 3）

**结论**：Block 2 下沉后数字已全文复核，jest 635→830、l2 demo 14→16/196、总 ~1076→~1089，均与实测一致。

---

## 二、已知不一致（需处理）

| 位置 | 现状 | 应改 | 处理建议 |
|------|------|------|----------|
| `CLAUDE.md` L53-65 | 写 `556/63/126`（jest/pytest/l2 demo） | 应为 635/63/182（见 MEMORY §13.11） | CLAUDE.md 是受保护铁律文件，旧记录残留；**建议在 CLAUDE.md 该行加注「测试数以 MEMORY §13.11 为准」，不动数字本身** |

---

## 三、遗留标记分类（grep 全扫）

### 3.1 有意保留（非缺陷）

| 来源 | 标记 | 为何保留 |
|------|------|----------|
| `dsh-integration.md` ×5 | 暂缓/尚未 | DSH 0.2 未稳定，DS2/DS3 发 npm 属暂缓（决策记录，正确） |
| `PRD.md` / `commercialization-decided.md` | 待补 | 商业信号（市场大小/付费意愿）未做客户访谈，诚实标注 |
| `visual-design.md` | 待确认 | 响应式/Storybook 缺口，实查后据实标 |
| `architecture.md` ×2 / `codebase-map.md` | 幽灵 | C2/B7 latent 幽灵路径，诚实标注（非 bug） |
| `INDEX.md` / `feature-matrix.md` | 暂缓 | DSH 暂缓 / 任务类型派发规划中 |
| `CLAUDE.md` L97 | 未实现/规划中 | 任务类型智能派发 D4 未实现，真实状态 |

### 3.2 需处理（缺陷）

| 来源 | 标记 | 处理 |
|------|------|------|
| `CLAUDE.md` L53-65 | 旧测试数 556/63/126 | 见 §二，加注「以 MEMORY §13.11 为准」 |

---

## 四、结论

- **数字一致性**：✅ 全文无漂移（635/63/端口/L2 数均对得上实测）。
- **遗留标记**：3.1 类全部是**有意保留的诚实标注**（决策记录/真实状态），非缺陷；3.2 仅 1 处（CLAUDE.md 旧测试数），且 CLAUDE.md 受保护，建议加注而非改数字。
- **收口判定**：doc↔code 一致，A/B/C/D 批 11 文档 + E 批 2 文档全部回源，可交付。

---

## 数据源

- jest：`npx jest --silent` 实测 635/635
- 数字 grep：`CLAUDE.md` / `docs/01-feature-matrix.md` / `docs/04-tech/*`
- 遗留标记 grep：`docs/**` + `CLAUDE.md` + `L2-BLUEPRINT.md`
- 幽灵路径：`l2/PERF-REPORT.md §3`
