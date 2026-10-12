# IM 入站通道（L2 P4）

让 IM 平台（飞书 / Telegram / …）的消息进 multi-proxy，走本地 agent 执行，再把回复回投。

> 定位：这是「一切皆插件 / 本地 agent 网关」思路的一个落地样本——外部消息作为**入站流量**进网关，
> 与 dsh-im 的 AI Office Connector（**外连**式，本地 Harness reach out 到公网 Office）方向相反，
> 但隔离原则一致：对方只拿到你愿意给的内容，拿不到本机内部细节。详见文章体系 #54 对照段素材。

## 非侵入纪律（与全项目一致）

- 门控 `PROXY_IM_INBOUND` **默认关** → 403，热路径零副作用；`=1` 才放行。
- 真执行另受 `PROXY_EXECUTOR_BIND` 门控（缺省 `0`）→ 不开 = 不触下游、不花钱、不吐数据。
- 不写任何 agent 文件；出站回投走 **webhook 旁挂**（YAGNI，不直连各平台 API）。

## 启用

```sh
PROXY_IM_INBOUND=1 PROXY_EXECUTOR_BIND=1 node server.js
```

- 写端点需鉴权：`x-agent-token: <~/.multi-proxy-manager/agent-token>`（与 cost-report 同通道），不 fail-open。
- 只开 `PROXY_IM_INBOUND` 不开 `PROXY_EXECUTOR_BIND` → 请求到执行阶段会明确报 `executor 未绑定`，不静默假装成功。

## 入站形态（POST /api/im-inbound/webhook）

**A. 平台原始回调**（推荐，平台把 webhook 指到这里）：

```json
{ "channel": "feishu", "payload": { "event": { "message": { "text": "@bot 你好", "chat_id": "oc_xxx" } } } }
```

**B. 已归一化直连**（你自己先做了一层归一，或拿不到原始 payload）：

```json
{ "channel": "generic", "text": "你好", "conversationId": "c1" }
```

**可选回投**（异步、non-fatal）：

```json
{ "replyTo": { "channel": "webhook", "webhookUrl": "https://your-relay/..." } }
```

**可选指定执行**：`adapterId`（默认 `codex`）/ `model` / `maxTokens`。

## 归一化支持的平台

| channel | 取文字字段 | 取会话 ID |
|---|---|---|
| `feishu` | `event.message.text`（去 `@bot` 前缀） | `message.chat_id` |
| `telegram` | `message.text` | `message.chat.id` |
| `generic`（兜底） | `text` | `conversationId` |
| 未知 channel | 回落 `generic` | `conversationId` |

飞书订阅握手（`type: url_verification`）会原样回 `challenge`，不执行。

## 出站（回投）现状

- `channel: webhook` → POST JSON 到 `webhookUrl`（fire-and-forget，2s 超时即弃）。
- 飞书 / Telegram 等**平台专用发送 API 尚未实现**（YAGNI）。真实部署建议：在平台侧配一个你自己的回投中继，
  或后续在 `lib/im-channels.js` 的 `sendOutbound` 里补 `feishu`/`telegram` 分支（调各平台 sendMessage）。

## 测试

```sh
cd multi-proxy-manager
NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/im-inbound.test.js
```

## 与 dsh-im 的对照（写 #54 用）

| | dsh-im AI Office Connector | multi-proxy IM 入站通道 |
|---|---|---|
| 方向 | 外连（本机 reach out 公网 Office） | 入站（IM 流量打进网关） |
| 本机暴露面 | 无需公网 IP / 端口转发 / WS | 占一个本地 HTTP 端点（127.0.0.1） |
| 隔离核心 | Office 只见 alias，不收本机绝对路径 | 只归一消息、执行走本地 agent，不外泄内部 |
| 鉴权 | `POST /heartbeat` 强协议版本校验 | `x-agent-token` 机器鉴权 + 门控默认关 |
