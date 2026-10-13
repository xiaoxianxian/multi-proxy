# Agent 覆盖方案 — 让更多 agent 走 multi-proxy（2026-10-13）

> 目标：尽量多覆盖热门 agent 的 proxy。数据来源：2026-10-13 公开评测/社区快照（SWE-bench、GitHub stars、Agensi 安装量、a16z）。数字为多来源快照，跨源不可直接比大小。

## 一、2026 热门 agent 全景（编程向为主）

| Agent | 类型 | 协议/模型 | 热度信号 | 能否走 multi-proxy |
| --- | --- | --- | --- | --- |
| **Claude Code** | 终端 agent | Anthropic 兼容 | 品类第一（a16z：6 个月 $1B ARR）| ✅ Anthropic 兼容端点 |
| **Codex CLI** | 终端 agent | OpenAI | ~200 万周活 | ✅ 已有 codex lane |
| **OpenCode** | 终端 agent（OSS）| OpenAI 兼容 / 75+ provider | 最热开源（95K–184K★）| ✅ OpenAI 兼容端点 |
| **Cursor** | AI IDE | 多模型 | 品类第一 IDE | ✅ 已有 cursor lane |
| **Aider** | 终端 agent（OSS）| 任意（BYOK）| 42–44K★，git 原生 | ✅ OpenAI 兼容端点 |
| **Cline / Roo / Kilo Code** | VS Code 插件 | 任意（BYOK）| 59–64K★ | ✅ OpenAI 兼容端点 |
| **Gemini CLI** | 终端 agent | Gemini 原生 | 100K+★，1M 上下文 | ⚠️ 需 Gemini 协议转换 lane |
| **Qwen Code**（阿里）| 终端 agent | Qwen / OpenAI 兼容 | 中文生态热 | ✅ OpenAI 兼容端点 |
| **Kimi CLI**（月之暗面）| 终端 agent | Anthropic 兼容 | 中文增长快 | ✅ Anthropic 兼容端点 |
| **Goose**（Block）| 终端 agent（OSS）| 任意 / Ollama | 企业背书 | ✅ OpenAI 兼容端点 |
| **Continue** | IDE 插件 | 任意（BYOK）| 自托管优先 | ✅ OpenAI 兼容端点 |
| **OpenHands** | 自主 agent（OSS）| 任意（BYOK）| SWE-Bench 常青 | ✅ OpenAI 兼容端点 |
| **Crush / Plandex / Trae Agent** | 终端 agent | OpenAI/Anthropic 兼容 | 新锐 | ✅ OpenAI 兼容端点 |
| **Copilot CLI** | GitHub 生态 | 锁定 GitHub | 增长快 | ❌ 闭源、禁自定义 base URL |

## 二、multi-proxy 现有能力（接入面）

- **OpenAI 兼容端点**：`http://127.0.0.1:18790/v1`（codex lane，`Authorization: Bearer <key>`）；DSH 独立 lane `http://127.0.0.1:18797/v1`。
- **Anthropic 兼容端点**：同一网关按入口分发 `/v1/messages`（认 `x-api-key`）与 OpenAI（认 `Bearer`）——见 `dsh-proxy/proxy.js:323`、`codex-proxy`。
- **结论**：绝大多数「BYOK / 多模型」agent（Aider、Cline、OpenCode、Goose、Continue、Qwen Code、OpenHands、Crush、Plandex、Trae）**无需新建 lane**，改 base URL 指到 `:18790/v1` 即可接入路由/成本统计/模型切换。

## 三、配置片段（复制即用）

> 前提：`bash manage.sh start` 已起，`codex-proxy/.env` 已配上游 Key；`<KEY>` 填你在 proxy 侧设的访问密钥（或上游透传 key）。

### Aider（OpenAI 兼容）
```bash
aider --openai-api-base http://127.0.0.1:18790/v1 \
      --openai-api-key <KEY> --model agnes-3.0-flash
```

### Cline / Roo Code / Kilo Code（VS Code）
- API Provider: **OpenAI Compatible**
- Base URL: `http://127.0.0.1:18790/v1` · API Key: `<KEY>` · Model: `agnes-3.0-flash`

### Continue（`config.yaml`）
```yaml
models:
  - name: multi-proxy
    provider: openai
    model: agnes-3.0-flash
    apiBase: http://127.0.0.1:18790/v1
    apiKey: <KEY>
```

### OpenCode（`opencode.json` → 自定义 provider）
```json
{ "provider": {
    "multi-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:18790/v1", "apiKey": "<KEY>" },
      "models": { "agnes-3.0-flash": {} }
    } } }
```

### Claude Code / Kimi CLI（Anthropic 兼容）
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18790
export ANTHROPIC_AUTH_TOKEN=<KEY>     # 或 ANTHROPIC_API_KEY
claude
```

### Goose / OpenHands / Crush / Plandex / Trae Agent
均为 OpenAI 兼容 provider：baseURL `http://127.0.0.1:18790/v1`，apiKey `<KEY>`，按各工具配置格式填入即可。

## 四、需要/值得建独立 lane 的（按优先级）

| 优先级 | lane | 理由 |
| --- | --- | --- |
| P1 | **Claude Code / Anthropic 兼容 lane** | 品类第一、需求最大；若 `:18790/v1/messages` 兼容性不足，单开 `claude` lane（端口如 18798），独立模型列表/成本。 |
| P2 | **Gemini lane** | Gemini CLI 用 Gemini 原生协议，需 Gemini→OpenAI 转换；覆盖 Google 生态/免费档用户。 |
| P3 | **OpenHands lane** | 自主 agent 调用模式不同（长任务、多轮工具），可独立限流/预算。 |

> 大多数 agent 走通用 OpenAI 兼容端点即可，**不必一 agent 一 lane**（避免过度工程）；只有协议不兼容或调用模式差异大的才单开。

## 五、验证状态（诚实）
- 以上配置片段基于各 agent 公开文档的通用接入方式，**本机未逐个实测**（本机仅 macOS、部分 agent 未安装）。接入时按各工具最新版配置项微调；优先验证 Claude Code / Aider / Cline 三家（覆盖面最大）。
