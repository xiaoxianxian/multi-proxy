# Marvis 文章分析 + multi-proxy 迭代规划

> 日期：2026-09-23
> 作者：搭档（WorkBuddy）
> 用途：分析腾讯 Marvis 文章对 multi-proxy 项目的价值，给出**已读代码的现状结论**与**优先级迭代规划**，供 Hermes agent 后续统一迭代。
> 状态：仅分析 + 规划，**未改动任何代码**。

---

## 0. 信息来源与可信度（回源）

- 文章：微信公众号《版面之外》专栏，作者「画画」，《又一次，用户替腾讯 Marvis 找到了位置》，**2026-09-23 14:04 发布**（即分析当日新鲜出炉）。
- 性质：**腾讯倾向明显的梳理/软文**，数据均为官方口径。结论：**当"方向信号"看，不当独立验证**。
- 文章关键数据点（回源，供引用）：
  - 人均 Token 消耗：上线首月约 100 万 → 590 万
  - 用户量：较 5 月增长近 4 倍
  - 远程控制：累计使用超 1800 万次
  - 端侧量化：35B 级模型内存 ~30GB → 压到 10GB 以下，目标 11 月让 16G 内存设备可跑
  - 生态接入：瑞幸接 Marvis 花数月做 MCP，含方案/开发/上线后问题处理

---

## 1. 文章核心论点（去 AI 腔）

Marvis 上线 4 个月，腾讯从"操作系统级 AI 助手"重定位成"个人 AI 管家"（电脑/文件/浏览器/软件管家）。三个判断：

1. **两种上下文**：WorkBuddy 吃"企业上下文"（权限/流程/知识库），Marvis 吃"设备上下文"（文件分布/软件环境/硬件算力）。
2. **服务直达**：用户要的是"结果"不是"App"；App 通过 MCP/SDK 退到后台，前台只留"管家"角色。
3. **Agent 不该只住云端 + 连接不能断**：端侧量化让模型进设备；NAS 本地索引让 AI 理解散落数据。结尾一句：**"模型可以换，连接不能断。"**

---

## 2. multi-proxy 现状（已读代码，file:line 回源）

**架构总览**：`multi-proxy-manager` 是转发壳（Express 组装层），把 `/api/{proxy}/*` 转发到三个 proxy：`codex` / `hermes` / `cursor`。

| 组件 | 真实状态 | 证据 |
|------|----------|------|
| `codex-proxy/proxy.js` | **单 provider 透传**：`findProvider(model)` 按 model 名返回唯一上游；`/v1/chat/completions`（line 589-654）无 failover 循环、无复杂度分档 | `proxy.js:178-202`（findProvider）、`proxy.js:589-654`（passthrough） |
| `cursor-proxy/src/routing/routeEngine.ts` | **真路由引擎**：`fallbackChain`（failover 链，line 187）、`strategy`（priority/round-robin/cost-optimization，line 29/115）、`rules`（taskType/privacy/quality 显式规则，line 188-195）、`maxRetries=3`（line 196）、`pricing`（¥/1M，本地 qwen/agnes 免费、deepseek/kimi 付费，line 205-228） | `routeEngine.ts:51-168`、`routeEngine.ts:177-229` |
| `l2/COMPLEXITY-MODE.md` | complexity 档位（small/medium/large）是**设计草案（2026-09-18 待定稿）**，**尚未接进 routeEngine**；routeEngine 当前只消费 taskType + pricing + rules。文档明确两轴：modelType（模态，已接）vs complexity（难度，未接） | `COMPLEXITY-MODE.md:1-22`、`COMPLEXITY-MODE.md:94-101` |

**关键事实（代码层，2026-09-23 读代码确认）**：
- **本地/云端分流 = 代码已建，但运行时未激活**：`DEFAULT_ROUTE_CONFIG` 本地 `qwen3.8:27b-mlx` 打头、云端兜底（`routeEngine.ts:177-187`）——这是 routeEngine 的**设计配置**，但 routeEngine 当前不在热路径（见 §2.5）。
- **成本意识 = 代码已建，未激活**：`pricing` + `cost-optimization`（`routeEngine.ts:115-163`、`205-228`）。
- **failover = 代码已建，未激活**：`fallbackChain` + `maxRetries=3`（`routeEngine.ts:187`、`196`）。

