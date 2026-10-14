# ECC 接入 multi-proxy（2026-10-14）

> **结论先行**：ECC 不是 multi-proxy 的竞品，是它的**上游搭配**。ECC 管「agent 怎么用好」，
> multi-proxy 管「请求发给谁、花多少钱」。两者靠一个 `ANTHROPIC_BASE_URL` 串起来，互不侵入。

## 一、为什么是搭配不是竞品

ECC（`affaan-m/ECC`，278,347★，2026-10-13 经 `gh api` 核）是 harness 侧的技能 / 记忆 / 安全打包。
它自己的 README 明确写了这段话：

> ECC works through each harness's normal configuration, so you can use an official provider,
> **a compatible custom API endpoint or model gateway**, or a self-hosted model without changing
> ECC's workflows.

它给的示例就是自定义网关：

```bash
export ANTHROPIC_BASE_URL=https://your-gateway.example.com
export ANTHROPIC_AUTH_TOKEN=your-token
claude
```

也就是说：ECC 官方把「走自定义端点」当成一等用例。**multi-proxy 就是那个端点。**
ECC 的 hooks / skills / commands / rules 在 `claude` CLI 已经能跑的前提下，对模型来源完全无感
（原文：*"model-provider agnostic once the `claude` CLI is already working"*）。

分工边界：

| 层 | 谁管 | 具体 |
|---|---|---|
| Harness 行为 | ECC | 311 skills、71 subagents、rules、hooks、跨 harness Memory Vault |
| 请求出口 | **multi-proxy** | 上游路由、per-provider 记账、真假成本防护、熔断、面板 |

## 二、三步接入（复制即用）

### 第 1 步 · 确认 gateway 在跑

```bash
curl -s http://127.0.0.1:18790/health | head -c 120
# → {"status":"healthy",...}
```

端口事实：`codex-proxy/proxy.js:24`（`PORT` 默认 18790）。

### 第 2 步 · 指过去

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18790
export ANTHROPIC_AUTH_TOKEN=<你在 proxy 侧的访问密钥>
claude
```

鉴权两条路都通（`codex-proxy/proxy.js:1396`、`:1412`）：
- Anthropic 原生 `x-api-key`
- `ANTHROPIC_AUTH_TOKEN` 形态的 `Authorization: Bearer`

ECC 用的是后者。**入站 token 绝不会透传上游**，proxy 会换成 provider 自己的 key
（这是 `codex-proxy-messages.test.js` 里标 🔴 的断言）。

### 第 3 步 · 验证

```bash
# 面板看有没有进来（18791 为管理台端口，按实际部署为准）
open http://127.0.0.1:18791
```

## 三、不用自己操心的三件事（这是 multi-proxy 的活）

### 1. 上游 Anthropic 路径没有通用规律

🔴 这条最容易踩。逐个实测的结果（记录于 `codex-proxy/proxy.js:1379-1382`）：

| 上游 | 真实路径 | 不存在路径的返回 |
|---|---|---|
| DeepSeek | `/anthropic/v1/messages` | `/v1/messages` 是 404 |
| Kimi | `/anthropic/v1/messages` | 401（不存在 404） |
| Agnes | `/v1/messages` | `/anthropic/...` 是 403 |
| Ollama | `/v1/messages` | `/anthropic/...` 是 404 |

proxy 用三级判定自动选：显式 `anthropicBaseUrl` > 已知前缀型厂商（deepseek / moonshot）> 根路径。
**用户侧零配置**，这也是别手写 base_url 拼 `/v1/messages` 的原因。

### 2. 上游非 2xx 原样透传

不把真因盖成 500。ECC 那边看到的状态码就是上游真实状态码。

### 3. 模型名必须对得上 provider 表

ECC 的 token optimization 建议把默认模型压到 `sonnet` 档（`docs/token-optimization.md`）。
**注意**：改模型名要跟 multi-proxy 的 provider 表对得上，对不上会直接
`400 Unsupported model: <name>`（`codex-proxy/proxy.js:1402`）。
想省钱，正确做法是在 proxy 侧配好 provider 与路由，ECC 侧沿用同一个名字，而不是在 ECC 里另起一套。

## 四、已验证到什么程度（诚实标注）

| 项 | 状态 | 证据 |
|---|---|---|
| `/v1/messages` 路由存在、按厂商构造上游路径 | ✅ 已验证 | `multi-proxy-manager/tests/unit/codex-proxy-messages.test.js` **10/10 PASS**（2026-10-14 复跑） |
| 入站 Bearer（`ANTHROPIC_AUTH_TOKEN` 形态）被正确处理 | ✅ 已验证 | 同上，用例「入站带 Bearer → 上游带同值 Bearer；不带则不造」 |
| 入站 token 不上游透传 | ✅ 已验证 | 同上，🔴 断言 |
| `ANTHROPIC_BASE_URL` 指向 18790 的**真实 ECC 会话** | ❌ **未验证** | 本机未装 ECC，未跑过真实 Claude Code + ECC 会话。本文档的接入结论来自 ECC README 的官方声明 + 上述单测，**不等于端到端实测** |
| Ollama 走 `/v1/messages` 真跑通对话 | ❌ 未跑通 | 路径存在但实测返回 400。本地模型走 OpenAI 兼容端点，别走这条 |

> 别把「单测绿」当成「端到端通」。要补最后一步，得真装一次 ECC 跑一个会话。

## 五、给 ECC 用户的卖点（写拉新页时用这几句）

1. **你不用改 ECC 任何配置**，两个环境变量就能把出口换成本地网关。
2. **ECC 的 token optimization 只管"用多少"，管不了"花多少"**——真实单价、per-provider 记账、
   单价 unknown 时不假装省钱的真假成本防护，是网关层才有的东西。
3. **跨 harness 的记忆是 ECC 自己的活**（它的 Memory Vault 支持 Claude / Codex / Hermes /
   OpenClaw / Kimi）；**跨 provider 的钱是 multi-proxy 的活**。两边正交，不抢。
