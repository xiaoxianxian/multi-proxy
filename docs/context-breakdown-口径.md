# context-breakdown 口径文档（dsh-context → multi-proxy）

> 2026-10-15。来源：外部对照 `bowenliang123/dsh-context`（DSH 上下文可观测插件，2127★，Apache-2.0）。
> 本文件是 multi-proxy「上下文组成透视」的**唯一口径真源**。改字段、改阈值、改归类，先改这里，再改代码。
> 内核已存在：`l2/context-fold.js`（七类秤 + C2 时间线 + C5 工具来源，坐标系本就抄自 dsh-context）。
> 本文件规定的是**接进请求路径之后**的对外形状：上报、存储、查询、事件推断四条口径。

---

## 0. 一句话

multi-proxy 作为代理，站在客户端和上游之间；它把每次请求的**七类上下文组成**折出来、和上一帧比、推断「上下文被压缩了」这类事件，报给 manager 落账，面板可看。**只观测，不改写**（与 context-fold 内核同一条铁律）。

## 1. 七类坐标系（沿用，不重造）

`l2/context-fold.js:32` 的 `CATEGORIES`，顺序即堆叠条从上到下：

| 类 | 代理侧可见形态 | 说明 |
|---|---|---|
| `system` | messages 里 role=system/developer | OpenAI o1 后的 developer 归此类 |
| `tools` | 请求体 `tools[]` 的 schema 声明 | 只算声明，不算调用参数 |
| `user` | role=user | |
| `inject` | 代理侧注入（pack/RAG，经 `o.injections` 传入） | 客户端直连时该桶为 0，不硬凑 |
| `skill` | 代理侧注入中标 `sink:'skill'` 的 | 单列，不许混进 inject |
| `assistant` | role=assistant（含 tool_calls 的 arguments） | |
| `tool` | role=tool 的消息体（工具结果） | |

**与 dsh-context 的差异（必须知道，别混称）**：
- dsh-context 跑在 harness 内部，`inject`/`skill` 的生产者（instruction file / plugin id / skill name）它**看得见**；代理只看最终装配好的请求体，**看不见是谁注入的**。所以 multi-proxy 的 inject/skill 两桶默认是 0（除非代理侧自己有注入，如 curator pack）。
- dsh-context 的图片按官方 DeepSeek 图片 token 估算；context-fold 按 `DEFAULT_IMAGE_TOKENS=1024`/张兜底，且在 warnings 里明示。

## 2. 双轨制：估算 vs provider 实测（照抄 dsh-context 的诚实）

- **估算轨**：`estimate.byCategory` —— context-fold 用 `l2/token-policy.js` 的 `estimateTokens`（长度/3 启发式，2026-10-01 用 o200k 拟合过系数）。分类数字只有这一轨。
- **实测轨**：`actual` —— 上游响应 `usage.prompt_tokens` 按各类估算占比**分摊**回七类（`apportion()`，余数落在最大类，保证七类之和 == prompt_tokens 精确相等）。`cached` 原样带出。
- 面板/API 永远同时显示两轨或明示只有一轨；**没有实测就是没有**，绝不拿估算冒充实测（context-fold.js:22 铁律）。
- 帧差（delta）继承 context-fold 的 `diffFrames`：`source: 'actual' | 'estimate' | 'mixed'`，mixed 不得当实测陈述。

## 3. 事件推断口径（本文件新增，代理侧独有）

代理看不到 harness 的 compaction/prune 动作，只能从**相邻两帧的差**推断。全部事件带 `inferred: true` 与 `basis: 'proxy-frame-diff'`——**是推断，不是事实**，面板与 API 一律这样标注。

| 事件 kind | 触发条件（默认阈值，`l2/context-events.js` 顶部常量可调） | 语义 |
|---|---|---|
| `compaction-candidate` | 本帧 total < 上帧 total × (1−0.25) 且缩量 ≥ 2000 tokens | 上下文发生大幅收缩，最可能是自动压缩 |
| `prune-candidate` | 缩量在 5%–25% 之间且 ≥ 200 tokens | 小幅收缩，可能是工具结果裁剪 |
| `model-switch` | 上帧与本帧 `model` 均非空且不同 | 同一客户端换了模型 |
| `tools-changed` | 两帧工具名集合均非空且有增/删 | 工具schema装载集变了（懒加载生效的证据） |

