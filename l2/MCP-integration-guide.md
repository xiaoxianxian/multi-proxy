# MCP 接入指南 — L2 编排能力消费（DS2 之前的可消费面）

> 受众：想用 MCP（Model Context Protocol）消费 multi-proxy L2 编排能力的外部 agent / 客户端作者。
> 这是 **DS2 之前 DSH 生态唯一可被消费的入口**（DS2 发 npm bundle 暂缓，等 DSH 0.2；MCP bridge 已就绪）。
> 关联：`l2/mcp-server.js`（实现）· `multi-proxy-manager/routes/mcp.js`（manager 接线）· `docs/03-adr/0004-mcp-bridge.md`（架构决策）· `docs/02-product/dsh-integration.md`（DSH 接入分层）。
> 更新：2026-09-23。

---

## 0 一句话定位

L2 把「任务拆解 + DAG 编排 + 路由」能力包成一个 **JSON-RPC 2.0 over stdio** 的 MCP server，
通过门控 `PROXY_L2_MCP` 默认关。开启后，任何 MCP 客户端（Claude Desktop / Cursor / 自研）可经 stdio 调三个 L2 工具：
**`routeTask` / `decompose` / `orchestrate`**。

---

## 1 门控（默认关，非侵入铁律）

| 门控 | 默认 | 行为 |
|---|---|---|
| `PROXY_L2_MCP` | `0`（关） | 关时 bridge 拒启动 / 路由 403，热路径零副作用 |
| `PROXY_ADAPTER_REAL` | `0`（关，二级门控） | 关时 `orchestrate` 恒 **shadow**（只算路由决策，不触下游 adapter） |

> 门控关 = 不改变任何现状。开启 = 显式 opt-in。两个门控独立，`PROXY_L2_MCP` 管 bridge 开/关，`PROXY_ADAPTER_REAL` 管是否真执行。

---

## 2 两种消费方式

### 方式 A：stdio 直联（外部 MCP 客户端）

MCP server 以 stdio 形式运行。直接：

```bash
# 启动（门控必须开，否则 throw 'mcp gate closed'）
PROXY_L2_MCP=1 node l2/mcp-server.js
# 需要编排真执行（仍非侵入，无注入 executor 时退化为「仅路由」）：
PROXY_L2_MCP=1 PROXY_ADAPTER_REAL=1 node l2/mcp-server.js
```

- 入口：`l2/mcp-server.js` 底部 `require.main === module`（`startStdioAsync()`，drain-on-EOF，丢响应保护）。
- seed：默认 seed 本地 adapter（h3web/codex）+ 三档 text-tier profile（agnes=small / deepseek=medium / qwen=large），
  与 manager 接线共用 `l2/mcp-default-seed.js` 单一来源。
- 客户端侧把 multi-proxy 当作一个 MCP server，填到客户端的 MCP server 配置（stdio 形式，`command: node` + `args: [绝对路径 l2/mcp-server.js]` +
  `env: PROXY_L2_MCP=1`），即可消费。各客户端 UI 配置形式见其自身文档；本指南不臆造具体 UI 步骤。

### 方式 B：经 manager（HTTP，已接线）

manager（`multi-proxy-manager`）已把 bridge 接到 `/api/mcp`（`routes/mcp.js`，门控 `PROXY_L2_MCP` 默认关）：

```bash
# 开启 manager 的 MCP 接线
PROXY_L2_MCP=1 node multi-proxy-manager/server.js
```

| 端点 | 作用 |
|---|---|
| `GET /api/mcp` | 门控状态 + 已注册 MCP 工具列表（能力快照） |
| `GET /api/mcp/health` | 探活：`{status, gate, protocolVersion, toolCount}` |
| `POST /api/mcp/call` | 调工具 `{name, arguments?}` → 转 `callTool`（shadow） |
| `POST /api/mcp/rpc` | 透传一条 JSON-RPC 2.0 消息 → `handleMessage`（兼容外部 MCP 客户端） |

