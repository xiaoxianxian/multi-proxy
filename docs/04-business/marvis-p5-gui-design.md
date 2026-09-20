# Marvis 式多 Agent 可视化看板 · P5 设计草案

> 状态：**设计草案（不实施代码，待老板拍板做/不做 + 做到哪档）**，2026-09-20
> 对象：`multi-proxy` L2 编排中枢 P5「可视化整个团队工作状态」
> 关联：`L2-BLUEPRINT.md` §4.7（Marvis 式 GUI 看板）· §七排期表 P5 行 · `AGENTS.md` §3 非侵入铁律 · `docs/03-adr/0003-l2-non-invasive-principle.md` · `docs/05-design/visual-design.md` · `desktop/`（已整装壳）· `multi-proxy-manager/public/dashboard.html`（已建骨架）
> 定位一句话：P5 = 把 L2 内核运行时状态 + manager 现有 API 投影成一块 Marvis 式多 agent 协作看板，**在已整装壳 + 已建 6 页之上长出来，不重造壳、不重做前端、不碰编排热路径**。

---

## 一、背景与定位

### 1.1 它在 L2 蓝图的位置

`L2-BLUEPRINT.md:16` 新定位 L2 原文：

> **Agent 编排中枢（网关 + 中台）**：把各 Agent（Codex / Hermes / Cursor / …）当"员工"，统一管理配置（记忆、技能、路由规则、健康状态），按任务类型自动调度到最合适的 Agent，**并可视化整个团队的工作状态**。

P5 = 末句"并可视化整个团队的工作状态"的 GUI 实现，对应 §4.7 管理界面层 + §七排期表：

| 优先级 | 模块 | 工作量 | 状态 |
|---|---|---|---|
| P5（可选） | Marvis 式 GUI 看板 | 3-5 天 | 未开始 |
| P5（可选） | 编排面板 + 插件市场 UI | 2-3 天 | 未开始 |

蓝图 §九决策 #3 已拍板：**Marvis GUI = 锦上添花，降为可选 P5，可延后或不做**。本文不推翻该决策，只给形态/选型/分期，供老板定"做不做、做到哪档"。核心 P0–P3 已全绿（`docs/01-feature-matrix.md` 为评估单一入口），P5 不动它们，只读投影。

### 1.2 与已有壳 / 前端骨架的关系（先澄清，P5 成本才能压缩）

仓库里"P5"曾被两件事占；本草案只处理第二件：

| 已存在 | 现状（已核实） | P5 怎么复用 |
|---|---|---|
| **`desktop/` Electron 壳** | ✅ 整装：`main.js` / `preload.js` / `package.json` / `README.md`，commit `42ea997`（壳） + `2163ca9`（验收 + 启动脚本）；`business-intro.md`「P5 桌面壳 ✅ 已闭环」 | 壳 = 启动器 + 窗口，`BrowserWindow.loadURL('http://127.0.0.1:18792')`（`desktop/main.js:15,167`），不打包业务代码。渲染层 = manager 网页，**看板就落在 manager `public/`，不动壳** |
| **`public/dashboard.html` 侧栏骨架** | ✅ 已建 85KB / 2123 行，`data-page` 7 项：dashboard / health / alerts / registry / sessions / logs + 独立 `sessions.html` | P5 在此骨架上铺/升 7 类看板页，复用其加载栏 / 离线 banner / 明暗主题 / `BroadcastChannel('proxy-status')` 同步 |
| **manager 后端 API（12 路由）** | ✅ 多数已落门控 + 非侵入 | P5 前端只 `GET/POST` 这些现成端点；缺口页各补 1 个只读端点（§3） |
| **`l2/` 10 内核 + 3 adapter** | ✅ demo 全 PASS | 即看板可视化的数据源对象 |

**结论：P5 不是"从零做 GUI"，是"接现有 API + 在已建骨架上铺/升几页"，工期可压到 3 天出核心观感。**

---

## 二、看板要可视化的对象（7 类 + 现状盘点）

### 2.1 现状盘点（决定真实增量）

