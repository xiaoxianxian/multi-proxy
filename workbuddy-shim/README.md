# workbuddy-shim

本机 OpenAI 兼容网关，把 multi-proxy 发来的标准 `/v1/chat/completions` 请求，翻译成
WorkBuddy 私有 chat 协议（`copilot.tencent.com/v2/chat/completions`）。**客户端要流式则透传
WorkBuddy 返回的 OpenAI 格式 SSE；要非流式则 shim 内部以 `stream:true` 打 WB 并聚合为单个完整
`chat.completion` 返回**（WB 私线强制 SSE，故 shim always-stream）。

一句话：**让你用自己 WorkBuddy 账号的额度（含 DeepSeek），作为 multi-proxy 之后的一层免费云兜底。**

---

## 它是什么 / 不是什么

- ✅ 是：一个独立的、零依赖（node `http`+`crypto`+`fetch`）的本地网关，端口 `18789`，绑 `127.0.0.1`。
- ✅ 是：把 WorkBuddy 的线协议（UA / 头链 / 请求体整形 / token 形态）锁在自己体内，
  multi-proxy 核心只把它当普通 OpenAI 兼容上游接 —— 符合项目「接入方不写解析、不改 wire 知识」的纪律。
- ❌ 不是：不读 WorkBuddy 桌面端私有存储、不做每日签到 bot（那是 dsh 插件里促销刷取的部分，风险高，已剔除）。
- ❌ 不是：不让你"免费用 DeepSeek"。它复用的是**你 WorkBuddy 账号自带的额度**，受配额上限约束。
  免费档的限流口径是「短时窗口请求次数」，不是并发也不是总量（与 Agnes 同理）。

---

## 红线（必读，对应 dsh 插件的 ToS 灰区）

1. **只用你自己 WorkBuddy 账号的 token**，通过 `WORKBUDDY_ACCESS_TOKEN` 显式注入。
2. shim **不读桌面端私有存储**、**不接签到 bot**。
3. 默认只绑 `127.0.0.1`；要暴露到网络前必须设 `WORKBUDDY_SHIM_AUTH_TOKEN`。
4. WorkBuddy 私有 API 在官方客户端之外调用属 ToS 灰区；**上游一改，本 shim 可能挂**——这是已知风险，不是 bug。

---

## 工作原理（已逆向，来源 dsh-workbuddy-connect / workbuddy2api，MIT）

WorkBuddy 上游聊天接口与 OpenAI 的差异，shim 全部吸收并转换：

| 差异点 | 上游要求 | shim 处理 |
|---|---|---|
| 端点 | `copilot.tencent.com/v2/chat/completions` | 固定目标 |
| 流式 | 私线强制 SSE（直连拒非流式） | 打 WB 强制 `stream:true`；客户端 `stream:false` 时聚合 SSE 成完整响应 |
| `role: developer` | 直接 400（11128） | 改写成 `system` |
| `tool_choice` 对象形态 | 只接受 `auto/required/<name>` 字符串 | 归一化；`none` 则连同 `tools` 删掉 |
| `reasoning_effort: 'off'` | 两个区域都拒 | 去掉 |
| 国际版 | 无 `system` 时首位补 `You are a helpful assistant.` | 补 |
| 鉴权 | `Authorization: Bearer <你的 token>` + 一堆 `X-*` 头 | 由协议纯函数生成 |
| 返回 | 原生 OpenAI SSE | 客户端流式→透传 SSE；非流式→聚合为 `chat.completion` JSON（已验证） |

所有转换都是 `server.js` 里导出的纯函数（`regionOf` / `prepareChatBody` / `prepareCnChatBody` /
`prepareInternationalChatBody` / `normalizeToolChoice` / `chatHeaders` / `resolveModelAlias`），
有单测覆盖（`test/protocol.test.js`），不触网。

---

## 获取 token（推荐：本机一键解密，零操作）

WorkBuddy 打包版**已锁死 DevTools**——asar 里菜单项按 `devToolsMenuEnabled` 条件隐藏
（`r?[...toggleDevTools...]:[]`），handler 第一句就是
`if(!devToolsMenuEnabled && !isPerfProfilingEnabled()) return;` 直接拦截。所以手动开 DevTools 抓
Network 在你机器上**不通**。改用内置解密工具，从你本机登录态直接解出明文 token（配方来自
dsh-workbuddy-connect 的 MIT 公开实现 `desktop-credential-protection.ts`，已在本机实测）：

```bash
cd workbuddy-shim
node decrypt-token.js            # dry-run：确认能解密、打印长度，不落盘
node decrypt-token.js --write    # 把 WORKBUDDY_ACCESS_TOKEN 写进 .env（启动 shim 即可用）
```

原理：用 `ELECTRON_RUN_AS_NODE=1` 跑 WorkBuddy 自己的 Electron 二进制
（`/Applications/WorkBuddy.app/Contents/MacOS/Electron`）取 at-rest 密钥，
`sha256` 派生后按 AES-256-GCM 解开 `workbuddy-desktop.info` 里 `accessToken` 的加密信封。
**零网络、零外部依赖、不启动 GUI、仅本机自用**。

> ⚠️ 这是 WorkBuddy 私有内部机制，上游升级改加密方案时本工具可能失效；届时翻
> dsh-workbuddy-connect 看最新配方即可。token 有过期，过期后重跑 `--write` 刷新。
> 企业/组织账号若 shim 报 401，再补 `.env` 里的 `WORKBUDDY_UID` / `WORKBUDDY_ENTERPRISE_ID` / `WORKBUDDY_DOMAIN`。

