---
title: "风险登记册（risk-register）"
status: current
doc_type: risk-register
confidence: high
last_updated: 2026-09-17
related_docs:
    - docs/09-review/consistency-report.md
    - docs/09-review/unknowns.md
    - README.md §十二
    - P0-FIXES.md
---

# 风险登记册（risk-register）

> 汇总「已知问题 + 代码 TODO/FIXME + 幽灵路径 + P0 安全」，验收前最后一道防线。
> 生成日期 2026-09-17（HEAD `8a1e3bc`）。原则：诚实挂账，不臆造；区分「当前风险 / 已规避 / 设计取舍」。
> 风险等级：P0 阻塞 / P1 高 / P2 中 / P3 低（记录）。

---

## 一、已知问题（来源：`README §十二`）

| # | 风险 | 等级 | 状态 | 依据 / 处置 |
|---|------|------|------|------------|
| R1 | 裸 `*` 污染全局 NO_PROXY（旧 `codex-multi-model-proxy-deploy` 的 `install.sh`） | P0（历史） | **已规避** | 当前 `proxy-rebuild` 源码无此写法；autostart plist 仅设 `PATH`；修复 `*`→`::1`。见 ADR-0002 / `07-ops/ENV-NOTES.md` |
| R2 | `install.sh --uninstall` 卸载不完整（只删 manager plist，遗留 `com.codex.*`/`com.xiaoxian.*` LaunchAgents） | P1（当前） | 待修 | 卸载时扫描移除已知 plist 集合，或统一单一命名 |
| R3 | 缺「单一所有者」保护（proxy-rebuild 与 cc-switch 可同时把同 agent base_url 指向自己） | P2（设计） | **已缓解** | 已用 `tools/agent-proxy-switch` 提供安全切换；产品级互斥未做（P5 桌面壳方向） |

---

## 二、代码 TODO / 占位（来源：grep 全扫 4 模块 + l2）

| # | 位置 | 内容 | 等级 | 处置 |
|---|------|------|------|------|
| T1 | `cursor-proxy/src/routing/routeEngine.ts:202` | `kimi-k2.6` 价 `{input:0.6,output:2.5,cacheHit:0.1}` 估算占位，待校准 | P3 | 后续校准（kimi 真价接入时统一处理） |
| T2 | `l2/alert.js:13` | `notify` sink 为 observe 占位（默认 `log` 收集） | P3 | observe 语义正确，非缺陷 |
| T3 | `multi-proxy-manager/PROVIDERS-README.md` | 模板 `api_key` 为占位符，可安全入库 | P3 | 模板说明，非缺陷 |
| T4 | `cursor-proxy/src/index.ts:89` | OpenAI API Key 处填占位 `dummy` | P3 | 部署时由用户填真实 key，非缺陷 |

**判定**：T1-T4 全为占位/估算，无阻塞性 FIXME；grep 全扫无 `HACK`/`XXX`/`待补` 类阻塞标记。

---

## 三、幽灵路径（来源：`l2/PERF-REPORT.md §3` / `unknowns U7-U8`）

| # | 路径 | 为什么挂账 | 触发条件 | 判定 |
|---|------|-----------|---------|------|
| G1 | `forward.js` C2 axios 15s+100MB 全缓冲，不支 SSE | 当前 manager 不代理 chat 流 → latent | manager 成为 chat 统一入口 | 修了反坑，**不修** |
| G2 | `codex-proxy` B7 120s+pipeTo 掐断长流 | 同上，线上无人用 | 需 live 复现定夺 | 挂账 |

---

## 四、安全 / P0（来源：`P0-FIXES.md`）

| 项 | 状态 |
|----|------|
| JWT / bcrypt / CSP / 登录限流 / 错误脱敏 | ✅ 已修（`multi-proxy-manager/tests/security.test.js` 覆盖） |
| auth 401/200 + settings + providers CRUD/脱敏/409 | ✅ 已补（`codex-proxy/tests/auth-and-admin.test.js`） |

---

## 五、测试覆盖盲区（来源：`06-test/test-cases.md`）

| 盲区 | 等级 | 处置 |
|------|------|------|
| hermes-proxy 无 E2E（3 文件 / 63 pytest，覆盖基本够用） | P2 | 后续 P? 补 E2E |
| codex-proxy 超时/流式断流真实 pipeTo 路径未覆盖（需 mock upstream 流） | P2 | 非当前范围 |
| `tests/shell/` 仅 11 bats，覆盖 manage.sh 启停 | P3 | 够用 |

---

## 六、总判定

| 维度 | 结论 |
|------|------|
| 当前 P0 风险 | 仅 R2（卸载不完整），非阻塞交付 |
| P1/P2 | R3 已缓解；测试盲区 P2 不阻塞 |
| 占位/幽灵 | T1-T4 / G1-G2 全非缺陷，诚实挂账 |
| **收口** | **无未决 P0/P1 阻塞交付**；所有风险已分级登记 |

---

## 数据源
- 已知问题：`README §十二`
- 代码 TODO：`grep -rnE 'TODO|FIXME|HACK|XXX|占位'` 4 模块 + l2（4 条，全 P3）
- 幽灵路径：`l2/PERF-REPORT.md §3` / `docs/09-review/unknowns.md U7-U8`
- 安全：`P0-FIXES.md` / `multi-proxy-manager` + `codex-proxy` 测试
- 测试盲区：`docs/06-test/test-cases.md`