> ⚠️ 上一轮（未实测）把上面三项写成"已经接好在用"是**错的**。实测（§2.5）证明：routeEngine 只被 `routing-shadow.ts` 的 **dry-run 影子模式** import，且两道闸门 `PROXY_ROUTE_OVERRIDE` / `PROXY_ROUTING_SHADOW` 默认 **OFF**。热路径实际跑的是 `findProviderConfig`（按 model 名单 provider 查表，priority 模式，**无 failover 循环 / 无成本比价 / 无 task 分类**）。三项能力是"建好待激活"，不是"已生效"。

---

## 2.5 实测核查结论（2026-09-23 14:26，运行时证据 · 已 curl 只读端点 + 读进程 env）

> 目的：回答"默认 chat 走哪个 proxy / routeEngine 是否在热路径"。**只读核查，未发任何 chat 请求、未改代码**。

**A. 运行时端口（实测 `lsof` + `ps`，与文档 18790-18794 不同——实际走 `.env`/启动覆盖）**
| 进程 | PID | cwd | 实际端口 |
|------|-----|-----|----------|
| multi-proxy-manager（壳） | 31148 / 30898 | `.../multi-proxy-manager` | **18901 / 18902**（两个实例） |
| codex-proxy | 39334 | `.../codex-proxy` | **18903** |
| cursor-proxy | 39602 | `.../cursor-proxy` | **18904** |

**B. 哪个 proxy 真在接流量（实测）**
- **codex-proxy (18903) = 实际活跃的那条**：`/health` 健康，`/v1/models` 已挂好上游（deepseek/kimi/agnes/moonshot 等 17 个），`/api/routing-mode` → `{"mode":"codex"}`（**单 provider 透传**，旧路径）。它有真实 key + 模型 + 健康 → 是真正服务 chat 的 proxy。
- **cursor-proxy (18904) = 含引擎但休眠**：`/health` ok；`/admin-api/settings` → `routing_mode:"priority"`；`/admin-api/routes` → `[]`（**无任何路由规则**）；进程 env **无** `PROXY_ROUTE_OVERRIDE` / `PROXY_ROUTING_SHADOW`；**无** `data/override-audit.jsonl` 落盘（证明 override 从未开启）。

**C. routeEngine 是否在热路径（实测 + 代码双重确认）**
- 代码：`routeEngine.ts` 仅被 `routing-shadow.ts` import；`chatHandler.ts` 热路径是 `findProviderConfig(model)`（单 provider 查表），仅在 `PROXY_ROUTE_OVERRIDE===1` 时走 `routeShadow` override 分支（`chatHandler.ts:385-414`），默认关。
- 项目 MEMORY.md（2026-09-15, line 159/184）明文："`PROXY_ROUTE_OVERRIDE` 门控（默认 off）… 热路径 `findProviderConfig` 函数体零改动"；"健康感知接生产路由决策（卡 D4=C sign-off，`PROXY_ROUTE_OVERRIDE=1` 灰度）"。
- **结论：routeEngine 不在热路径，处于"建好待激活"态。**

**D. 主力 agent 是否走 multi-proxy（实测）**
- Hermes `~/.hermes/config.yaml` → `base_url: https://apihub.agnes-ai.cn/v1`（**直连 agnes，不经 multi-proxy**）。
- WorkBuddy（全局记忆）→ `models.json` 直连 `http://localhost:11434/v1`（Ollama 本地）。
- **结论：当前两个主力 agent 都没把 multi-proxy 当模型供给层**。multi-proxy 现在更像"备好但未上生产"的设施；codex-proxy 是其中唯一挂好真实上游、在待命的。

