# docs/04-tech/api.md — API 接口文档

> 基于 `grep router.app` 真实扫出，不编造。
> 最后验证：2026-09-17，HEAD `d9219af`，main。

---

## 一、Manager API（端口 18792）

前缀：`/api/*`

### 1.1 认证

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/auth/login` | 登录，返回 JWT | 无 |
| GET | `/api/auth/status` | 查询当前登录状态 | 无 |

### 1.2 代理控制

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/proxy-control/status` | 查询所有代理状态 | 无 |
| POST | `/api/proxy-control/start/:name` | 启动代理（codex/hermes/cursor/manager） | 有 |
| POST | `/api/proxy-control/stop/:name` | 停止代理 | 有 |
| POST | `/api/proxy-control/restart/:name` | 重启代理 | 有 |
| GET | `/api/proxy-control/logs` | 获取日志列表 | 有 |
| GET | `/api/proxy-control/logs/raw` | 获取原始日志 | 有 |
| POST | `/api/proxy-control/logs/clear` | 清除日志 | 有 |
| GET | `/api/proxy-control/conflicts` | 检测 base_url 占用冲突 | 无 |

### 1.3 供应商管理

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/proxy-api/test-connection` | 测试供应商连通性 | 有 |
| POST | `/api/proxy-api/fetch-models` | 获取模型列表 | 有 |
| GET | `/api/proxy-api/balances` | 查询余额 | 有 |
| PUT | `/api/proxy-api/providers/:id` | 更新供应商配置 | 有 |
| ALL | `/api/proxy-api/:proxy/*` | 转发请求到上游代理 | 有 |

### 1.4 健康与元信息

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/meta/health` | 综合健康检查 | 无 |
| GET | `/api/meta/health-history` | 健康历史 | 无 |
| GET | `/api/meta/version` | 版本信息 | 无 |
| GET | `/api/meta/installed` | 安装状态 | 无 |
| GET | `/api/meta/env-check` | 环境检查 | 无 |
| GET | `/api/meta/errors/patterns` | 错误模式统计 | 无 |
| GET | `/api/meta/errors/history` | 错误历史 | 有 |
| GET | `/api/meta/autostart` | 获取开机自启状态 | 无 |
| POST | `/api/meta/autostart` | 设置开机自启 | 有 |

### 1.5 告警

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/alert/` | 获取告警列表 | 无 |
| GET | `/api/alert/config` | 获取告警配置 | 有 |
| POST | `/api/alert/collect` | 采集告警数据 | 无 |

### 1.6 Agent 注册中心

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/registry/agents` | 列出所有注册 agent | 无 |
| GET | `/api/registry/agents/by-capability/:tag` | 按能力标签过滤 | 无 |
| GET | `/api/registry/agents/:id` | 查询单个 agent | 无 |
| POST | `/api/registry/agents` | 注册新 agent | 有 |
| PUT | `/api/registry/agents/:id` | 更新 agent | 有 |
| DELETE | `/api/registry/agents/:id` | 注销 agent | 有 |

### 1.7 会话管理

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/sessions/` | 列出所有会话 | 无 |
| GET | `/api/sessions/running` | 列出运行中会话 | 无 |
| GET | `/api/sessions/:id` | 查询单个会话 | 无 |
| POST | `/api/sessions/` | 创建新会话 | 无 |
| PUT | `/api/sessions/:id` | 更新会话 | 无 |
| POST | `/api/sessions/:id/step` | 推进会话步骤 | 无 |
| POST | `/api/sessions/:id/resume` | 恢复会话 | 无 |
| POST | `/api/sessions/:id/abort` | 中止会话 | 无 |
| POST | `/api/sessions/:id/done` | 标记完成 | 无 |
| POST | `/api/sessions/:id/fail` | 标记失败 | 无 |
| DELETE | `/api/sessions/:id` | 删除会话 | 无 |

### 1.8 编排

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/orchestration/` | 查询编排状态 | 无 |
| POST | `/api/orchestration/run` | 执行编排任务 | 有 |
| POST | `/api/orchestration/shadow` | 影子模式执行 | 有 |

### 1.9 供应商健康

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/api/provider-health/` | 查询所有供应商健康状态 | 无 |
| GET | `/api/provider-health/:id` | 查询单个供应商 | 无 |

---

## 二、Codex Proxy API（端口 18790）

前缀：`/api/*` + `/v1/*`

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/v1/models` | 列出可用模型 | 有 |
| POST | `/v1/chat/completions` | 聊天补全（主路径） | 有 |
| GET | `/health` | 健康检查 | 无 |
| GET | `/api/config` | 获取配置 | 有 |
| GET | `/api/settings` | 获取设置 | 有 |
| PUT | `/api/settings` | 更新设置 | 有 |
| GET | `/api/routing-mode` | 获取路由模式 | 有 |
| POST | `/api/set-routing-mode` | 设置路由模式 | 有 |
| GET | `/api/providers/status` | 供应商状态 | 有 |
| GET | `/api/history` | 历史记录 | 有 |
| POST | `/api/switch-model` | 切换模型 | 有 |
| POST | `/api/test-connection` | 测试连通性 | 有 |
| GET | `/api/providers` | 列出供应商 | 有 |
| POST | `/api/providers` | 新增供应商 | 有 |
| PUT | `/api/providers/:id` | 更新供应商 | 有 |
| DELETE | `/api/providers/:id` | 删除供应商 | 有 |
| GET | `/api/balances` | 查询余额 | 有 |
| POST | `/api/clear-history` | 清除历史 | 有 |

---

## 三、Hermes Proxy API（端口 18793）

Flask 路由（基于 `@app.route`）

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| GET | `/health` | 健康检查 | 无 |
| GET | `/v1/models` | 列出模型 | 有 |
| GET | `/api/config` | 获取配置 | 有 |
| GET | `/api/routing-mode` | 获取路由模式 | 有 |
| POST | `/api/set-routing-mode` | 设置路由模式 | 有 |
| GET | `/api/providers/status` | 供应商状态 | 有 |
| GET | `/api/history` | 历史记录 | 有 |
| POST | `/api/switch-model` | 切换模型 | 有 |
| POST | `/api/test-connection` | 测试连通性 | 有 |
| GET | `/api/providers` | 列出供应商 | 有 |
| POST | `/api/providers` | 新增供应商 | 有 |
| PUT | `/api/providers/<provider_id>` | 更新供应商 | 有 |
| DELETE | `/api/providers/<provider_id>` | 删除供应商 | 有 |
| GET | `/api/balances` | 查询余额 | 有 |

---

## 四、Cursor Proxy API（端口 18794）

Fastify 路由（TypeScript）

| 前缀 | 路径 | 说明 |
|------|------|------|
| `/v1` | `chatRoutes` | 聊天相关路由 |
| `/admin-api` | `adminRoutes` | 管理员路由（需 admin 认证） |
| `/v1/models` | `modelRoutes` | 模型相关路由 |
| `/health` | 根路由 | 健康检查 |

---

## 五、L2 Adapter 协议（端口动态）

适配器必须实现的端点（见 `l2/adapter-protocol.md`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/adapter/capabilities` | 能力声明 |
| GET | `/adapter/health` | 健康检查 |
| POST | `/adapter/tasks` | 任务接收 |
| GET | `/adapter/tasks/:id` | 结果查询 |

---

## 六、公共参数

### 认证

所有 `/api/*` 路径（除 `/api/auth/*` 和 `/api/meta/health` 等少数例外）需要 Header：
```
Authorization: Bearer <JWT_TOKEN>
```

### 错误码

| HTTP 状态 | 含义 |
|-----------|------|
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 未认证 |
| 403 | 无权限 |
| 404 | 不存在 |
| 409 | 冲突 |
| 500 | 服务器错误 |

### 响应格式

```json
{
  "success": true,
  "data": { ... },
  "error": null
}
```

---

## 七、快速验证

```bash
# Manager 健康
curl http://127.0.0.1:18792/api/meta/health

# Codex 健康
curl http://127.0.0.1:18790/health

# Cursor 健康
curl http://127.0.0.1:18794/health

# 列出 Manager 所有路由（需登录）
curl http://127.0.0.1:18792/api/proxy-control/status
```

---

## 八、参考

- `multi-proxy-manager/server.js` — Express 路由挂载
- `multi-proxy-manager/routes/` — 各路由文件实现
- `codex-proxy/proxy.js` — Codex 代理入口
- `hermes-proxy/proxy.py` — Hermes 代理入口
- `cursor-proxy/src/server/app.ts` — Cursor 代理入口
- `l2/adapter-protocol.md` — Adapter 协议规范
