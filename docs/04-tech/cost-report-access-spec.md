<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# docs/04-tech/cost-report-access-spec.md — 跨进程 usage 上报接入规范

> 适用：任何**给 agent 做代理**的进程（codex-proxy / hermes-proxy / cursor-proxy / 未来第三方）。
> 目的：让每一笔上游计费都能进 manager 的成本盘面（`/api/floor`），而接入方**一行解析代码都不用写**。
> 落码位置：`multi-proxy-manager/routes/cost-report.js`（接入面）+ `lib/usage-probe.js`（归一内核）。
> 最后验证：2026-10-02，真 Kimi `/v1/messages` 端到端跑通（见 §六）。

---

## 一、为什么要有这一层

上游（DeepSeek / Kimi / OpenAI / Gemini）的 usage 形状各不相同，而且**流式的 usage 藏在流末事件里**。
把这个解析知识放给每个接入方 = 每个代理各写一遍 SSE 解析 = 迟早漂、迟早漏。

所以定为：**单点吃掉**。

- 接入方只贴**上游返回的 usage 原样**（`raw`）+ 一句 `agent`；
- 解析 / 归一 / wire 识别全部由 `lib/usage-probe.js` 自动生成；
- 新增 provider、新增 agent 代理 → **不改 manager、不提解析补丁**。

> 配套架构决策：由**代理进程自己上报**（而非 manager 二次转发），
> 因为 manager 拿不到代理到上游之间的原始响应字节流。

## 二、接入三步（约 20 行）

### 1. 拿到机器 token

manager 首次启动会自动生成并落盘 `~/.multi-proxy-manager/agent-token`（0600），
同时注入自身 `process.env`；`lib/process-manager.js:311` 的 `env: { ...process.env }`
会把 token 带进 manager 拉起的每个代理子进程 —— **这套路径零配置**（开盒即用）。

自己拉起的代理（launchd / systemd / systemd-user / supervisor / 手敲）：
复制那一行 token 进自己的环境变量即可。

```bash
export MANAGER_AGENT_TOKEN=$(cat ~/.multi-proxy-manager/agent-token)
export MANAGER_URL=http://127.0.0.1:18792   # 不设则默认 18792
```

### 2. 攒到响应末尾再报

`usage` 在**流末**（Anthropic 的 `message_delta` / OpenAI 的末 chunk），
所以要边 pipe 边攒一份字节副本，流走完再发。参考实现：`codex-proxy/proxy.js:730` `pipeUpstreamBytes`
（里面 `close` / `finish` 双事件必须加幂等守卫，否则同一笔账落两遍）。

### 3. POST 到唯一接入面

```http
POST /api/cost/report
x-agent-token: <MANAGER_AGENT_TOKEN>
content-type: application/json

{
  "agent": "codex-proxy",
  "raw":   { "...上游 usage 原样..." },
  "latencyMs": 1331
}
```

`raw` 两种形态都收：`{...}` 对象（非流式）或**整段响应文本**（流式 SSE 拼接 / 非流式 JSON 文本）。

## 三、字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `agent` | 否 | 谁报的，默认 `gateway`；一个 agent 代理一个 id，账本按它分格 |
| `raw` | **是** | 上游 usage 原样。对象 or 文本。缺 → 400 |
| `latencyMs` | 否 | 喂 floor 的 p50 延迟窗口 |
| `wire` | 否 | **可以不声明**，由 `detectWire()` 自动认（见下表） |
| `reqId` | 否 | 幂等键（见 §五） |
| `model` / `requestModel` | 否 | 实际计费模型 / 宿主要求的模型，见 §三·模型三分格 |
| `pricingModel` | 否 | 用哪套价表算的账，历史账单不随改价漂移 |

### 模型三分格（route-engine 最直接有用的那一段）

`model` = 请求真正落到的模型；`requestModel` = 宿主填的模型。两者不同就是**模型重写/别名**，
这正是 route-engine 天天在做的事，而账本以前完全没记这一对 —— 没它永远答不出
「那批 claude-haiku 的请求到底烧了多少」。

```json
{ "requestModel": "claude-haiku-4-5", "model": "agnes-3.0-flash", "pricingModel": "agnes-3.0-flash" }
```

三个都不传 = 只按 proxy 归总，不进模型层拆账（`byModel` 拿不到，也不报错）。

返回 200 时回显归一结果，方便一眼对账：

```json
{ "ok": true, "agent": "third-party-agent", "wire": "anthropic",
  "prompt": 31, "completion": 71, "cacheHit": 31, "thinking": 61 }
```

### wire 自动识别

