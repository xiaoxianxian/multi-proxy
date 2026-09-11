# Proxy Rebuild — 迭代路线图（基于 Anthropic Prove2Me 启发）

> 来源：2026-09-09，阅读 Anthropic Prove2Me 费马大定理证明博客及社区讨论
> 目标：将「多 agent 协调机制」的核心洞察转化为 proxy-rebuild 可落地的迭代方向
> 状态：规划阶段，未实现

---

## 一、背景与核心洞察

Anthropic 用 Claude agents 在 11 天内完成费马大定理的 Lean 形式化证明（1300万行，3万+定理）。关键发现：

> **瓶颈不在模型能力，而在协调机制。** 第一次尝试失败不是因为模型不够强，而是 agents 没有共享的任务依赖视图，互相重复工作、丢失上下文、踩彼此的进度。修正是引入 Prove2Me——一个维护 DAG 依赖图、分离验证与执行、共享经过验证的产物的协调层。

proxy-rebuild 是多 proxy 管理服务（manager + codex/hermes/cursor 三个 proxy），同样是多组件协调系统。虽然规模远小于定理证明，但**协调问题的结构是相似的**：

| 定理证明的痛点 | proxy-rebuild 的对应 |
|--------------|---------------------|
| agents 丢失全局状态 | manager 只检测端口，不知"为什么挂了" |
| agents 重复做同一工作 | 多个 proxy 同时遇到同一 provider 故障，无法协调切换 |
| 没有结构化错误历史 | 同样的问题反复出现，无检索机制 |
| 冲突靠架构避免 | 已有 `agent-proxy-switch`，但可以更智能 |

---

## 二、三个迭代方向

### 方向一：DAG 健康依赖图（优先级：中）

**现状：**
- manager 通过 `lsof` 端口检测判断 proxy 是否运行
- proxy 挂了 = 显示"未运行"，没有根因区分

**目标：**
把扁平的健康检查升级为有结构的依赖树，让 manager 能说出"是什么坏了"而不是"坏了"。

**依赖关系设计：**
```
multi-proxy-manager (18792)
├── codex-proxy (18790)
│   ├── Node.js 进程存活
│   ├── providers.json 可读且合法 JSON
│   └── 至少一个 provider 连通（test-connection 可选）
├── hermes-proxy (18793)
│   ├── Python 进程存活
│   └── providers.json 可读
└── cursor-proxy (18794)
    ├── Node.js 进程存活
    ├── better-sqlite3 native module 可用
    └── SQLite 数据库可读写
```

**实现要点：**
1. 每个 proxy 暴露 `/api/health` 端点，返回分级状态：`{ status: "ok"|"degraded"|"down", checks: { process: true, config: true, dependency: false } }`
2. manager 轮询时不再只问"端口在不在"，而是调 `/api/health` 拿到结构化结果
3. dashboard 展示从"绿色/红色圆点"升级为"带原因的标签"（如 `better-sqlite3 缺失 → 需 npm rebuild`）
4. 数据存储：`~/.multi-proxy-manager/health-history.jsonl`，每次检查结果追加一行，便于回溯

**与现有代码的关系：**
- `server.js` 中 `isProcessRunning()` 逻辑需要扩展为 `checkProxyHealth(proxyName)`
- `manage.sh` 的 status 命令可复用新逻辑
- 不影响现有测试基线（630 个测试），属于新增端点

---

### 方向二：动态重新规划（优先级：高）

**现状：**
- routing mode 有 Round Robin 和 Failover 两种，但切换需要手动操作
- provider 故障时没有自动降级或切换机制
- proxy 反复崩了就是崩了，没有"自动尝试恢复"的逻辑

**目标：**
让系统的规划（路由策略、provider 选择、proxy 启停）成为执行的一部分，而不是静态配置。

**具体能力：**

#### 2a. Provider 故障自动标记与隔离
- 当 `test-connection` 连续 N 次失败，自动将该 provider 标记为 `unhealthy`
- Round Robin 模式下自动跳过 unhealthy provider
- Dashboard 显示"X 个 provider 被临时隔离（最后失败：Y分钟前）"
- 可配置自动恢复时间（如 5 分钟后重新试探）

