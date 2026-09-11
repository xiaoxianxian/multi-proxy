# Agent Adapter 协议（L2 核心卖点 · 开放接入）

> 区分 L2 与 CC-Switch / codex++ 的本质：不锁定主流 agent，任何能实现本协议的 agent 都能接入/卸载。
# 状态：P0 三模块内核落地（互通性 + Registry + 插件运行时）+ h3web adapter 契约样例（协议可行性验证，非侵入）。
> **真实 h3web 接入（起 8731 服务跑真文生视频）属 P1** —— 见「四、样例落地」。

## 一、四类接口（最小契约）

任意 agent 的 adapter 必须提供：

| 接口 | 方法 | 形态 | 说明 |
|---|---|---|---|
| 能力声明 | `GET /adapter/capabilities` | HTTP | 启动时向 Agent Registry 注册能力标签（code/writing/vision/image/video/audio…） |
| 健康检查 | `GET /adapter/health` | HTTP | 项目探活；返回 `{status, version, capabilities[]}` |
| 任务接收 | `POST /adapter/tasks` | HTTP / MCP / 文件队列 | 至少支持一种；本地 Web 服务（h3web/AIGC）用 HTTP |
| 结果回传 | `GET /adapter/tasks/:id` | HTTP / MCP / 文件 | 取任务结果；含 `state/ result/ error?` |
| 热插拔 | — | 运行时 | adapter 可独立启用/禁用/替换，不重启项目 |

**协议分层（对应蓝图 6.1 决议）**：
- 主流 agent（Codex/Cursor）→ **MCP**（零改造）
- 本地 Web 服务（h3web/AIGC）→ **HTTP**（原生，h3web 需补 `/adapter/*` 桩）
- 通用兜底 → **文件队列**（`~/.agent-queue/<agent>/<task_id>.json`）

## 二、能力声明 schema

```json
{
  "adapter": "h3web",
  "version": "1.0.0",
  "transport": ["http", "mcp"],
  "capabilities": ["video", "image"],
  "supportsTaskQueue": false,
  "healthEndpoint": "/adapter/health"
}
```

## 三、任务契约（adapter 侧）

```jsonc
// POST /adapter/tasks
{ "task_id": "uuid", "type": "generate-video", "params": { ... }, "timeout_ms": 900000 }

// GET /adapter/tasks/:id
{ "task_id": "uuid", "state": "pending|running|done|failed",
  "result": { "video_url": "..." }, "error": null }
```

## 四、h3web 样例落地要点（决策 3，本 P0 不做实现，先定契约）

- h3web（`~/Documents/AI项目/本地部署Minimax H3/h3web.py`，端口实测 **8732**，plist 写 8731 已漂移）
  是 Python 标库 `BaseHTTPRequestHandler`，**非 FastAPI、无 /health** → adapter 需补 `/adapter/*` 桩。
- **铁律④：不写 h3web 任何文件、不改其端口配置**；adapter 是独立进程包住 h3web 的 HTTP，
  端口**动态探测**（探测 8731/8732 谁在 LISTEN），绝不写死。
- 样例边界：P0 只验「能力声明 + /health + 任务提交/结果回传 + 1 真实视频 round-trip」，
  **不碰编排/不碰 shadow**（编排、shadow 属 P2）。

## 五、非侵入铁律（贯穿全协议）

- adapter 对下游 agent **只读**：不写 agent 配置文件，仅"拦住 → 转发 → 注入环境变量"。
- agent 感知不到中枢存在（蓝图 4.4 注入层设计）。
- adapter 自身是项目内插件（蓝图 ②一切皆插件），可热插拔删除/替换。
