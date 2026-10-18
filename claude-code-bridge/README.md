# Claude Code bridge（subscription-backed provider 骨架）

> 复用 `docs/vendor-agent-bridge.md` 的「订阅型 provider」抽象。`workbuddy-shim` 是第一个参考实现，
> 本目录是它的**第二个候选实例的脚手架**——用来验证抽象确实可复用，但**不是可运行实现**。

## 为什么是骨架、不是成品

`workbuddy-shim` 能直接跑，是因为 dsh 插件（MIT）已经把 WB 的线协议、token 落点、头链
**完整逆向**并公开。Claude Code 那边我们没有等价的已验证逆向资料：

- **token 落点未知**：CC 的登录态在 `~/Library/Application Support/Claude/`（Pro/Max 订阅
  内含 bundled credits），但具体是 token 文件、OAuth 缓存还是 `claude` CLI 的 session，需要按
  真实客户端实测定位——不能猜。
- **线协议差异**：CC 客户端默认发 `/v1/messages`（Anthropic 格式）或 `/v1/chat/completions`
  （OpenAI 兼容）。multi-proxy 这边是 OpenAI 兼容，桥要做「CC 私线 ↔ OpenAI 兼容」的转换，
  协议对齐同样需要按真实 CC 客户端抓包确认。
- **ToS 风险不同**：CC 的订阅额度是否允许经第三方网关中转，条款比 WB 更不透明，需你拍板。

所以本目录给的是**结构 + 待实测清单**，把「框架层已经支持这一类 provider」坐实，
把「CC 特有的协议细节」明确标成 TODO，避免写出一个看起来能跑、实则编造协议的假实现。

## 与 workbuddy-shim 的同构点（已证明可复用）

| 维度 | workbuddy-shim | claude-code-bridge（待补齐） |
|---|---|---|
| 进程形态 | 独立 OpenAI 兼容网关，绑 127.0.0.1 | 同构 |
| token 注入 | `WORKBUDDY_ACCESS_TOKEN` 显式注入，不读桌面私有存储 | `CLAUDE_ACCESS_TOKEN` 显式注入（同红线） |
| 协议纯函数 | `regionOf` / `prepareChatBody` / `resolveModelAlias` … | `template-bridge.js` 占位同名函数，待填真实逻辑 |
| 模型前缀 | `wb-` | `cc-`（避免与真模型撞名） |
| 注册 | `providers.json` 一个 provider 指向 shim 端口 | 同构 |

## 落地前必须实测的三件事（TODO in template-bridge.js）

1. **定位 CC 登录态**：`~/Library/Application Support/Claude/` 下哪个文件/字段是上游要的 Bearer；
   参考 `workbuddy-shim/decrypt-token.js` 的「只取你自己登录态、零网络」原则。
2. **抓真实请求**：在 CC 桌面端/CLI 发一条消息，DevTools/代理抓 `Authorization: Bearer` + 端点
   + 请求体形态，照抄进 `prepareChatBodyForClaude()`。
3. **账单/免费信号**：CC 有没有类似 WB `usage.credit` / `badges` 的免费额度信号？有则接入
   `l2/savings-gateway/credit-profile.js`；没有则本 bridge 暂不参与「免费优选」。

## 红线（与 workbuddy-shim 一致）

- 只显式注入**你自己的** CC token；不读桌面私有存储、不接签到 bot。
- 默认**不接热路径**：本骨架不往 `providers.json` 写 provider、不常驻、不进 dsh-proxy 路由，
  直到上述三件事实测补齐、且你拍板 ToS 风险。
- CC 私线非公开，上游一改本桥可能挂——已知风险，不是 bug。

## 2026-10-17 调研结论：本机不具备桥接前提，建议暂缓

实地核查（未探 Keychain、未读任何 token 值，只看存在性与结构）：
- `~/.claude/` 无凭证文件（仅 CLAUDE.md / plugins / settings.json）。
- `claude` CLI 未安装（`which claude` → not found）。
- CC 访问走 cc-switch 3p 网关 → agnes（`~/.cc-switch/cc-switch.db` 在，项目已知路径），非 Anthropic 直连订阅。

⇒ **本机没有可桥接的 CC 订阅/登录态**：桥的输入端（CC token）不存在，现在建＝桥到空气。
⇒ **协议层不用重造**：现有 `claude-proxy`(18791) 已完整实现 Anthropic 私线（`/v1/messages` + `anthropic-version:2023-06-01` + `x-api-key`/Bearer 分发），真要做桥直接复用它，别在 template-bridge.js 里另写一套。
⇒ **抽象已被 workbuddy-shim 验证可复用**（第一个实例跑通），vendor-agent-bridge 的「框架支持订阅型 provider」已坐实，不必为凑第二实例而建。

**建议**：暂缓 claude-code-bridge。触发条件（满足其一再重启）：
1. 装了 `claude` CLI 且用 Anthropic 订阅直登（`~/.claude` 或 Keychain 出现真 token）；
2. 老板明确要桥某家有额度优惠的 agent 且接受其 ToS。

届时协议照抄 `claude-proxy/proxy.js` 的 `/v1/messages` 分支，token 落点按真实客户端抓包定位，仍守「只取自己登录态、零网络、默认不接热路径」三红线。