`dashboard.html` 侧栏 6 个 data-page + 独立 `sessions.html`，实测 `fetch('/api/*')` 已接：`/api/status`、`/api/provider-health[/:id]`、`/api/health-history`、`/api/alert`、`/api/alert/config`、`/api/alert/collect`、`/api/registry/agents{,/by-capability/:tag,/:id}`、`/api/sessions/*`、`/api/conflicts`、`/api/version`、`/api/installed`、`/api/env-check`、`/api/auth/status`。

| 看板类 | 内核 | 现状 | 增量 |
|---|---|---|---|
| ① 花名册 | `agent-registry.js` + `routes/registry.js` | registry 页已建（列表 + 能力筛选 + 新增模态） | 升级为工位化卡片（加状态灯/负载/成本列） |
| ② 调度视图 | `orchestrator.js` + `decomposer.js` + `route-engine.js` | **缺口**：无 DAG 可视化 | 全新页 |
| ③ 任务流 | 协作历史 + `routes/sessions.js` | sessions 页已建（列表 + 续跑/中止/删除） | 升级为带 DAG 展开的时间线 |
| ④ 健康 / 韧性 | `health-monitor` + `circuit-breaker` + `rate-limiter` + `routes/provider-health.js` | health 页已建（ok/degraded/down + 历史 + Provider） | 增熔断/限流列 |
| ⑤ 成本 | `cost.js` + `lib/cost-track.js` | **缺口**：无独立读端点 | 全新页 + 1 个只读端点 |
| ⑥ 插件市场 | `plugin-runtime.js` + `skill-service.js` + `mcp-server.js` | **缺口**：plugin-runtime 无路由、`public/` 无任何引用 | 全新页 + 1 个只读端点 |
| ⑦ 告警 | `alert.js` + `routes/alert.js` | 告警中心页已建（三路信号 + 门控 Badge） | 复用；门控 403 灰显 |

**真实增量 ≈ 3 个缺口页（②⑤⑥）+ 3 个页升级（①③④），不是 7 个从零。**

### 2.2 每类屏幕 sketch（文字 + 简框，不画真图）

#### ① 员工花名册 ↔ `l2/agent-registry.js`（最高优先）

数据源：`agent-registry.js`（Profile CRUD + 能力标签）+ `routes/registry.js`（GET 只读不挂 auth；写操作挂 `requireAuth`）。复杂度档位 `complexity → modelTier` 已落地于 `l2/COMPLEXITY-MODE.md` + `decomposer.js`，卡片可直显档位。

```
┌─ 员工花名册 · 12 个 Agent ───────────────────── [按能力 ▾] [新增]
│  ┌─ Codex-01 ──┐ ┌─ Hermes-07 ─┐ ┌─ Cursor-03 ──┐
│  │ [code] ●运行 │ │ [writing] 空 │ │ [db] ●繁忙    │
│  │ qwen3.8-lg  │ │ qwen-md      │ │ deepseek-md   │
│  │ 现任务 #42   │ │ 产出 3/周     │ │ 现任务 #51     │
│  │ 负载 72%      │ │ 成本 --       │ │ 负载 90%       │
│  └──────────────┘ └────────────┘ └──────────────┘
│  ← 卡片=工位；色=Agent 类型；灯=状态；标=能力档位
```

#### ② 调度视图 ↔ `orchestrator` + `decomposer` + `route-engine`（核心卖点）

数据源：`routes/orchestration.js`（`GET /` 协作历史、`POST /run` 触发、`POST /shadow` 开关 shadowMode），门控 `PROXY_ORCHESTRATION`（默认 0 → 403）。LLM 拆解路径门控 `PROXY_LLM_DECOMPOSE`（默认关，失败降级回 template，`decompose/decomposeSource` 字段标 template/llm/llm-down）。

```
┌─ 调度视图 · 任务 #42  "写 FastAPI + JWT + DB" ──[shadow ●ON] [触发编排]
│            ┌─ 子任务1 ─┐
│   用户任务  │ 设计 API   │  code/low        → Codex         ✓ 已聚合
│         ┌───┼─子任务2    │
│         │   │ DB 模型    │  code/medium    → Cursor        ● 执行中(并行)
│         │   └─┬─ 子任务3  │
│         │     │ JWT       │  code/medium    → Hermes        ● 执行中(并行)
│         └─────┴─┬─ 子任务4 ─┐
│                 │ 写单测     │  test/low      → Codex         ○ 待执行(依赖 1-3)
│  ← 节点=子任务；边=依赖；节点色=○待/●行/✓完/✗失；shadow 态高亮
```