**E. 给迭代的前提修正**
- 缺口①不是"把 routeEngine 接进 codex 热路径"（routeEngine 本就在 cursor-proxy），而是：**① 让 cursor-proxy 成为实际 chat proxy（或把 codex-proxy 退役/并入），② 翻转 `PROXY_ROUTE_OVERRIDE=1` 闸门让 routeEngine 真接管（已有安全前置：host 断言锁 `api.deepseek.com`，MEMORY 162 行），③ 先跑 shadow 观测 + override-audit 复盘再 sign-off**（MEMORY 184 行已规划）。

---

## 3. 文章概念 → 项目现状映射（含对上一轮说法的修正）

> 搭档在对话第一轮凭记忆给了结论，读代码后**以下三点需修正**：

| 文章概念 | 之前（凭记忆）的说法 | 读代码后的真相 | 结论 |
|----------|----------------------|----------------|------|
| 路由到合适能力/服务 | "按 complexity + failover" | live routeEngine 用 taskType + cost-optimization + rules + fallbackChain；complexity 档位**仍是草案未接** | 智能路由比想的更先进，但复杂度维度没闭环 |
| 本地/云端分流 | 建议"新增" | routeEngine `DEFAULT_ROUTE_CONFIG` 已是本地 qwen 打头 + 云端兜底，但**运行时未激活**（§2.5） | **代码已建、未激活**——翻转 `PROXY_ROUTE_OVERRIDE` 闸门才生效，不是"新增"也不是"已生效" |
| 成本视图 | 建议"新增" | routeEngine 已有 `pricing` + `cost-optimization`，但同未激活 | **代码已建、未激活**——面板暴露只是最后一步，前提是引擎先上线 |

**仍成立的判断**：
- "前台简单/后台复杂"的设计张力仍然成立：Marvis 对**终端用户**隐藏复杂性，而 multi-proxy 的 dashboard 是**开发者/运维可观测台**，主动暴露 provider/模型选择。两者定位不同，不冲突——但面板可加"自动模式"默认接管、只做 observability。
- "连接不能断 / 模型可换"是 multi-proxy 的底层逻辑（provider 抽象 + fallbackChain），与文章结尾论断**完全同构**，是最值得对外讲的叙事锚点。

---

## 4. 真正有价值的迭代点（按优先级排序）

### ①【最关键缺口】激活 routeEngine（翻闸门 + 让 cursor-proxy 成为实际 chat proxy）
- **问题（实测 §2.5）**：routeEngine 已在 cursor-proxy 写好，但热路径是 `findProviderConfig`（单 provider 查表），两道闸门 `PROXY_ROUTE_OVERRIDE`/`PROXY_ROUTING_SHADOW` 默认 OFF；且**真正在待命接流量的是 codex-proxy（dumb 透传）**，cursor-proxy 的 `/admin-api/routes` 还是空。所以 Marvis 式"按情境智能选"既没激活、主力 agent 也没接进来。
- **动作（分三步，对应 MEMORY 184 行规划）**：
  1. **shadow 先观测**：设 `PROXY_ROUTING_SHADOW=1` 起 cursor-proxy，跑一段时间真实流量，看 `routeShadow` 建议是否靠谱（不改动路由，纯日志）。
  2. **override 接管**：设 `PROXY_ROUTE_OVERRIDE=1` 翻闸门，routeEngine 经 `findProviderByType` 真改 `req.body.model` 接管路由（已有安全前置：host 断言锁 `api.deepseek.com`，MEMORY 162 行）。
  3. **把实际 chat 流量切到 cursor-proxy**：确认客户端 base_url 指向 cursor（或在 manager 把默认 proxy 改成 cursor），并给 cursor 配齐 routes/provider（当前 `/admin-api/routes=[]`）。codex-proxy 可保留作 legacy fallback 或退役。
- **文件**：`cursor-proxy/src/server/start.ts`（闸门）、`cursor-proxy/src/server/handlers/chatHandler.ts:385-414`（override 分支）、`cursor-proxy` DB（routes/providers 配置）。
- **验证**：① shadow 日志显示合理建议；② override 开后，断首选 provider 自动 failover 到 `fallbackChain` 下一个且不丢消息；③ 成本比价生效（免费模型优先）；④ `data/override-audit.jsonl` 有复盘记录。
- **注意**：不要去给 codex-proxy 重写 routeEngine——引擎已在 cursor-proxy，方向是"让 cursor 上位"，不是"把引擎搬进 codex"。