#### 2b. 跨 Proxy 的故障感知
- 如果 codex-proxy 和 hermes-proxy **同时**报告同一个 provider 不可用，manager 升级为"全网故障"而非单个 proxy 故障
- 减少误报：单个 proxy 的网络抖动 vs 真实 provider 宕机

#### 2c. 健康检查驱动的自动重启策略
- 当前崩溃恢复靠外部监控，可以在 manager 内部加轻量重启逻辑
- 策略：连续重启 3 次仍失败 → 标记为"需人工介入"，不再自动重启
- 避免死循环重启消耗资源

**实现要点：**
1. 新增 `provider-health.json` 存储每个 provider 的健康状态和时间戳
2. `test-connection` 端点成功后更新状态，失败时累计连续失败次数
3. manager 定时器（每 30s）扫描 unhealthy provider，达到恢复时间后重新试探
4. Dashboard 新增"Provider Health"区块

**与现有代码的关系：**
- `/api/test-connection` 端点已有，需改造为持久化健康状态
- `routing-mode.json` 已存在，可扩展为包含 provider 健康状态的完整路由决策
- 需要新的定时任务模块（可独立文件 `health-scheduler.js`）

**M2 实现进度 + 卡点（2026-09-11）：**

> 现状：**2a/2b 核心已落地，3a 已存在，自动动作 + 定时器 + UI 仍待做（gated）。**
>
> 已落地（commit `bb45837`）：
> 1. `lib/provider-health.js` — `recordProbe(providerId, ok, {source})` 连续 N 次失败(默认 3)标记 `unhealthy` + `unhealthyUntil=now+5min`；纯记录/判定/聚合，**绝不触碰 providers.json、不改路由、不 flip enabled**。`correlateCrossProxy` 实现 2b：窗口内 ≥ `crossProxyThreshold`(默认 2) 个不同 proxy 报同 provider 失败 → `network-wide`，否则 `single-proxy`。状态持久化到 `~/.multi-proxy-manager/provider-health.json`（可注入时钟/文件，13 单测全绿）。
> 2. `routes/proxy-api.js` 的 `POST /test-connection` 加 2 行 `recordProbe` 接线（加性、不改响应契约/路由顺序），用真实探活结果喂健康状态。
> 3. 测试 420/420（+13）基线不破坏；live 冒烟验证状态机 + 聚合 + 落盘。
>
> 已存在（无需重做）：**2c proxy 崩溃恢复** —— `process-manager.js` 的 `proxyCrashRecovery` + `crash-recovery.json` + "连续 3 次熔断→需人工介入" 已实现。
>
> **卡点 / Deferred（高后果 + 真实流量，需 gated + sign-off，本轮不做）：**
> 1. **自动 `enabled=false` / Round-Robin 跳过**：2a 原文的"自动标记 enabled=false"与 M6 ① 同构——**误禁用 provider 会重排全局路由**， blast radius 大于单纯 failover。决策：本轮 `PROXY_HEALTH_ISOLATE` 门控默认关 = observe-only，自动隔离留到独立 sign-off + live 回归。
> 2. **定时调度器**（实现要点③每 30s 扫描）：自动发起 probe = 真实打上游（扣费 / 触发上游限流），高后果，defer。本轮只把 probe 挂在**用户手动 test-connection**上（零新增流量）。
> 3. **Dashboard "Provider Health" 区块**（实现要点④）：UI 未做，数据已就绪（`listIsolated()` / `correlateCrossProxy()` 可直接供前端）。
> 4. **2b 依赖 2a 先持久化**：`provider-health.json` 已落地，2b 聚合即可用——此依赖已解除。
>
> **决策记录**：自动动作类（enabled=false / 跳过 / 自动 probe）统一走 `PROXY_HEALTH_ISOLATE` gated 默认关，与 M6 ① 的安全姿态一致——observe 是稳态终点，执行动作需显式开启 + live 回归。

---

### 方向三：错误模式检索与复用（优先级：低，长期）