#### ③ 任务流 ↔ 协作历史 + `routes/sessions.js`（次核心）

数据源：`GET /api/sessions/running`、`GET /api/sessions`、`GET /api/sessions/:id`、`POST /api/sessions/:id/{resume,abort,done,fail,step}`、`DELETE /api/sessions/:id`；DAG 节点复用 ② 的端点。

```
┌─ 任务流 · 运行中 3 / 共 28 ──────────────────── [自动刷新 ●10s]
│ ● #42  FastAPI+JWT 0→Codex→Cursor→Hermes→Codex  3/4  12m  ¥0.42
│ ● #51  视频工作流 h3web(拆解→分镜→渲染→聚合)      2/5   4m  ¥2.10
│ ○ #48  文档整理 pending(依赖 #42)
│ ⨉ #39  翻译 failed @ 子任务3 (→ /resume 可续跑)
│  ← 每条=一次编排；点击展开 DAG（复用 ②）
```

#### ④ 健康 / 韧性 三件套 ↔ `health-monitor` + `circuit-breaker` + `rate-limiter`

数据源：`GET /api/status`（归一化 `ok/degraded/down` + checks + reasons + latencyMs，`routes/proxy-control.js`）、`GET /api/health-history?limit=`、`GET /api/provider-health[/:id]`（`routes/provider-health.js`，只读 observe，不自动 flip 隔离）、`GET /api/conflicts`。

```
┌─ 健康中心 · ok 3 / degraded 1 / down 1 ────────── [刷新]
│  代理     状态        延迟   运行   熔断         限流
│  codex    ● ok        42ms  3d12h  closed       12/20 tok
│  hermes   ◐ degraded  380ms 3d11h  half-open    18/20 tok  ← 近上限
│  cursor   ● ok        51ms  3d10h  closed        5/20 tok
│  ── Provider 故障隔离(observe 模式, 不自动 flip) ──
│  deepseek-cc failures=7 → 建议隔离  跨 Proxy 关联: ✓ h3web 同报
```

#### ⑤ 成本视图 ↔ `l2/cost.js` + `lib/cost-track.js`

数据源：现状**仅** `GET /api/balances?proxy=`（`routes/proxy-api.js`，`requireAuth`）+ `GET /api/alert/collect` 第三路 `costTrack.getAll() × PROXY_COST_BUDGET` 信号。折进概览页而非独立页（省 1 页），需 1 个只读 `GET /api/cost` 聚合端点（二期补）。

```
┌─ 成本 · 今日 ¥14.2 / 周 ¥88.5 / 月 ¥310 · 预算 ¥400 ── 35%
│ [近 30 日折线]  按 Agent: codex 42% / hermes 33% / cursor 25%
│ 预算告警: hermes 周 ¥120 / ¥100 → cost-budget-exceeded ⚠（喂 ⑦ 告警）
```

#### ⑥ 插件市场 ↔ `plugin-runtime` + `skill-service` + `mcp-server`

数据源：`routes/skill-service.js` `/api/skill-service{,/:key,/:key/bump,/:key/rollback}`（门控 `PROXY_L2_SKILL` 默认关）、`routes/mcp.js` `/api/mcp` `tools/list`（门控 `PROXY_L2_MCP` 默认关，能力快照可用）；`l2/plugin-runtime.js` **当前无 manager 挂载**，需新加只读路由或复用 `/api/mcp`。

```
┌─ 插件市场 · 已启 5 / 共 8 ───────────── [按类型 ▾] [上传]
│ 路由规则 │ 供应商适配器 │ 健康检查器 │ UI 面板 │ 记忆适配器
│  ┌─ zg成本优化 ─┐ ┌─ deepseek适配 ─┐ ┌─ 自定义探活 ┐
│  │ v1.2   ● 启动 │ │ v0.9   ● 启用 │ │ v2.0   ○ 草│  ← 灯=生命周期
│  │ 路由规则类    │ │ 适配器类       │ │ 健康类        │
│  └───────────────┘ └───────────────┘ └──────────────┘
│  ← 卡片=插件；可启停/版本切换；热插拔不重启项目；安全议题见蓝图 §6.4
```