门控关时全部 403。外部 MCP 客户端可经 HTTP（`/api/mcp/rpc`）透传 JSON-RPC 消息，不必 stdio 直连进程。

---

## 3 三个 L2 工具（输入/输出）

> 以下为核实自 `l2/mcp-server.js` `listTools()` 的真实 schema；`orchestrate` 为 async（经 `callToolAsync`/`handleMessageAsync` 暴露），
> 其余同步。门控关默认 shadow。

### `routeTask` — 路由决策
- **入参**：`type`（必需，`text/code/video/audio/image`）· `prompt` · `agent`（可选偏好）· `complexity`（`low/medium/high`，驱动模型档位：low→small / high→large / 其余→medium，与 `COMPLEXITY-MODE.md §2.2` 对齐）
- **出参**：`{task, shadow:true, route:{chosen, candidates, fallback, reason}}` —— 影子路由决策，不真执行。

### `decompose` — 请求拆解成子任务 DAG
- **入参**：`input`（必需，如「做一个视频短片」/「jwt 认证」）
- **出参**：`{template, subtasks, edges}` —— 同步、确定性、规则化、零 LLM 的拆解。

### `orchestrate` — 跑一个 DAG（或先拆解再跑）
- **入参**：`input`（请求，与 `dag` 二选一）· `dag`（预建 DAG，跳过拆解）· `shadowMode`（默认 true 除非 `PROXY_ADAPTER_REAL` 开，可 per-call 强制）· `maxRetries`（默认 1）· `llm`（LLM 拆解，仅当 `PROXY_LLM_DECOMPOSE` 开）
- **出参**：`{template, subtasks, report}` —— async（DAG 并发调度）。门控关恒 shadow，只产调度/路由决策，不触真实 adapter。

> 工具名核实：`l2/mcp-server.js:112/135/146`。`registry.get` 对未知 adapter 名抛 → 转 `-32602`（带 available 列表）。

---

## 4 典型调用（JSON-RPC over stdio）

```jsonc
// initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
// 列工具
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
// 路由一个任务
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"routeTask","input":{"type":"video","complexity":"high","prompt":"做 30 秒产品短片"}}}
// 编排（async；经异步通道，drain-on-EOF 保护响应不丢）
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"orchestrate","input":{"prompt":"搭一个认证服务"}}}
```

经 manager 时，等价于 `POST /api/mcp/call`（同步工具）/ `POST /api/mcp/rpc`（透传任意 JSON-RPC，含 async）。

---

## 5 非侵入保证（务必知）

- 门控默认关，开 = 显式 opt-in，不改变现状。
- `orchestrate` 即便 `PROXY_ADAPTER_REAL=1`，无注入 executor 时退化「仅路由」，**绝不触下游 adapter / 不写 agent 文件**。
- 不接收/不落用户 prompt 原文到持久存储（非侵入铁律，见 `AGENTS.md`/`docs/03-adr/`）。

---

## 6 与 DSH 生态的关系

| 入口 | 状态 | 说明 |
|---|---|---|
| MCP bridge（本指南） | ✅ 就绪 | DS2 之前唯一可消费面 |
| DSH `.dsh/skills/`（DS1） | ✅ 完成 | 2 个 SKILL 骨架（`multi-proxy` / `l2-orchestrator`） |
| DSH npm bundle（DS2） | ⏸ 暂缓 | 等 DSH 0.2 + 包规范，见 `docs/02-product/bundle-design.md §6`（cordis.patch.yml 草稿已备） |

DS2 落地后，MCP bridge 与 `cordis.patch.yml` 二选一：bundle 走 `dsh plugin add` 自动注入，stdio/HTTP 保留为底层兼容通道。

---

_本指南全部事实核实自 `l2/mcp-server.js` / `routes/mcp.js` / `COMPLEXITY-MODE.md`（2026-09-23）。_
_客户端 UI 具体配置以各客户端自身文档为准，本指南不臆造。_