**现状：**
- 日志存在各 proxy 的日志文件中，按时间线性排列
- 没有结构化的错误分类和检索能力
- 同样的问题（如 `ETIMEDOUT`、`ECONNREFUSED`、`better-sqlite3` 版本不匹配）可能反复出现

**目标：**
建立错误模式库，让系统能从历史错误中学习，快速诊断和推荐修复方案。

**具体能力：**

#### 3a. 错误模式库
- 定义常见错误的 pattern 和对应的知识条目：
  ```json
  {
    "id": "better-sqlite3-mismatch",
    "pattern": "Error: The module.*better-sqlite3.*was compiled against a different Node.js version",
    "resolution": "运行 npm rebuild better-sqlite3（见 P1 已知问题）",
    "first_seen": "2026-07-03",
    "occurrences": 3
  }
  ```
- 错误模式存储在 `~/.multi-proxy-manager/error-patterns.json`

#### 3b. 日志结构化
- 各 proxy 的日志除了原始文本，同步写入结构化条目到 `error-history.jsonl`
- 条目格式：`{ timestamp, proxy, error_type, pattern_id, raw_message, resolution_hint }`
- Dashboard 新增"常见问题"面板，按频次排序展示最近的高频错误

#### 3c. 自然语言搜索（可选，远期）
- 像 Prove2Me 用自然语言描述 theorem 以便搜索复用
- 未来可以加：在 logs 页面支持"搜之前的 ETIMEDOUT 怎么解决的"
- 实现方式：简单的关键词匹配即可，不需要 LLM（符合简洁优先原则）

**实现要点：**
1. 先在 `error-patterns.json` 预置 10-15 个已知模式（从历史 handover 文档中提取）
2. proxy 在 catch 块中匹配 pattern，写入结构化日志
3. manager 提供 `/api/errors/patterns` 和 `/api/errors/history` 端点
4. logs.html 新增"错误模式"Tab

> **M4 现状 + 卡点（2026-09-11，老板可决策）**
>
> - **3a 错误模式库 ✅**：`lib/error-patterns.js`，8 个**真实种子**（better-sqlite3 / EPERM / ECONNREFUSED / ETIMEDOUT / EADDRINUSE / MODULE_NOT_FOUND / ENOENT / Hermes 误报），全部从 CLAUDE.md / P0-FIXES / HANDOVER 真实错误提取，非臆造
> - **3b 结构化历史 ✅ 数据层**：`recordError → error-history.jsonl`（jsonl + 裁剪，与 health-history 同策略）+ 频次持久化
> - **3c 检索 ✅ 数据层**：`getPatterns / getHistory / searchHistory`（纯字符串，不靠 LLM）；`/api/errors/*` 端点就绪
> - **16 单测 ✅**：匹配 / 历史 round-trip / 检索 / 频次 / 种子完整性 / 正则容错全绿
> - **接 manager error log ✅ 已接入**：`appendLog` 的 error 分支 → `recordError`（best-effort，不阻塞主日志流）；jest setup `setLogFile/setHistoryFile/setPatternFile` 全部重定向到 tmp，**测试零污染**（17 套件确认），测试用 `persist:false` 规避写盘
> - **3c 前端「常见问题」面板 ✅ 已落地**：`logs.html` 折叠面板（8 条模式卡片 + 250ms 防抖搜索 + 复制修复），`/api/errors/patterns` 已注册挂 `/api` 前缀（LIVE 冒烟确认返回 8 条）
> - **已知竞态 ⚠️**：`bumpPatternFreq` 写 `error-patterns.json` 与 `loadPatterns` 种子合并，多 worker 并发需加锁（低频场景先单进程）
>
> **共通卡点（高后果动作 gated，M2/M4 一致）**：自动 `enabled=false`（重排全局路由）/ 自动定时探活（真打上游，扣费限流）/ error log 接线（需测试隔离）——均默认关，须 sign-off。

**M4 完成标志：**
- 8 个种子模式命中真实历史错误文案 ✅
- 结构化历史持久化 + 检索 ✅
- 16 单测全绿 ✅
- 接 manager error log ✅（3b 持久化 + 测试隔离，436/436 无破坏）
- 前端「常见问题」折叠面板 ✅（logs.html 8 条模式卡片 + 搜索 + 复制修复，LIVE 冒烟确证）