#### ⑦ 告警 ↔ `l2/alert.js` + `routes/alert.js`（复用，无需改）

数据源：`GET /api/alert`、`GET /api/alert/config`、`POST /api/alert/collect`（门控 `PROXY_HEALTH_ALERT` 默认 403）。`dashboard.html` 已有 `#alertGateStatus` 门控关闭 Badge 灰显——这是全看板"门控默认关"范本，新页照此实现。

```
┌─ 告警中心 · 严重 1 / 警告 2 / 信息 3 ─── 门控:●关闭(灰显)  [立即采集]
│  来源: provider-health | error-patterns | cost
│  ⨉ cost-budget-exceeded  hermes 周花费超 ¥100    12:03
│  ⚠ provider degraded       deepseek-cc 连续 7 次  11:58
```

---

## 三、数据来源 + 门控铁律

### 3.1 数据源映射（接 manager 现有 API，不读内核热路径）

| 看板模块 | 端点 | 路由文件 | 门控 / 门控缺省 |
|---|---|---|---|
| ① 花名册 | `/api/registry/agents` `/:by-capability/:tag` `/:id` | `routes/registry.js` | 无（GET 只读不挂 auth；写操作 `requireAuth`） |
| ② 调度视图 | `/api/orchestration` `{,/run, /shadow}` | `routes/orchestration.js` | `PROXY_ORCHESTRATION`（默认 0 → 403）、`PROXY_LLM_DECOMPOSE`（默认关，模板拆解） |
| ③ 任务流 | `/api/sessions/*` | `routes/sessions.js` | 无 |
| ④ 健康韧性 | `/api/status` `/api/health-history` `/api/provider-health[/:id]` `/api/conflicts` | `routes/proxy-control.js` / `routes/provider-health.js` | 无（`PROXY_HEALTH_ISOLATE` 仅 flip 隔离动作） |
| ⑤ 成本 | `/api/balances?proxy=` + (新) `GET /api/cost` | `routes/proxy-api.js` + 新增 | `requireAuth` + `PROXY_COST_TRACK` 默认关（A 路 token×单价 埋点）|
| ⑥ 插件市场 | `/api/mcp{,/health,/call,/rpc}` + `/api/skill-service{,/:key,/bump,/rollback}` | `routes/mcp.js` / `routes/skill-service.js` | `PROXY_L2_MCP` / `PROXY_L2_SKILL`（默认关） |
| ⑦ 告警 | `/api/alert{, /config, /collect}` | `routes/alert.js` | `PROXY_HEALTH_ALERT` / `PROXY_COST_SCHEDULE`（默认关） |

### 3.2 非侵入铁律（`AGENTS.md` §3 + `docs/03-adr/0003`，看板必须遵守）

1. **只读 L2 状态，不碰编排热路径。** 看板只 `GET/POST` 既有端点；不 `import` `orchestrator.js` / `decomposer.js`；不改热路径文件（`forward.js` / `codex-proxy/proxy.js`，`AGENTS.md` §5.5）。
2. **门控默认关 / shadow 默认开。** 新页遇 403 一律"门控关闭"灰显（照 `#alertGateStatus` 范本），不报错、不放行、不 auto-setenv；② 触发 / ⑥ 启停需对应 env，默认全关。
3. **不写 agent 文件 / 不注入全局 env / 不写死端口。** 看板不写 `~/.codex`/`~/.hermes`/`~/.cursor`，不 `launchctl setenv NO_PROXY` 类通配（`AGENTS.md` §2），端口动态（manager `:18792`、h3web 探测 8731/8732）。
4. **shadow 态全程高亮。** ② ⑥ 的影子执行用醒目色标 + "影子 / 不触真实 adapter" 文案，避免老板把影子当真实。

---

## 四、技术选型

**前提**：渲染层 = manager 网页，壳已整装（§1.2），`docs/05-design/visual-design.md` 记录现状「无前端框架，纯 CSS 变量 + 原生 JS」（`colors_and_type.css` token 层 + `shared-styles.css` 组件层，明暗双主题）。