| 识别到的 wire | 依据 | 归一口径 |
|--------------|------|----------|
| `anthropic` | `input_tokens` / `output_tokens_details` / `usage` 包一层 | prompt=input_tokens, completion=output_tokens, cacheHit=cache_read_input_tokens, thinking=output_tokens_details.thinking_tokens |
| `openai` | `prompt_tokens` / `completion_tokens` | 同上，缓存走 `prompt_tokens_details.cached_tokens` |
| `gemini` | `usage_metadata` | prompt_token_count / candidates_token_count / cached_content_token_count / thoughts_token_count |
| `sse` | 文本里含 `data:` 行 | 取**最后一个**能 parse 的事件，并下探 `.usage` 子层 |
| `custom` | 其他对象 | 全 0 |
| `raw-unparsed` | 文本既非 SSE 也非 JSON（半截 / 垃圾） | 全 0 |

## 四、鉴权

写端点**不 fail-open**。两条通道（`lib/auth.js` `requireAgentAuth`）：

1. 界面 JWT：`x-auth-token`（浏览器登录态）；
2. 机器 token：`x-agent-token`，等于 `MANAGER_AGENT_TOKEN` 即放行。

实测：无 token → 401；错 token → 401；带正确 token → 200。

> 机器 token 只在**环回面**防随手灌数（谁都能读 manager 的 env 就等于拿到它）。
> 网络暴露前必须走正经鉴权。

## 五、口径纪律

- **认不出就全 0 记空账，绝不猜、绝不折算 0 冒充有数**。返回的 `wire` 会如实告诉你「没接上」。
- **`reqId` 幂等**：同 `reqId`（+proxy/agent）重放只记一笔。代理侧 `close` / `finish` 双事件
  对同一次响应都会触发（见 §二·2），没这个键账会翻倍。实测：同 reqId POST 3 次 → 账本 1 行。
- **thinking 只计数、不计费**：上游 `output_tokens` 通常已含 thinking，再加一遍是重复收钱；
  它只在盘面单独一格显示（floor view 的 `Thinking Tok`）。
- `latencyMs` 不传就不进 p50，不编数。
- 上报是**旁路**：fire-and-forget + 全 catch，manager 挂了也不能让主路径（agent 请求）失败或变慢；
  失败**每个进程只警告一次**，不静默（否则「上报没生效」会变成玄学）。

## 六、定价（否则 cost 恒 0）

只累 token 数不配单价 = 盘面 `cost` 永远 0（本地模型口径就是 0）。

```bash
export PROXY_PRICING_CODEX_PROXY='{"input":10,"output":20,"cacheHit":3}'   # 每百万 tokens
```

> 🔴 键名里的**连字符要写成下划线**：代理名 `codex-proxy` → `PROXY_PRICING_CODEX_PROXY`。
> shell 设不了带横杠的环境变量名，代码侧（`lib/cost-track.js` `readPricingFromEnv`）已做归一化；
> 实测 71 输出 token @20 元/百万 + 31 命中缓存 @3 元/百万 = `cost 0.001513`。

## 七、参考实现 & 实测

- 接入面：`multi-proxy-manager/routes/cost-report.js`
- 归一：`multi-proxy-manager/lib/usage-probe.js`，单测 `tests/unit/usage-probe.test.js`（20/20）
- 上报侧：`codex-proxy/proxy.js:772` `reportUsage()`（PassThrough tee + fire-and-forget）

2026-10-02 端到端（manager 18812 + codex-proxy 18813，真打 Kimi `kimi-k2.7-code`）：

```
上游 usage = { input_tokens: 0, cache_read_input_tokens: 31,
               output_tokens: 71, output_tokens_details: { thinking_tokens: 61 } }
盘面 cell  = { totalTokens: 102, thinkingTokens: 61, requestCount: 1, latencyMs: 1331 }
```

31 + 71 = 102 ✔；thinking 61 ✔；一次请求一条账 ✔。

## 八、持久账本（2026-10-03 补）

`lib/cost-track.js` 原本全程内存（`const _state = {}`），进程一死账就没 —— 多代理环境下
等于一堆孤岛。现在落 append-only JSONL：

| 项 | 值 |
|----|----|
| 路径 | `~/.multi-proxy-manager/cost-ledger.jsonl`，`PROXY_COST_LEDGER` 可覆盖 |
| 开关 | 跟门控 `PROXY_COST_TRACK` 绑死，**关时连文件都不建** |
| 读回 | 启动时 `loadLedger()` 合并进内存态；行内 `cost` **冻结**，不按现价重算 |
| 幂等 | `loadLedger` 期间临时禁写（`_loading` 守卫），读回不会把文件再追加一遍 |

`PROXY_COST_LEDGER` 重定向不算「可选优化」：一次全量 jest 就会把几十行假账写进真账本
（实测 24 行 + 14 行两轮），`jest.setup.js` 已统一重定向到 tmp。

> 🔴 改价不能回改历史：`loadLedger` 走 `givenCost` 直取行内 cost，不是重新乘单价。
> 这条有单测钉死（价表 10→20 后重启，历史账仍按旧价 0.01 而非 0.02）。