> 用户场景：日常「写代码做项目 / 写公众号 / 调 API」混用，希望不同任务自动派发给性价比最高的可达节点。
> 现状：路由引擎原本只做 failover/round-robin，内容感知派发是空接口。2026-09-11 已完成 4a/4b/4c 引擎 + 默认四层配置 + shadow 观测（`PROXY_ROUTING_SHADOW=1` 仅观测，不改真实路由），4d 候选集「健康信号接线」需先定 model→provider 健康映射，待定。详见下方实现进度。
>
> **① 影子转真实评估结论（2026-09-11，已评估不可安全落地）：**
> 1. **failover-only 语义 = 永真 no-op**：`findProviderConfig` 仅在「零启用 provider」时返 null；有 provider 时 round-robin / failover-model 路径都返回【某个】provider 而非 null——故「主路径 null 才用引擎」的 failover-only 接线在任何现实状态下都不改变结果（实测确认，曾尝试接线后回退，勿重做）。
> 2. **唯一能改真实行为的是 override 主路径语义**：但需先对齐 DB model 名与 fallbackChain——现 DB 仅有 `deepseek-v4-pro / agnes-2.5-flash / qwen3.8:27b-mlx`，而 fallbackChain 的 `qwen3.8-flash / deepseek-v4.1-flash` 在 DB 根本不存在，引擎建议会指向无 provider 的目标。
> 3. **故 ① / 4d 均卡在「语义决策（override vs failover 仅兜底）+ DB 对齐」上，属老板 sign-off 项，非可独立完成的代码活。** 在语义拍板 + DB 对齐前，维持 shadow 观测态即可。

---

**M6 完整依赖清单（接真实路由前的前置，按顺序）：**

| # | 依赖项 | 状态 | 说明 / 归属 |
|---|--------|------|------------|
| D1 | 引擎核心（4a/4b/4c + 默认四层配置） | ✅ 已完成 | `routeEngine.ts` / `taskClassifier.ts` / `ruleEvaluator.ts`，111 测试全绿 |
| D2 | 影子观测层 | ✅ 已完成 | `routing-shadow.ts` + `chatHandler:205`，`PROXY_ROUTING_SHADOW=1` 只观测不改真实 |
| D3 | ① 安全不变式测试 | ✅ 已完成 | `chat-handler-shadow.test.ts`：on/off 上游逐字节一致 |
| **D4** | **语义决策：override vs failover-only** | ⛔ **老板 sign-off** | failover-only 已证 no-op（见上）；唯一有效的是 **override 主路径**。需拍「引擎能否覆盖老板已配 provider」——决定请求去向，不可机器代决 |
| **D5** | **DB model 名 ↔ fallbackChain 对齐** | ⛔ **待办（卡 D4）** | DB 现有 `deepseek-v4-pro / agnes-2.5-flash / qwen3.8:27b-mlx`；链上 `qwen3.8-flash / deepseek-v4.1-flash` 不存在 → override 必 404。需补 provider 或改链上模型名 |
| **D6** | **4d 健康信号接线** | ⛔ **待办（卡语义）** | `HealthMonitor` 按 provider **id** 记健康，候选按 **model 名** 排序 → 需定 model→provider 健康映射 + 补候选集构建 |
| D7 | live 回归测试 | ⛔ 接真实后做 | 翻 override 前，先证「coding 请求确实改走 deepseek-v4.1-flash 且上游 200」 |

**结论：D1-D3 已交付并测试；D4-D6 是老板决策 + 数据对齐，非纯代码活。D7 在 D4-D5 落地后做。当前 shadow 观测态已是稳态终点，非中途。**