### （已弃用）手动从 DevTools 抓 —— WorkBuddy 打包版此路不通
旧文档写的 `Cmd+Shift+I` 开 DevTools 抓 `Authorization: Bearer` 的方法，在本机已确认无效
（DevTools 被 `devToolsMenuEnabled` 锁死），保留仅作背景，请勿照做。

---

## 安装与运行

```bash
cd multi-proxy/workbuddy-shim
cp .env.example .env        # 然后填入上面的 token
node server.js             # 或 npm start
```

起好后：

```bash
curl --noproxy '*' http://127.0.0.1:18789/healthz
# => {"ok":true,"signedIn":true}

curl --noproxy '*' http://127.0.0.1:18789/v1/models
# => {"object":"list","data":[{"id":"wb-deepseek-v3.2",...}]}
```

⚠️ 本机若设了 `HTTP_PROXY`（如 Clash），curl 打到 shim 必须 `--noproxy '*'`，否则会打到代理上。

### 常驻（launchd，镜像项目内 bridge 范式）

```bash
./launchd.sh install     # 注册到 ~/Library/LaunchAgents 并 bootstrap（端口 18789，loopback）
./launchd.sh status      # 看是否在跑
./launchd.sh restart     # 改了 .env / plist 后必须 kick 才生效
./launchd.sh uninstall   # 卸载
```

launchd 不可用时的降级：脚本会走 `nohup` 直起（只活到当前登录会话）。

---

## 在 multi-proxy 里注册为上游

WorkBuddy 与 generic-openai-proxy / manager 共用 `~/.multi-proxy-manager/providers.json`。
已写入一条 `provider_id=workbuddy` 的条目：

```json
{
  "name": "WorkBuddy",
  "provider_id": "workbuddy",
  "api_key": "workbuddy-shim-local",   // 占位：shim 用自己的 token，这个字段被忽略
  "base_url": "http://127.0.0.1:18789/v1",
  "models": ["wb-deepseek-v3.2","wb-deepseek-r1","wb-hunyuan-t1","wb-hunyuan-turbo","wb-kimi-k2","wb-glm-4.5","wb-qwen3-max"],
  "enabled": true
}
```

> generic-openai-proxy 的 `findProvider()` 优先按 `models` 精确匹配；所以客户端把 `model`
> 设成上面的 `wb-*` 之一，就会路由到本 shim。想加新模型：同时改 `providers.json` 的 `models`
> 和 shim `.env` 的 `WORKBUDDY_MODELS`。

客户端（WorkBuddy/Jarvis/Hermes/Cline/Aider…）配置：

```
base_url = http://127.0.0.1:18799/v1      # 指向 generic-openai-proxy
api_key  = any-non-empty
model    = wb-deepseek-v3.2               # 走 WorkBuddy 免费额度
```

---

## 模型别名

客户端用 `wb-` 前缀（如 `wb-deepseek-v3.2`），shim 转发前默认把 `wb-` 去掉，变成 WorkBuddy
真实接受的 `deepseek-v3.2`。需要自定义映射时设 `WORKBUDDY_MODEL_ALIASES`：

```
WORKBUDDY_MODEL_ALIASES=wb-r1:deepseek-r1,wb-v32:deepseek-v3.2
```

> 真实模型 id 来自你 WorkBuddy 账号的模型选择器（目录是动态的，`kimi-k3-1`、`minimax-m3`
> 这类会上下架，所以 shim 不硬编码，交给别名映射）。如果填错，WorkBuddy 会返回上游错误，
> shim 原样透传，按提示改别名即可。

---

## 冒烟测试

```bash
npm test                 # 协议纯函数单测（regionOf / prepareChatBody / 别名 / 头链…）
```

协议逻辑全部走纯函数单测覆盖（含非流式聚合 `aggregateSseToJson`）；涉及真实上游的端到端需要你自己的
token，先按上面「获取 token」填好 `.env` 再 `node server.js`，然后 `curl` 一次
`/v1/chat/completions`（`stream:false` 返回完整 JSON、`stream:true` 透传 SSE 均可）。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `/v1/chat/completions` 返回 401 `WORKBUDDY_ACCESS_TOKEN 未配置` | `.env` 没填 token，或 launchd 没把 .env 注入（确认 plist 的 env 或改用 `node server.js` 读 .env） |
| 上游 401/403 且配了 refresh token | shim best-effort 自动刷新一次；仍失败说明 refresh 也失效，重新取 token |
| 上游 429 | 免费档短时窗口请求次数限制（约 30~45s 恢复），降速或错峰 |
| curl 看到「upstream connect failed」 | 本机 HTTP_PROXY 拦截，加 `--noproxy '*'` |
| 模型报未知 | `wb-` 别名映射到的真实 id 不被 WorkBuddy 接受，核对账号模型选择器 |

---

## 与 dsh-workbuddy-connect 的关系

dsh 插件本质是 workbuddy2api 的壳：起一个 loopback shim，把 DSH 的 OpenAI 请求翻成 WorkBuddy
私线。multi-proxy 本就是 OpenAI 兼容代理 + 可插拔 provider，所以**那个 loopback shim 对
multi-proxy 是冗余的**——直接把本 shim 当普通上游接即可，且更干净（去签到 bot、零依赖、可单测）。

## 复用模式：vendor-agent bridge（本 shim 是第一个实例）

本 shim 不只是"接 WB"——它是 multi-proxy 一类新 provider（**subscription-backed provider：**
上游是另一个 agent 的登录会话/订阅额度，不是厂商 key）的参考实现。Claude Code、Codex、Cursor
这类自带订阅优惠的 agent，都能用同一套"定位登录态 → 私线翻 OpenAI → 带成本信号 → 门控"
的配方桥接进来，让用户在一个路由器里挑最便宜出口，**替代掉各 agent 自带的模型管理**。

设计文档见 `../docs/vendor-agent-bridge.md`。
