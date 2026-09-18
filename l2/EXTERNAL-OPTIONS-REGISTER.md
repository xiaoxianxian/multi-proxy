# 外部评估待办登记 — WorkBuddy / DeepSeek option2 · option3

> 状态：**登记 · 评估依赖 · 非阻塞（2026-09-18 贾维斯登记）**
> 背景：WorkBuddy 给 3 个 option，老板定：option1（complexity 路由）先做设计草案
> （见 `l2/COMPLEXITY-MODE.md`）；option2 / option3 **评估依赖后留着**，可全都要。
> 结论先讲：**三 option 能全要，无互斥；option3 依赖 option1 + 新协议，依赖解决后再做。**
> **诚实标注**：Octop / harness-agent 是 WorkBuddy 引入的外部概念，项目内零记载，
> 其形态未定 → 依赖项标「待外部确认」，不臆造形态。

---

## 三 option 依赖关系（核心）

```
option1  complexity 路由          （设计草案，本批做）
   │
   ├──► option2  failover middleware 草案   （依赖：resilience 可抽性 + DSH 0.2）
   └──► option3  L2 包成 MCP server        （依赖：option1 落地 + _execute 接真实 + MCP 协议）
```

- **无互斥**：option1/2/3 都基于 L2 内核，可全做。
- **依赖链**：option3 = option1 + 接真实 adapter + 新 MCP 协议 → 最重。
- **非阻塞**：三者都不阻塞交付（项目当前 jest 837 / demo 全绿，已收口）。

---

## Option 1 · complexity → 模型档位路由

- **状态**：设计草案见 `l2/COMPLEXITY-MODE.md`（待老板定 4 个决策点）。
- **依赖**：无前置（复用 `decomposer.js` 已产 complexity + Block 2 的 modelType 模式）。
- **本批处理**：已出设计草案，等老板讨论。

---

## Option 2 · Octop `harness-agent` failover middleware 草案

- **价值评估**：✅ **有做**。resilience 三件套（`circuit-breaker/rate-limiter/health-monitor.js`）
  已下沉为 L2 独立纯 JS（`b947f9e`），抽成 failover middleware 工程量小，且补 Octop 缺口
  （WorkBuddy：「你的韧性网关 + 你的拆解」分工）。
- **依赖（已核验）**：
    | 依赖 | 状态 | 处置 |
    |------|------|------|
    | resilience 三件套是否「纯 JS、可独立抽」 | ✅ 已验：仅 `node 内置 + circuit-breaker 互依赖`（`health-monitor` 依赖 `circuit-breaker`，其余零外部依赖） | 无阻塞 |
    | `harness-agent` 形态（Octop 的 middleware 接口） | ❓ **待外部确认**：项目内零记载 `Octop`/`harness-agent`，接口形态未定 | **阻塞项**：拿到 Octop 接口规范再写 |
    | DSH 0.2（若抽成 Cordis 插件发布） | ⏸ 暂缓（`bundle-design.md §5`） | 不阻塞草案，阻塞发布 |
- **本批处理**：登记依赖，**不写草案**（接口形态未定，写了=投机）。待老板拿到 Octop `harness-agent` 接口后再做。

---

## Option 3 · L2 包成 MCP server

- **价值评估**：✅ **有做**（长期），但**最重**，放最后。WorkBuddy：「把 L2 包成 MCP server 仍没动，
  要做只差 `_execute` 接真实 adapter + 加 HTTP」。
- **依赖（已核验）**：
    | 依赖 | 状态 | 处置 |
    |------|------|------|
    | `_execute()` 接真实 adapter runner | ❌ 仍是桩：`route-engine.js:140` `return {status:'queued'}` | **阻塞项 1**：需先接真实 executor（orchestrator executor 缝） |
    | MCP 协议实现（stdio/SSE） | ❌ 项目无 MCP 代码 | **阻塞项 2**：需新增 MCP server 框架（新模块） |
    | HTTP 服务暴露 L2 能力 | ❌ `skill-service`/`memory-merge` 无 HTTP（unknowns U5） | 阻塞项 2 的一部分 |
    | option1 complexity 路由 | 进行中（设计草案） | 建议 option1 落地后，L2 能力才完整可对外暴露 |
- **本批处理**：登记依赖，**不写代码**。建议执行序：option1 → option2（拿到 Octop 接口）→ option3。

---

## 总判定

| 维度 | 结论 |
|------|------|
| 三 option 能否全做 | ✅ 能，无互斥 |
| option1 | 设计草案已出，待老板定 4 决策点 |
| option2 | 价值有；**阻塞**=Octop `harness-agent` 接口形态未定（待外部确认） |
| option3 | 价值有（长期）；**阻塞**=`_execute` 接真实 + MCP 协议（最重，放最后） |
| 是否阻塞交付 | ❌ 都不阻塞（项目已收口，jest 837 / demo 全绿） |
| 建议执行序 | option1（本批） → option2（拿到 Octop 接口后） → option3（option1 落地后） |

---

_登记日期：2026-09-18 | 作者：贾维斯（Hermes Agent）| 关联：`l2/COMPLEXITY-MODE.md` / `docs/02-product/bundle-design.md`_