**现状（精确对应代码，2026-09-11 更新）：**
- `cursor-proxy/src/routing/` 已完整落地 4a/4b/4c + 默认四层配置（`routeEngine.ts` / `taskClassifier.ts` / `ruleEvaluator.ts` / `routing-shadow.ts`），111 测试全绿。
- `getNextRoute(taskType, model, config, ctx?)` 已实现 `cost-optimization`（最便宜且健康者）+ `round-robin`（按 config.id 分桶，D12 已修）+ `priority`；`evaluateRules` 已接白名单受限表达式求值（禁 eval）。
- 引擎经 `routing-shadow.ts` 的 `routeShadow(model, messages)` 挂到 `chatHandler:205`，`PROXY_ROUTING_SHADOW=1` 只观测、不改真实路由（`findProviderConfig` 零改动）。
- **接真实路由的前置见上方「M6 完整依赖清单」D4-D6（语义 + DB 对齐 + 健康映射），属老板决策项。**

**目标：**
在 failover/round-robin 之外增加一层**内容感知派发**：看懂每次请求的性质（编码/写作/多模态/廉价），自动送到性价比最高的可达节点。

**具体能力：**

#### 4a. 轻量任务分类 `classifyTask(messages)`
- 不引入新依赖，基于消息特征做关键词 + 结构启发式分类，输出枚举：`coding | writing | vision | cheap | general`。
- 判定维度（按优先级短路）：
  1. `vision`：messages 含 `image_url` / 文件附件 / 提及「图/截图/识别」→ 多模态模型（如 GLM-5.3-Flash）。
  2. `coding`：含代码块、文件路径（`src/`、`*.ts`）、`git`/`compile`/`bug`/`refactor` 等关键词、或 prompt 以「实现/修复/写函数」开头。
  3. `writing`：长文本、含「公众号/文章/润色/总结」类词、无明显代码符号。
  4. `cheap`：短问答、翻译、格式化等低价值任务。
  5. 兜底 `general`：走 `defaultModel`。
- 成本控制：分类在 proxy 入口做**一次**（请求级），结果随路由上下文下传，不重复计算。

#### 4b. 规则条件求值 `evaluateRules`
- 真正实现 `RoutingRule.condition` 的求值。
- `condition` 设计为**安全受限表达式**（禁止任意 eval），推荐轻量解析：
  - 支持 `taskType == 'coding'`、`model.contains('vision')`、`provider == 'glm'` 这类原子判断 + 简单 AND/OR。
  - 实现：维护 `allowedFields`（taskType / model / provider / messageLength）+ 白名单函数表，自写约 30 行递归下降/正则解析器。**不要用 `eval()` / `new Function()`**（注入风险）。
- 命中规则返回 `rule.targetProvider`，再继续走该 provider 的 failoverChain。

#### 4c. cost-optimization 策略
- 实现 `strategy === 'cost-optimization'` 分支：对每个候选 provider 算
  `预估花费 = 输入单价 × 预估输入tokens + 输出单价 × 预估输出tokens`
  （单价来自 providers.json 新增的 `pricing` 字段；预估 tokens 用 `messages.length` 粗算或 tokenizer 近似）。
- 取花费最低且**健康检查可达**的节点；最低价节点 unhealthy 则依次取下一个。
- 可与 4a 组合：先按 taskType 收窄候选集，再在候选集内选最便宜。

#### 4d. 默认 RouteConfig 示例（四层：Qwen3.8-Flash 默认 → DeepSeek V4.1 Flash 重编码溢出 → Agnes 免费兜底 → 本地离线）

> 对应老板真实在用的模型（2026-09-10 更新）：Qwen3.8-Flash（阿里新发，强且便宜，开源）、DeepSeek V4.1 Flash（今日发布，能力超越 V4-Pro 且降价，缓存命中 ¥0.02）、Agnes-2.5-flash（免费但有配额）、本地 qwen3.8（Ollama，离线/隐私）。
> 设计原则：**日常强且便宜用 Qwen，重编码啃 DeepSeek 缓存红利，琐碎白嫖 Agnes，云端全挂用本地**。

