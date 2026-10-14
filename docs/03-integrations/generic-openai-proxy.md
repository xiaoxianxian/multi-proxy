# Generic OpenAI-Compatible Proxy 接入指南

> 端口：`127.0.0.1:18799` · 属于 multi-proxy 七代理体系之一 · 由 `opencode-proxy` 同构分叉

## 这是什么

`generic-openai-proxy` 是一个通用 **OpenAI 兼容**网关。它用一个适配器同时覆盖 **Cline / Aider / OpenHands** 三家客户端（也兼容 opencode / dsh / codex / cursor / hermes 的 OpenAI 兼容调用）。

为什么是一个而不是三个？三家都是标准 OpenAI 兼容客户端，接入方式完全一致：把 `base_url` 指过来、随便填个 `api_key`、`model` 写上游真实模型名。代理只做**透传转发 + 按模型名路由到对应上游 + 记成本台账**，所以边际成本趋零。

## 前置条件

1. 代理已启动：
   - 一键：`bash manage.sh generic start`
   - 手动：`cd generic-openai-proxy && npm install && node proxy.js`
   - 健康检查：`curl http://127.0.0.1:18799/health`
2. 在 `generic-openai-proxy/.env` 填好至少一个上游 Key（如 `DEEPSEEK_API_KEY`）。模板见 `generic-openai-proxy/.env.example`。
3. **代理/网络注意**：代理进程若继承了指向未监听端口的 `HTTP_PROXY`，上游 fetch 会 `Connection refused (os error 61)` → 502。烟测/正式使用前先 `unset HTTP_PROXY HTTPS_PROXY`，或把 `HTTP_PROXY` 指向可达的本地代理（如 `http://127.0.0.1:7897`）。

## 三家接入配置（核心三行）

不论哪家客户端，本质都是这三行：

| 项 | 值 |
| --- | --- |
| `base_url` | `http://127.0.0.1:18799/v1` |
| `api_key` | 任意非空字符串（代理**不校验**客户端 key，真正的上游 key 在 `.env`） |
| `model` | 上游真实模型名（如 `deepseek-v4-pro`） |

### Cline（VS Code 扩展）

`settings.json`：

```json
{
  "cline.apiConfiguration": {
    "apiProvider": "openai",
    "openaiBaseUrl": "http://127.0.0.1:18799/v1",
    "openaiApiKey": "any-non-empty",
    "openaiModelId": "deepseek-v4-pro"
  }
}
```

### Aider（CLI）

```bash
aider --openai-api-base http://127.0.0.1:18799/v1 \
      --openai-api-key any-non-empty \
      --model deepseek/deepseek-v4-pro
```

或走环境变量：

```bash
export OPENAI_API_BASE=http://127.0.0.1:18799/v1
export OPENAI_API_KEY=any-non-empty
export OPENAI_API_MODEL=deepseek/deepseek-v4-pro
```

### OpenHands（原 OpenDevin）

`config.toml`：

```toml
[llm]
model = "deepseek-v4-pro"
base_url = "http://127.0.0.1:18799/v1"
api_key = "any-non-empty"
```

## 成本归因（可选）

默认所有请求记成 `generic-openai-proxy`。想按客户端拆分台账：

- **自动识别**：请求 `User-Agent` 含 `cline` / `aider` / `openhands` / `opencode` / `dsh` / `codex` / `cursor` / `hermes` 会被自动归因。
- **显式归因**：请求头带 `x-agent: cline|aider|openhands|...`，客户端不暴露可识别 UA 时用它强制归类。

## 支持的模型与路由

`model` 直接写上游真实模型名即可，代理按关键字路由（映射见 `generic-openai-proxy/routing-policy.js`）：

- 含 `deepseek` → DeepSeek
- 含 `moonshot` / `kimi` → Moonshot
- 含 `agnes` → Agnes

## 验证

```bash
curl http://127.0.0.1:18799/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "User-Agent: cline/1.0" \
  -d '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"hi"}]}'
```

返回里的 `usage`（prompt / completion / total tokens）即真实消耗量，`model` 正确回显，说明透传与 UA 归因正常。

## 与 opencode-proxy 的区别

同源分叉，转发逻辑一致，差异只在身份与识别范围：

| | opencode-proxy (18798) | generic-openai-proxy (18799) |
| --- | --- | --- |
| 默认 agent 标签 | `opencode-proxy` | `generic-openai-proxy` |
| UA 识别重点 | `/opencode/` | `cline`/`aider`/`openhands` 优先，覆盖全部 |
| 显式归因头 | 不支持 | 支持 `x-agent` |
| 适用 | 只用 opencode | 用 Cline / Aider / OpenHands 等标准 OpenAI 客户端 |

## 常见问题

- **502 Bad Gateway / `upstream connect failed (os error 61)`**：代理进程继承了坏的 `HTTP_PROXY`。`unset` 或指向可达代理后重启。
- **`content` 为空**：上游是推理型模型（如 `deepseek-v4-pro`）时，输出 token 可能全进了 `reasoning_tokens`，`content` 为空属正常——看 `usage.reasoning_tokens`。
- **18799 端口被占**：DSH 预留槽是 18797、opencode 是 18798，三者互不冲突；确认没有其他进程占用 18799。
- **改了 `.env` 不生效**：重启代理（`bash manage.sh generic restart`）；`.env` 权限应为 `600`，不会被 git 跟踪。

## 相关文档

- 总览与能力矩阵：`docs/01-feature-matrix.md`、`docs/agent-coverage-roadmap.md`
- 同构分叉源：`opencode-proxy/`、`codex-proxy/`
- 运维：`manage.sh`（命令 `generic start|stop|restart|status|logs`）、`tools/regression-all.sh`