| 形态 | 描述 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| **A. 现有 `dashboard.html` 骨架上扩/升页（推荐）** | 复用 7 导航、加 3 缺口页、升 3 页；沿用原生 JS + 现有 token | 增量最小、与现 UI 一致、门控/主题/壳全部复用、非侵入最干净 | 受 dashboard.html 现有结构约束；大页面拆独立页（照 `sessions.html` 做法） | ✅ 推荐 |
| B. 壳内挂独立 React 子应用 | `desktop/` 加一个 React 路由 | 组件化、DAG 库生态好 | 多一套构建、与项目"无框架/零依赖"现状冲突 | 不推荐 |
| C. 纯独立单 HTML 页 | 另起一个 HTML 接 manager API | 最快出 demo | 与壳割裂、双份维护、体验差 | 不推荐 |

**唯一需补的工程件**：DAG/折线布局原生 JS 没有内建，选 1 个可嵌入、无构建、纯 JS 的库即可（图布局 `dagre` / 自绘 SVG、折线 `chart.js` / 自绘 canvas），与 `l2/` 零依赖策略不冲突。

**不引框架**：渲染层沿用原生 JS + 现有 design token；壳侧 `preload.js` 已预留 `window.desktopShell = {isDesktop, platform}` 桥接点，原生通知 / Dock 提示**本期不做**，看板纯网页已足够。

---

## 五、分期（建议先做最小可读看板）

**一期（最小看板，建议先做到这里）**：① 花名册升级 + ② 调度视图 + ③ 任务流。三件凑成"谁在干 / 怎么拆 / 跑到哪"的完整 Marvis 观感叙事，是全看板的核心卖点。④ ⑦ 已建，顺手复用。

**二期（按需）**：④ 加熔断/限流列 + ⑤ 成本视图 + ⑥ 插件市场 UI。对应蓝图排期"编排面板 + 插件市场 UI"那 2-3 天。

| 期 | 内容 | 工期 |
|---|---|---|
| **一期 P5.0（最小看板）** | ① ② ③ | 约 3 天（①③ 各 ~0.5 天升级；② DAG + 图布局 + shadow 高亮 ~2 天） |
| 二期 P5.1（按需） | ④ ⑤ ⑥ | 约 2-3 天（④ ~0.5 天升级；⑤⑥ 各 ~1 天，含各 1 个只读端点） |
| 合计 | 全看板 | 5-6 天，与蓝图 P5「3-5 + 2-3」区间相符；因页面已建大半，实际比原估略低 |

老板若只要"看一眼团队在干啥"，**一期 3 天即达成核心观感**，二期可停在 P5.1 前。

---

## 六、风险 / 取舍

| 风险 | 说明 | 对策 |
|---|---|---|
| 门控默认关导致看板空 | ② ⑥ 默认 403，看板打开是灰显 | 照 `#alertGateStatus` 范本做"门控关闭"灰显态；空态给"去开 env"文案引导（只读，不自动开） |
| 成本 / 插件无独立读端点 | ⑤ 无 `/api/cost`；⑥ plugin-runtime 无路由 | ⑤ 折进概览 + `GET /api/balances` 复用 / 二期加 `GET /api/cost`；⑥ 复用 `/api/mcp` 的 `tools/list` 能力快照 / 二期加 read 路由 |
| DAG 可视化复杂度高 | ① ② ③ 需依赖图布局 | 一期接 1 个轻量图布局库；复杂任务先画 3-4 层，深依赖折叠 |
| 大页面性能 | `dashboard.html` 已 85KB | 缺口页独立 HTML（照 `sessions.html` 独立页做法），不塞进主文件 |
| shadow 态误读 | ② ⑥ 影子执行被当真实 | 全程高亮 + 文案"影子 / 不触真实 adapter" |

**取舍**：成本视图折进概览而非独立页；插件市场先做只读（列表 / 启停 / 版本），上传 / 签名 / 沙箱留蓝图 §6.4 安全议题；原生通知 / Dock 提示本期不做；不引前端框架。

---

## 七、一句话总结 + 给老板的推荐