```json
{
  "id": "default-four-tier",
  "defaultModel": "qwen3.8-flash",
  "fallbackChain": ["qwen3.8-flash", "deepseek-v4.1-flash", "agnes-2.5-flash", "qwen3.8:27b-mlx"],
  "rules": [
    { "id": "r-cheap",   "condition": "taskType == 'cheap'",   "targetProvider": "agnes-2.5-flash" },
    { "id": "r-coding",  "condition": "taskType == 'coding'",  "targetProvider": "deepseek-v4.1-flash" },
    { "id": "r-writing", "condition": "taskType == 'writing'", "targetProvider": "qwen3.8-flash" },
    { "id": "r-vision",  "condition": "taskType == 'vision'",  "targetProvider": "qwen3.8-flash" },
    { "id": "r-private", "condition": "privacy == true",       "targetProvider": "qwen3.8:27b-mlx" },
    { "id": "r-hard",    "condition": "quality == 'high'",     "targetProvider": "deepseek-v4.1-flash" }
  ],
  "maxRetries": 3,
  "strategy": "cost-optimization"
}
```

**四层如何联动（关键，结合方向二）：**
- **Tier 1 强且便宜默认档**：`qwen3.8-flash` 单价 ¥0.8/¥2.7、1M 上下文、多模态、权重开源。日常写作/多模态/通用默认走它——与 GLM-5.3-Flash 同分（SuperCLUE-Terminal 48.48）但更便宜更快、token 更少。
- **Tier 2 重编码溢出档**：`deepseek-v4.1-flash` 闲时 ¥1/¥4，**缓存命中仅 ¥0.02**（全市场最低之一）。coding agent 反复带同一份系统提示+代码库上下文跑，命中后成本比 GLM（¥0.23）低一个数量级。今日发布、能力超越 V4-Pro 且降价，是重活的性价比之王。
- **Tier 3 免费兜底档**：`agnes-2.5-flash` 单价 ¥0，但免费档有配额（约 1500 次/5h、15000 次/周）。琐碎低价值任务（r-cheap）白嫖它；配额打满时方向二健康检查标 `unhealthy`，自动溢出到付费档。
- **Tier 4 离线/隐私兜底**：Agnes 与云端都不可达（断网/订阅过期/限流）时，`fallbackChain` 末位 `qwen3.8:27b-mlx`（Ollama `localhost:11434`）兜底，离线/隐私场景零依赖。
- **显式规则**：`privacy == true` 直接走本地；`quality == 'high'`（硬骨头，如大仓库重构/复杂算法）直接走 DeepSeek V4.1 Flash 啃缓存红利，跳过白嫖档。

**providers.json 需补充的字段（供 4c cost-optimization 查单价 + 方向二记配额）：**
```json
{ "id": "qwen3.8-flash",      "type": "cloud", "pricing": { "input": 0.8, "output": 2.7, "cacheHit": 0.1 },   "rateLimit": null },
{ "id": "deepseek-v4.1-flash","type": "cloud", "pricing": { "input": 1,   "output": 4,   "cacheHit": 0.02 },  "rateLimit": null, "note": "闲时价；高峰翻倍 ¥2/¥8" },
{ "id": "agnes-2.5-flash",    "type": "cloud", "pricing": { "input": 0,   "output": 0,   "cacheHit": 0 },     "rateLimit": { "per5h": 1500, "perWeek": 15000 } },
{ "id": "glm-5.3-flash",      "type": "cloud", "pricing": { "input": 0.8, "output": 2.8, "cacheHit": 0.23 },  "rateLimit": null },
{ "id": "qwen3.8:27b-mlx",      "type": "local", "baseUrl": "http://localhost:11434/v1", "pricing": { "input": 0, "output": 0, "cacheHit": 0 }, "rateLimit": null }
```

**实现要点：**
1. `getNextRoute()` 签名扩展为 `getNextRoute(taskType, modelName, config)`，调用方在 proxy 入口算好 `taskType` 后下传。
2. 先 `evaluateRules(config.rules, ctx)` → 命中走 `targetProvider`；否则按 `strategy` 分支（round-robin / priority / cost-optimization）。
3. `cost-optimization` 需 providers.json 增加 `pricing: { input, output, cacheHit }`（每百万 tokens，人民币），路由时查表。
4. 修复 D12 共享索引 bug：round-robin 索引改为**按 `config.id` 分桶**（`Map<string, number>`），避免跨 proxy 串号。
5. 分类逻辑放 `src/routing/taskClassifier.ts`，规则解析放 `src/routing/ruleEvaluator.ts`，保持 `routeEngine.ts` 单一职责。