- 首帧无参照物 → 不出事件（不是「没变」，是「不知道」）。
- 任一帧 total 非有限数 → 不出事件（未知不猜）。
- 帧的归属：**同一 lane 内按 clientKey 分别记住上一帧**（clientKey 取自 `x-agent` 头 / UA 识别 / 'default'，最多记 8 个，超出按插入序淘汰）。为什么必须分：generic lane 同时服务 cline/aider/openhands 多个客户端，混为一谈会把 A 的压缩算到 B 头上。
- 阈值放常量不放 env：面板可读、测试可钉；要调先改这里再改代码。

## 4. 上报契约（lane → manager）

```
POST /api/context/report
x-agent-token: <MANAGER_AGENT_TOKEN>
{
  agent: 'dsh-proxy',            // 谁报的
  reqId: '...',                  // 幂等键（同 usage 上报那套）
  model: 'agnes-3.0-flash',      // 上游实际模型（response.data.model）
  requestModel: 'qwen3.8:27b-mlx', // 宿主要的模型（req.body.model）
  clientKey: 'dsh',              // 帧归属键（见 §3）
  frame: {                       // context-fold fold() 的返回值（计数，无正文）
    estimate: { byCategory:{...}, total, toolsBySource:{...}, toolCount, toolsUnnamed, unclassified },
    actual: { byCategory:{...}, total, cached } | null,
    source: 'actual' | 'estimate',
    warnings: ['no-provider-actuals: ...']
  },
  events: [ { kind, inferred:true, basis:'proxy-frame-diff', droppedTokens?, from?, to?, added?, removed? } ],
  ts: 1760000000000
}
```

**隐私纪律**：上报体只有计数与告警，**永不包含 prompt/回复正文**。落盘的 jsonl 同样只有计数。这条写死，不许后来加「顺手存个原文」。

## 5. 存储与查询契约（manager 侧）

- 落盘：`~/.multi-proxy-manager/context-ledger.jsonl`，一行一请求（append-only；超过 5MB 轮转到 `.1`）。
- 内存：环式缓冲，默认留最近 500 条（`lib/context-store.js`）。
- `GET /api/context/summary?windowMs=86400000`：
  - `requests`：窗口内请求数
  - `byCategory`：七类各自的**平均** token（估算轨，按窗口内请求平均）
  - `peak`：窗口内最大单帧 total
  - `actualCoverage`：有实测轨的请求占比（0–1）
  - `events`：按 kind 计数的推断事件 tally
  - `warnings`：按告警前缀计数的 tally（如 `no-provider-actuals`）
  - `perAgent`：按 agent 拆的请求数
- `GET /api/context/recent?n=50`：最近 n 条（同 §4 形状，无正文）。
- GET 不鉴权（与 `/api/floor` 同模式：manager 默认只绑 127.0.0.1，纯只读展示）；POST 走 `requireAgentAuth`（JWT 或机器 token）。

## 6. 门控与热路径纪律

- 门控 `PROXY_CONTEXT_TRACK`，**默认关**。关时 lane 侧只做一次布尔判断（<1μs），不 fold、不上报（与 `PROXY_COST_TRACK` 同构）。
- 上报 fire-and-forget：2 秒超时、失败只吞不抛（观测链路崩了不能拖垮转发）。
- 观测本身不能拖垮宿主：manager 侧单条入账做形状校验，畸形行丢并计数，不 throw。

## 7. 明确不做的（防范围蔓延）

- 不做「谁注入的」归因到 instruction file 级——代理看不到，硬做就是假数据（§1 差异）。
- 不区分 compaction 与 prune 的事实——只出 candidate（§3）。
- 不跨 lane 合并会话——帧差只在单 lane 单 clientKey 内做。
- 不碰 token-policy 的省 token 逻辑——本链路是秤，不是刀。
