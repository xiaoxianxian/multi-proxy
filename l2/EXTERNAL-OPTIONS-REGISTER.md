# 外部评估待办登记 — WorkBuddy / DeepSeek option2 · option3

> 状态：**登记 · 评估依赖 · 非阻塞（2026-09-18 贾维斯登记）**
> 背景：WorkBuddy 给 3 个 option，老板定：option1（complexity 路由）先做设计草案
> （见 `l2/COMPLEXITY-MODE.md`）；option2 / option3 **评估依赖后留着**，可全都要。
> 结论先讲：**三 option 能全要，无互斥；option3 依赖 option1 + 新协议，依赖解决后再做。**
> **诚实标注 + 核实（2026-09-18 贾维斯据老板转的 WorkBuddy 内容核实）**：
> - `orcakit-harness-agent` 在 **PyPI 实测存在**（v1.0.11，MIT，summary「Production-grade Harness Agent built on top of LangChain Deep Agents」）。
> - 但它指向的 **GitHub 仓库 `TencentCloud/harness-agent` 实测 404**（经代理核实）——但 **源码不在 GitHub，在 PyPI wheel 里**。
> - **option2 阻塞已解（2026-09-19 贾维斯独立复现验证）**：`orcakit-harness-agent` wheel（`1.0.11-py3-none-any.whl`，1.45MB，sha256 `9cc849…`）真可下载，解压出 **447 成员 / 212 个 `harness_agent/*.py`**，spec 引用的 `middleware/model_router.py:19-23`（`from langchain.agents.middleware import AgentMiddleware/ModelRequest/ModelResponse`）实测与 WorkBuddy 所写**完全一致**，可复现、非臆造。
> - **但 provider 前置（option1 延伸）零代码、今天就能用**——WorkBuddy 也确认。

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

## Option 1 · complexity → 模型档位路由 ✅ 已实施完成（2026-09-19）

- **状态**：**已实施完成**。设计见 `l2/COMPLEXITY-MODE.md`（4 决策点老板已定稿：tier 抽象命名 / high 不降级 / 静态先行动态二期 / 独立文件）。
  - 代码落地：`agent-registry.js` 加 `modelTier`（small/medium/large 可选校验 + `byTier`）+ `route-engine.js` 加 `_mapTier`（low→small / high→large / 默认 medium）+ `tierMatch` 排序维度。
    修复 1 bug：`expectedTier` 漏写 decision 顶层（只进了 candidate）。
  - E2E 全绿：route-engine.test.js **14/14**（旧 10 + 新 4 complexity）+ agent-registry/demo 全绿 + l2 全 13 demo PASS。
- **依赖**：无前置（复用 `decomposer.js` 已产 complexity + Block 2 的 modelType 模式）。
- **本批处理**：✅ 已实施完成。动态 LLM 复判（二期，更准）留路线，暂未做（用户明确"暂只做静态"）。

---

## Option 2 · Octop `harness-agent` failover middleware 草案

- **价值评估**：✅ **有做**。resilience 三件套（`circuit-breaker/rate-limiter/health-monitor.js`）
  已下沉为 L2 独立纯 JS（`b947f9e`），抽成 failover middleware 工程量小，且补 Octop 缺口
  （WorkBuddy：「你的韧性网关 + 你的拆解」分工）。
- **依赖（已核验）**：
    | 依赖 | 状态 | 处置 |
    |------|------|------|
    | resilience 三件套是否「纯 JS、可独立抽」 | ✅ 已验：仅 `node 内置 + circuit-breaker 互依赖`（`health-monitor` 依赖 `circuit-breaker`，其余零外部依赖） | 无阻塞 |
    | `harness-agent` 形态（Octop 的 middleware 接口） | ✅ **已解（2026-09-19 贾维斯独立复现）**：接口真相在 **PyPI wheel** 不在 GitHub 仓库（`TencentCloud/harness-agent` 404，但 wheel 含全量源码）。WorkBuddy 已据 wheel 实测出 spec `docs/octop-harness-failover-middleware-spec.md`（`model_router.py:19-23` 接口我对照 wheel 原文逐项核实一致，可复现非臆造） | **可纳入**：按 spec 写 middleware（无需碰 harness 内核，只需继承 `AgentMiddleware`、在 `handler` 外包 failover）；DSH 发布仍暂缓 |
    | DSH 0.2（若抽成 Cordis 插件发布） | ⏸ 暂缓（`bundle-design.md §5`） | 不阻塞草案，阻塞发布 |
- **本批处理**：✅ **WorkBuddy 已出实测 spec `docs/octop-harness-failover-middleware-spec.md`（319 行，含 wheel 复现命令 + `AgentMiddleware` 接口 + 官方 `ModelRouterMiddleware` 范例），贾维斯独立复现验证（wheel 下载 + 对照 `model_router.py:19-23` / `ChatModelFactory`(llm/factory.py) / `HarnessAgentConfig`(config/__init__.py, frozen dataclass) / `wrap_model_call` 契约，逐项与 wheel 原文一致）→ option2 阻塞已解、**可纳入**。但 option2 实现是 Python middleware（harness 是 Python 项目），与本批 complexity 路由（Node L2 内核）**跨语言**，建议老板发话后再按 spec 实施；**provider 前置（option1，零代码）已可直接使用**，无需等。

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
| option1 | ✅ **已实施完成**（jest 14/14 + demo 全绿；静态 complexity→tier，动态二期留路线） |
| option2 | 价值有；**阻塞已解（2026-09-19 贾维斯独立复现 wheel）**=spec 已出 `docs/octop-harness-failover-middleware-spec.md`，可纳入但实现是 Python middleware（跨语言），建议老板发话再实施 |
| option3 | 价值有（长期）；**阻塞**=`_execute` 接真实 + MCP 协议（最重，放最后） |
| 是否阻塞交付 | ❌ 都不阻塞（项目已收口，jest 837 / demo 全绿） |
| 建议执行序 | option1（本批） → option2（拿到 Octop 接口后） → option3（option1 落地后） |

---

_登记日期：2026-09-18 | 作者：贾维斯（Hermes Agent）| 关联：`l2/COMPLEXITY-MODE.md` / `docs/02-product/bundle-design.md`_