**与现有代码关系：**
- 仅扩展 `routeEngine.ts` + 新增两个小文件 + providers.json 加 `pricing` 字段；不改动现有 round-robin/priority 行为（向后兼容）。
- 不破坏现有 630 个测试；新增逻辑走独立单元测试。
- 风险点：condition 解析器若用 eval 会有注入风险——**强制用白名单解析器**。

**与方向二的关系：**
- 方向二是"provider 故障维度"的协调（健康/隔离/重启）；方向四是"请求内容维度"的派发（任务类型）。两者正交，可叠加：先 4a/4b 选目标 provider，再交方向二的 failover/health 机制兜底。

---

## 三、实施优先级与里程碑

| 阶段 | 内容 | 预估工作量 | 依赖 | 状态（2026-09-11）|
|------|------|-----------|------|------|
| **M1** | 方向一：DAG 健康依赖图 | 2-3 天 | 无 | ✅ 完成（`bb01ef0`，manager 420 绿）|
| **M2** | 方向二 2a+2b：Provider 故障标记 + 跨 proxy 感知（observe） | 1-2 天 | M1 | ✅ 核心完成（`bb45837`）；**自动隔离/enabled=false 默认 gated（`PROXY_HEALTH_ISOLATE` 关）** |
| **M3** | 方向二 2c：自动重启策略 | 1-2 天 | M2 | ✅ 已有（`process-manager.js` 连续 3 次熔断，无需重做）|
| **M4** | 方向三 3a+3b：错误模式库 + 结构化日志 | 2-3 天 | 无（可并行）| ✅ 完成（3a/3b/前端面板）；全矩阵 646 绿 |
| **M5** | 方向三 3c：日志页面「常见问题」面板 | 1 天 | M4 | ✅ 完成（logs.html 折叠面板 + 搜索 + 复制修复）|
| **M6** | 方向四：按任务类型智能派发（4a+4b+4c + shadow） | 2-3 天 | 无 | ✅ 引擎+shadow（`a11a64a`）；**接真实路由 D4-D6 卡老板 sign-off + DB 对齐，defer** |

**建议顺序：M1 → M2 → M4 → M3 → M5 → M6（M6 可与前序并行）**

理由：
- M1 是基础设施，所有后续方向都依赖结构化的健康信息
- M2 能立即改善用户体验（少几次手动切 provider）
- M4 是长期资产，越早建越好，且与 M2 不冲突可并行
- M3 涉及自动重启策略，风险较高需等 M1/M2 稳定后再做
- M5 是 UI 层，依赖后端数据
- M6 是内容感知派发，独立于健康/故障维度，可在任何阶段插入，且直接对应"不同任务自动选模型"的用户诉求

---

## 四、与现有架构的兼容性说明

所有迭代方向均遵循以下原则：

1. **不破坏现有 630 个测试**：新增端点和逻辑独立于现有路由
2. **配置向后兼容**：新的健康状态文件不干扰现有 `providers.json` / `routing-mode.json`
3. **渐进式启用**：新功能默认关闭，通过环境变量或配置开关启用
4. **不引入新外部依赖**：全部使用 Node.js/Python 标准库 + 现有依赖（express, better-sqlite3）

---

## 五、参考资料

- [Anthropic: Formalizing Fermat's Last Theorem in Lean](https://www-cdn.anthropic.com/9e431dff043da6538d99d6c2d231b670aa3da263.pdf)
- [Prove2Me (Columbia University)](https://github.com/tpeng1113/prove2me)
- [dev.to 分析：AI Agents Failed to Prove Fermat's Last Theorem](https://dev.to/jamilxt/ai-agents-failed-to-prove-fermats-last-theorem-then-they-got-a-shared-to-do-list-h0k)
- [byteiota: Claude Formalized Fermat in Lean — The Coordination Story Developers Missed](https://byteiota.com/claude-formalized-fermat-in-least-the-coordination-story-developers-missed)

---

*最后更新：2026-09-11（M1/M2/M3/M6 引擎+shadow 落地，630 测试全绿；M4/M5 + 各方向高后果动作 gated defer）*
