# DS2 前置设计:cordis.patch.yml / dsh.bundle 补丁结构（草案）

> 状态：DS1 已完成（.dsh/skills/ 骨架），DS2（npm bundle 发布）按 dsh-integration.md 暂缓（等 DSH 0.2 + #1496 guardrail 修复）。
> 本文件是"等待期提前设计"——把 `cordis.patch.yml` + `dsh.bundle` 的结构先想清楚，DSH 0.2 发布后可快速落地。
> **纯设计，非实施**：不发包、不打 tag、不写 `package.json#dsh.bundle`（仍属 DS2，保持暂缓）。
> 创建：2026-09-18。依据外部一手来源（见文末）。

## 1 官方规范（deepseek-harness bundle/cordis.patch.yml）

`cordis.patch.yml` 是一个 profile patch 层，规范要点（来源：deepseek-ai/deepseek-harness + dsh-plugin-model-proxy npm 包说明）：

- **结构**：顶层是 YAML 数组（patch entries）。`- insert:` 块下挂若干 plugin 行：
```yaml
- insert:
    - id: <loader-entry-id>
      name: <npm 包名 / Cordis 插件名>   # 注意是 name: 不是 module:
      config: { ... }                    # 插件配置
      disabled: false                    # 可选
```
- **`dsh.bundle.patch` 声明**：包的 `package.json` 声明 `dsh.bundle` → `dsh plugin add` 自动把包加进 profile 依赖 + 自动插入对应 insert 行到 `dsh.profile.bundles`，一次激活，无需手写 patch 行。
- **client 自动发现**：browser 端从包的 `dsh.client` 声明自动发现，serve 在 `/plugins/<name>/client.js`。

## 2 参照模板：dsh-plugin-model-proxy（与 multi-proxy L2 同构）

`dsh-plugin-model-proxy`：per `(provider, model)` 路由到不同 proxy（http/https/socks5/socks5h + Settings UI）。功能 = "特定 provider/model 走特定代理，其余直连 + 设置页卡片 + 可观测 status/test"。
这与 multi-proxy L2 路由（orchestrator + cost + alert + 门控）**高度同构**，是最佳设计模板。

其结构（来源：npm 包 dsh-plugin-model-proxy@0.1.2 说明）：
- 顶层 bundle 包，声明 `dsh.bundle.patch`
- host 半边：`installSettingsSection` 注册 `model-proxy` 设置命名空间（applies: live，改配置无需重启）
- host 半边：wrap `globalThis.fetch`（可逆，`ctx.effect` dispose 还原）
- 监听 `llm/stream` waterfall，按 `(provider, model)` 经 AsyncLocalStorage 解析 proxyUrl，注入 dispatcher
- browser 半边：注册 `settings.plugin.item`，由 Plugins tab 自动配对（served ∩ registered）

## 3 已知踩坑（来自社区插件实践，避免重蹈）

1. 文件必须是顶层 YAML 数组；纯注释（无 `- ` 行且无 `[]`）解析失败 → 破每次 boot/dump。
2. loader-entry 的字段是 **`name:`（包名），不是 `module:`**。
3. 新行必须嵌在 **`insert:`** 下；裸 `- id:` 表示"patch 已存在 entry"，不是新增。
4. 只 host 半边是 loader entry；browser 半边从 `dsh.client` 自动发现。**不要**手工加 `<name>/client` 行（会让浏览器代码在 Node 进程里跑）。
5. 有 `dsh.bundle.patch` 就别再手写 patch 行——`dsh plugin add` 已自动注入，重复 = boot 时同 loader id 冲突。
6. **client 端 `exports.inject` 写 Cordis 服务名（slots/settingsScope），不能写包名**——写包名会让插件永久 pending 卡死 web boot（LucienLL/dsh-plugin-proxy 的 LESSONS.md 记录）。
7. 设置页白名单限制：`WEB_SETTINGS_NAMESPACES`（dsh-host-apiproxy）硬编码，第三方命名空间需手动加（dsh 官方列为延后）→ multi-proxy 若暴露设置卡片需知此限制。
8. 测试需 `@deepseek-ai/*` peer 依赖 + undici（junction 到 DSH profile node_modules 或 pnpm install）。

## 4 multi-proxy 接入设计映射（草案，DSH 0.2 后落地）