### ②【差异化筹码】落实 COMPLEXITY-MODE 草案
- **问题**：complexity 档位（small/medium/large）是 2026-09-18 草案，未接进 routeEngine。文档自己称其为"相对 Octop/WorkBuddy 的真正差异化筹码"。
- **动作**：把 `complexity`（decomposer 已产 low/medium/high）接进 `route()`：`low→small`（ Agnes 免费/本地小档）、`high→large`（Qwen3.8/远端强模型），默认 medium 不降级。定稿 `COMPLEXITY-MODE.md`。
- **文件**：`l2/agent-registry.js`（+`MODEL_TIERS` + `byTier()`）、`l2/route-engine.js`（+`_mapTier()` + 消费 complexity）、`l2/COMPLEXITY-MODE.md`（定稿）。
- **验证**：`agent-registry.test.js` +3 绿、`route-engine.test.js` +4 绿、`npx jest` 零回归。

### ③【面板升级】从"切换器"到"调度可观测台"
- **动作**：dashboard 新增两栏——**provider 健康度**（failover 谁在线/冷却）+ **单次调用成本**（复用 routeEngine `pricing`）。保留开发者手动切换，新增"自动模式"默认隐藏选择、面板只做 observability。
- **文件**：`multi-proxy-manager/public/dashboard.html` + `routes/provider-health.js` + 成本埋点（`lib/cost-track.js` 已存在，门控 `PROXY_COST_TRACK`）。
- **验证**：切换 provider 时面板实时显示健康度与最近一次调用成本。

### ④【叙事价值，零代码】公众号对标文
- **动作**：用文章"模型可以换，连接不能断"做一篇《Jason 的落地思考》对标文，把 multi-proxy 定位成"个人 AI 的连接层 / 控制面"，对标 Marvis 的"AI 枢纽"但落在模型 provider 维度。文章结尾"委托关系只能在不越界的执行里慢慢建立"→ 对应 multi-proxy 的 failover 不丢请求、静默切换可靠性。
- **注意**：对外稿履历泛化（不点名公司/项目），用 Jason 笔名。

---

## 5. 不相关 / 别被带偏（明确划掉）

- 设备管家 / C 盘清理 / 软件安装 / NAS 硬件管理 → Marvis 应用层，与模型路由无关，**不做**。
- 信创 / 麒麟预装 / PC 厂商 SDK → 渠道生意，**不是你的事**。
- 35B 量化到 10GB → 模型压缩，你已本地跑 qwen3.8 端侧路线，方向一致但**你不需要做量化**。

---

## 6. 给 Hermes agent 的执行提示

1. 本文件是分析 + 规划，**不要动代码**，按 §4 顺序迭代。
2. **缺口①核实已完成（2026-09-23 实测，见 §2.5）**：routeEngine **不在**热路径（休眠，闸门 OFF）；实际待命接流量的是 codex-proxy（dumb 透传）；主力 agent（Hermes/WorkBuddy）当前都没走 multi-proxy。迭代按 §4 ① 三步走。
3. **端口澄清**：记忆记面板端口 18791，`multi-proxy-manager/server.js` 默认 `PORT=18792`；以 `.env` 为准，先核实再在文档里写死。
4. 复杂度档位（②）依赖 `l2/decomposer.js` 已产 `complexity` 标签（草案 line 19 引用），先确认 decomposer 输出再接 route()。
5. 回源纪律：引用文章数据标"腾讯官方口径/软文"，引用代码标 `file:line`，不编造价表（routeEngine `pricing` 里 `glm-4.5`/`codex` 已显式标 TODO 待补真实价，勿臆造）。

---

_关联文件：`multi-proxy-manager/server.js`、`multi-proxy-manager/lib/forward.js`、`codex-proxy/proxy.js`、`cursor-proxy/src/routing/routeEngine.ts`、`l2/COMPLEXITY-MODE.md`、`l2/route-engine.js`、`l2/agent-registry.js`、`multi-proxy-manager/public/dashboard.html`_