**一句话**：P5 = 在已整装壳 + 已建 6 页之上，接 manager 现成 API，新增 3 个缺口页（调度视图 / 成本 / 插件市场）+ 升级 3 个页（花名册工位化 / 任务流 DAG / 健康熔断限流），全程只读 L2 状态、门控默认关灰显、不碰编排热路径。

**推荐（给老板）**：

- **建议做，且先只做一期（3 天）**。这是 L2 从"能跑"到"看得见团队"的临门一脚，也是 Marvis 式卖点的观感核心。投入小（页面已建大半，增量主要是 1 个 DAG 图布局 + 2 个缺口页 + 1 个读端点 + 3 个页升级），风险低（全程只读、门控默认关、非侵入铁律齐备），工期可控在 3 天出核心观感。
- **二期（成本 / 插件市场 / 熔断列）按需**：成本视图对"自动选性价比"卖点价值最高，可优先；插件市场 UI 与蓝图 §6.4 安全议题绑定，待安全定了再做。
- **不动壳、不引框架**：渲染层沿用原生 JS + 现有 design token，壳仅预留桥接点不开工。
- **维持蓝图"锦上添花 / 可延后"定位**：核心 P0-P3 全绿，P5 不影响主线，老板可在任意节点叫停。要不要开做、做到哪一期，老板定。

---

## 附录：核实过的关键事实（grounded 回执）

| 事项 | 核实依据 |
|---|---|
| L2 新定位原句 + "可视化团队工作状态" | `L2-BLUEPRINT.md:14-16` |
| P5 = 可选 / 锦上添花 / 3-5 天 + 2-3 天 | `L2-BLUEPRINT.md` §七排期表 P5 行；§九决策 #3「降为可选 P5，可延后或不做」 |
| 桌面壳已整装（壳 + 验收 commit） | `desktop/main.js` / `preload.js` / `package.json` / `README.md`；commit `42ea997` + `2163ca9`；`business-intro.md`「P5 桌面壳 ✅ 已闭环」 |
| 壳 = 启动器 + 窗口、加载 `:18792`、不打包业务 | `desktop/README.md`「壳 = 启动器 + 窗口」+ `desktop/main.js:15,167` |
| 看板前端已建 6 / 7 导航页 | `public/dashboard.html`（85KB / 2123 行，`data-page` = dashboard/health/alerts/registry/sessions/logs）+ 独立 `public/sessions.html` |
| 7 类看板 ↔ l2 内核逐一对应 | `l2/README.md` + `L2-BLUEPRINT.md` §四：agent-registry / orchestrator+decomposer / health-monitor+circuit-breaker+rate-limiter / alert / cost / plugin-runtime+skill-service / mcp-server |
| 各路由端点实测存在 + 门控名 | `routes/registry.js` / `orchestration.js` / `sessions.js` / `provider-health.js` / `proxy-control.js` / `alert.js` / `skill-service.js` / `mcp.js`（`PROXY_ORCHESTRATION` / `PROXY_LLM_DECOMPOSE` / `PROXY_HEALTH_ALERT` / `PROXY_L2_MCP` / `PROXY_L2_SKILL` / `PROXY_COST_SCHEDULE` 默认关 → 403；`shadowMode:true` 默认） |
| 非侵入铁律四联 | `AGENTS.md` §3「不写 agent 文件 / 不注入全局 env / 不写死端口 / 门控默认关 shadow 默认开」+ `docs/03-adr/0003-l2-non-invasive-principle.md` |
| 成本无独立读端点 / 插件运行时无 route | `routes/` 无 `/api/cost` 挂载；`server.js` 无 `plugin-runtime` route；`cost` 仅 `lib/cost-track.js` + 告警第三路；`/api/mcp` 提供 `tools/list` 能力快照 |
| dashboard.html 已有"门控关闭"灰显 | `public/dashboard.html` `#alertGateStatus`（告警中心页），全看板范本 |
| "无框架纯原生 JS" 现状 | `docs/05-design/visual-design.md` 一、形态 |
| `complexity → modelTier` 档位已在内核 | `l2/COMPLEXITY-MODE.md` + `decomposer.js` / `llm-decomposer.js`（多文件命中） |

*最后更新：2026-09-20 P5 GUI 设计草案（v2 — 合并核实，不实施代码，落地前需老板拍板做不做 / 做到哪档）*