- L2 内核（orchestrator / cost / alert / gate）→ 封装为 Cordis 插件
- `dsh.bundle.patch` 声明 `insert:` 行 id/name/config（参考 dsh-plugin-model-proxy 结构）
- 配置写入 `insert` 行的 `config:` 层（applies: live，对应门控 gate/cost/alarm）
- host 半边：注册设置命名空间 + wrap fetch（可逆）；browser 半边：设置卡片（注意白名单限制）

### 4.1 内核模块 → Cordis 插件映射（草案）

映射依据（2026-09-18 `ls l2/*.js` + `multi-proxy-manager/lib` 实测清单）：

| L2 模块 / 落点 | 当前职责 | 候选 Cordis 插件（id） | 半边 | config 映射（门控 env） |
|---|---|---|---|---|
| `l2/orchestrator.js` + `decomposer.js` | 任务拆解 → DAG 调度 | `multi-proxy-orchestrator` | host（wrap `llm/stream` waterfall） | — |
| `l2/agent-registry.js` | agent 能力/模型类型注册 | `multi-proxy-registry` | host | `agent-profile.json` 注入 |
| `l2/route-engine.js` | modelType/能力路由 | 并入 orchestrator 插件 | host | `PROXY_ROUTE_OVERRIDE`（Q1=A，默认 shadow） |
| `l2/health-monitor.js` + `circuit-breaker.js` + `rate-limiter.js` | 韧性三件套 | `multi-proxy-resilience`（failover middleware） | host（wrap fetch，可逆） | — |
| `l2/alert.js` + `multi-proxy-manager/routes/alert.js` + `lib/{provider-health,error-patterns,cost-track}.js` | 告警（三路信号源：健康/错误模式/成本） | `multi-proxy-alert` | host + settings card | `PROXY_HEALTH_ALERT`（默认 off）、`PROXY_COST_SCHEDULE`（默认关） |
| `l2/cost.js` + `lib/cost-track.js` + `forward.js:168` 埋点 | 成本核算（token×单价） | 并入 alert 插件 `config.cost` 子段 | host | `PROXY_COST_TRACK`（默认关） |
| `l2/plugin-runtime.js` | 「一切皆插件」运行时 | **插件宿主框架**（其余插件挂在其上） | host | — |
| `l2/skill-service.js` + `l2/memory-merge.js` | 技能 / 记忆 | 暂不暴露（二期，见 unknowns U5） | — | — |

**封装原则**（与 dsh-plugin-model-proxy 同构）：host 半边 wrap `globalThis.fetch`（`ctx.effect` dispose 可逆）+ 监听 `llm/stream` waterfall；browser 半边 settings card，受 `WEB_SETTINGS_NAMESPACES` 白名单限制（§3.7）。

**待 DSH 0.2 定稿项**（不臆造，落地时核对）：
- 上述插件 id 命名（`multi-proxy-*`）是否冲突 / 是否符合 DSH 命名规范。
- 4 个 env 门控映射到 Cordis `config` 的 live-applies 层级（对应 §3「applies: live，改配置无需重启」）。
- 设置卡片命名空间需白名单放行（§3.7，dsh 官方列为延后）——若 multi-proxy 要暴露卡片，需协调。

## 5 落地前置（外部依赖，项目无法控制）

- DSH 0.2 稳定（#1496 guardrail 修复：`dsh plugin add` 装错插件可能导致 profile 起不来且无回滚）
- 包规范确认（npm 包名 / 版本 / 构建产物）
- 满足后：本设计 → DS2 实施（`package.json#dsh.bundle` + `cordis.patch.yml` + 封装 L2 为 Cordis 插件 + 测试）

## 6 `cordis.patch.yml` 完整草稿（可直接复制模板，DSH 0.2 后落地）

> 状态：示例草案。**所有插件 id / 字段名 / 门控映射均为占位，DSH 0.2 落地时必须逐条核对**（§7 待核对清单）。
> 设计依据：§4.1 模块映射 + §3 八条踩坑。结构镜像 `dsh-plugin-model-proxy@0.1.2`，不臆造 DSH 0.2 规范。
> **纯文本示例，不写入仓库任何 `cordis.patch.yml` / `package.json`（DS2 实施才写，保持暂缓）**。

### 6.1 `cordis.patch.yml`（profile patch 层）

```yaml
# multi-proxy L2 → Cordis profile patch 草稿（DSH 0.2 后落地）
# 顶层必须是 YAML 数组（踩坑①：纯注释/无 - 行会 boot/dump 失败）
# 注意：字段是 name: 不是 module:（踩坑②）；新行必须嵌 insert: 下（踩坑③）
- insert:
    # 编排内核：任务拆解 + DAG 调度（orchestrator + decomposer + route-engine）
    - id: multi-proxy-orchestrator
      name: multi-proxy-orchestrator          # 是 name: 不是 module:
      disabled: false
      config:
        gate: "PROXY_ROUTE_OVERRIDE"          # 映射 env 门控（live-applies，对应门控 gate）
        shadow: true                          # 默认 shadow，不触下游 adapter（非侵入铁律）
        complexity: { low: small, medium: medium, high: large }   # 与 COMPLEXITY-MODE §2.2 对齐
    # agent 能力/模型注册
    - id: multi-proxy-registry
      name: multi-proxy-registry
      disabled: false
      config:
        profilesFile: "agent-profile.json"    # 注入 agent profile
    # 韧性三件套（failover middleware）—— 与 option2 spec 同构
    - id: multi-proxy-resilience
      name: multi-proxy-resilience
      disabled: false
      config:
        wrap: "globalThis.fetch"              # 可逆：ctx.effect dispose 还原（踩坑④ 封装原则）
        circuitBreaker: { threshold: 5, windowMs: 60000 }
        rateLimiter:   { limit: 100, windowMs: 10000 }
    # 告警（三路信号：健康 / 错误模式 / 成本）+ 成本核算子段
    - id: multi-proxy-alert
      name: multi-proxy-alert
      disabled: false
      config:
        healthGate:  "PROXY_HEALTH_ALERT"     # 默认 off
        costGate:    "PROXY_COST_TRACK"       # 默认关
        costSchedule: "PROXY_COST_SCHEDULE"   # 默认关
        # browser 半边设置卡片（受 WEB_SETTINGS_NAMESPACES 白名单限制，§3.7 需协调）
        settingsCard: true
```

> **不写 `<name>/client` 行**（踩坑④：browser 半边从 `dsh.client` 自动发现，手写会让浏览器代码在 Node 进程跑）。
> **有 `package.json#dsh.bundle.patch` 就别再手写 patch 行**（踩坑⑤：`dsh plugin add` 已自动注入，重复 = boot 时同 loader id 冲突）→ 6.2 的 `dsh.bundle` 与 6.1 二选一。

### 6.2 二选一：`package.json#dsh.bundle`（自动注入形态，推荐）

```jsonc
// 放在 multi-proxy 的 package.json（DS2 实施时；当前 4 个 package.json 均无此字段，保持暂缓）
{
  "name": "dsh-multi-proxy-orchestrator",     // 占位名，DSH 0.2 核对命名规范
  "version": "0.1.0",
  "dsh": {
    "bundle": {
      "patch": [ /* 等价于 6.1 的 insert 数组，此处省略，落地时填 */ ],
      "client": { "export": "settings/plugin.item" }   // 踩坑⑥：写 Cordis 服务名，不写包名，否则永久 pending
    }
  }
}
```

### 6.3 门控 env → Cordis config 映射（live-applies）

| Cordis config 键 | 对应 env 门控 | 默认 | 行为 |
|---|---|---|---|
| `gate` | `PROXY_ROUTE_OVERRIDE`（Q1=A） | shadow | 路由覆写 |
| `shadow` | — | `true` | 不触下游 |
| `healthGate` | `PROXY_HEALTH_ALERT` | off | 健康告警 |
| `costGate` / `costSchedule` | `PROXY_COST_TRACK` / `PROXY_COST_SCHEDULE` | 关 | 成本 |

## 7 待 DSH 0.2 核对清单（不臆造，落地逐条验证）

- [ ] 插件 id `multi-proxy-*` 是否冲突 / 符合 DSH 命名规范。
- [ ] `cordis.patch.yml` 顶层字段名（`insert:` / `id` / `name` / `config` / `disabled`）是否与 0.2 一致——rc 阶段可能变。
- [ ] 门控 env → Cordis `config` 的 live-applies 层级（改配置是否真无需重启）。
- [ ] 设置卡片命名空间是否需 `WEB_SETTINGS_NAMESPACES` 白名单放行（§3.7，dsh 官方延后）。
- [ ] `dsh.bundle.client.export` 写 Cordis 服务名 vs 包名（踩坑⑥，确认不写包名）。

## 8 模块 → DSH service 映射表（§4.1 × §6 交叉一致版 · 据 DeepSeek item3）

> 目的：商业化文档（`bundle-design.md §4.1`）与 `cordis.patch.yml` 草稿（§6.1）的映射**逐行一致**，避免两处漂移。
> **`ctx.multiProxy.<svc>` 服务名一律标「占位·待 DSH 0.2 核对」**——DSH 无公开 service catalog，不臆造官方命名；落地时核对 §7 checklist 后定稿。

| L2 模块 / 落点 | 职责 | 候选 Cordis 插件（id） | 半边 | 门控 env → Cordis config（live-applies） | 提供能力（占位服务名） |
|---|---|---|---|---|---|
| `l2/orchestrator.js` + `decomposer.js` | 任务拆解 → DAG 调度 | `multi-proxy-orchestrator` | host（wrap `llm/stream` waterfall） | `PROXY_ROUTE_OVERRIDE`（Q1=A，默认 shadow） | `ctx.multiProxy.orchestrate`/`decompose`（占位，待 0.2 核对） |
| `l2/agent-registry.js` | agent 能力/模型注册 | `multi-proxy-registry` | host | `agent-profile.json` 注入 | `ctx.multiProxy.registry`（占位） |
| `l2/route-engine.js` | modelType/能力路由 | 并入 `multi-proxy-orchestrator` 插件 | host | `PROXY_ROUTE_OVERRIDE`（默认 shadow） | `ctx.multiProxy.routeTask`（占位，= `orchestrate` 子） |
| `l2/health-monitor.js` + `circuit-breaker.js` + `rate-limiter.js` | 韧性三件套 | `multi-proxy-resilience` | host（wrap `globalThis.fetch`，`ctx.effect` dispose 可逆） | —（默认关，failover 触发时开） | `ctx.multiProxy.resilience`（占位） |
| `l2/alert.js` + `routes/alert.js` + `lib/{provider-health,error-patterns,cost-track}.js` | 告警（健康/错误模式/成本三路） | `multi-proxy-alert` | host + settings card | `PROXY_HEALTH_ALERT`（默认 off）、`PROXY_COST_SCHEDULE`（默认关） | `ctx.multiProxy.alert`（占位，卡 `WEB_SETTINGS_NAMESPACES` 白名单 §3.7） |
| `l2/cost.js` + `lib/cost-track.js` + `forward.js:168` 埋点 | 成本核算（token×单价） | 并入 `multi-proxy-alert` `config.cost` 子段 | host | `PROXY_COST_TRACK`（默认关） | `ctx.multiProxy.cost`（= alert.cost，占位） |
| `l2/plugin-runtime.js` | 「一切皆插件」运行时 | **插件宿主框架**（其余插件挂其下） | host | — | `ctx.multiProxy.host`（= plugin 注册/生命周期） |
| `l2/skill-service.js` + `l2/memory-merge.js` | 技能 / 记忆 | 暂不暴露（二期，见 unknowns U5） | — | — | —（不暴露） |

**一致性保证**：上表每一行的 `id`/`半边`/`门控` 三列与 §6.1 `cordis.patch.yml` 草稿条目**逐字段对应**；§6.3 门控映射表是其 env→config 投影。改 §4.1 必同步本表 + §6.1，三处一致。
**当前消费面**：除 §6 bundle 外，L2 能力现经 **MCP bridge**（`l2/mcp-server.js`，见 `MCP-integration-guide.md`）暴露 `routeTask`/`decompose`/`orchestrate` 三工具——映射表中「提供能力列」的服务名，在 DSH 0.2 bundle 落地前，**已由 MCP 工具兑现**（`routeTask`≈`ctx.multiProxy.routeTask`、`decompose`≈`decompose`、`orchestrate`≈`orchestrate`）。

## 来源（外部，待 DSH 0.2 后按当时版本核对）

- 官方：deepseek-ai/deepseek-harness/packages/bundle/base/cordis.patch.yml + /web-app/cordis.patch.yml
- 参照：github.com/Ye-Yu-Mo/dsh-llm-proxy、npm dsh-plugin-model-proxy@0.1.2、github.com/LucienLL/dsh-plugin-proxy、github.com/superfish058/dsh-llm-proxy
- 抓取时间 2026-09-18，web 搜索快照（非官方文档正文，落地时核对）
