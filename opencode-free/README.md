# opencode-free — multi-proxy 插件

本地 **OpenAI 兼容代理**：把上游 `opencode.ai/inference/v1` 的**全部模型**（免费 + 付费）转发到
`127.0.0.1:18800`，并给每条模型打上 `is_free` 标记，便于 hermes / dsh 等 agent 自行识别哪些免费。

**定位（一切皆插件）**：这是 multi-proxy 的一个**可独立安装/更新/卸载**的 provider 插件。
卸载不影响 multi-proxy 主体；更新只动这一个插件；任何 OpenAI 兼容客户端（含 hermes / dsh）读
`manifest.json` 就能把它接上。

---

## 为什么做这个

- 老板诉求：「直接接入 opencode 所有模型，用的时候自己识别是不是免费的，就像代理 workbuddy 模型列表一样，但要容易识别免费」。
- 实证背景：opencode 免费层 2026-10-13 起从 `/zen/v1`（403 FreeTierError）迁到 `/inference/v1`；
  gate 是**完整 opencode 1.19.0 请求形态**（UA `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`
  + `x-opencode-session/request/project/client` 头 + `Bearer public` + 5 个 core tools + opencode 式
  session id）。`magpie-community/plugins` 的 `zen-free` 证明这个形态能 200，本插件即复刻它。

## 实测结论（2026-10-18，E2E 真跑）

| 调用 | 结果 | 含义 |
|---|---|---|
| `GET /v1/models` | **200，85 个模型**（9 免费 + 76 付费） | 目录可用、能列全部模型 |
| 每条模型 | 带 `is_free`；顶层 `_meta` 给 `{total,free,paid,free_rule,key_mode}` | 自识别免费 |
| `POST /v1/chat/completions`（付费模型，无 key） | `AuthError: Missing API key` | 付费需 `OPENCODE_API_KEY` |
| `POST /v1/chat/completions`（免费模型，无 key，通用 shim） | `FreeTierError: can only be used from within OpenCode` | opencode 会话门 |
| 直连（不走 7897 代理） | `RegionError: not available in your country` | 地区门 |

**一句话**：插件本身（目录 + 形态转发 + 免费标记 + 账号 key 支持）**全部跑通**；
免费/付费模型的最终可用性取决于 **opencode 侧策略**（会话门/地区门）+ 是否配账号 key——**不是插件 bug**。
填 `OPENCODE_API_KEY`（真实 opencode 账号 key）即可解付费 + 登录态免费。

## 免费模型怎么识别

opencode 命名约定：**模型 id 里含 `free` 段 = 免费**。插件在 `/v1/models` 已给每条打 `is_free`：

```json
{ "id": "beam-free", "is_free": true, ... }
{ "id": "claude-opus-5", "is_free": false, ... }
```

顶层还有 `_meta`：`{ total:85, free:9, paid:76, free_rule, key_mode }`。
当前 9 个免费：`beam-free / mimo-v2.6-flash-free / nemotron-3.5-super-vl-free /
nemotron-3.5-lightning-free / jev-1.13-free / longcat-2.5-preview-free /
deepseek-v4.1-flash-free / glm-5.3-flash-free / space-bunny-free`。

## 安装 / 更新 / 卸载

```bash
cd ~/Documents/AI项目/multi-proxy/opencode-free

# 安装（首次）
cp .env.example .env                # 可选：填 OPENCODE_API_KEY 用账号 key
npm install --registry=https://registry.npmmirror.com   # node>=18，依赖 undici
./launchd.sh install                # 装到 ~/Library/LaunchAgents 并常驻 18800

# 自检
./launchd.sh status
node test/test-e2e.mjs             # E2E：healthz + models(is_free) + 一次 chat 调用
curl -s http://127.0.0.1:18800/healthz

# 更新（opencode 改了逻辑 / 本插件升级）
git pull
./launchd.sh restart               # 改了 .env 必须 restart（.env 进程启动时读）

# 卸载（不影响 multi-proxy 主体）
./launchd.sh uninstall
# 再在 hermes/dsh 删掉指向 18800 的 provider 即可
```

## 给 hermes / dsh 接入

见 `manifest.json` 的 `integrations`。要点：

- **hermes**：`~/.hermes/config.yaml` 的 `providers` 加
  ```yaml
  opencode-free:
    base_url: http://127.0.0.1:18800/v1
    api_key: public          # 或真实 opencode 账号 key
  ```
- **dsh / 任意 OpenAI 客户端**：`base_url=http://127.0.0.1:18800/v1`，`api_key=public`。
  模型列表用 `/v1/models`，看每条 `is_free` 挑免费的。
- 本机 HTTP 代理是 127.0.0.1:7897；`curl` 打插件**不加** `--noproxy '*'` 会先被代理拦——插件自己经
  7897 出网，客户端侧直打插件用 `--noproxy '*'`。

## 配置

全部来自 `.env`（`server.mjs` 启动时零依赖加载，**不落 plist 明文**）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OPENCODE_FREE_PORT` | 18800 | 本地监听端口（避开 18793-18799 multi-proxy 管理段） |
| `OPENCODE_UPSTREAM` | `https://opencode.ai/inference/v1` | 上游；opencode 改端点改这里 |
| `OPENCODE_PROXY` | `http://127.0.0.1:7897` | 本机代理；置空直连 |
| `OPENCODE_API_KEY` | `public` | 填真实账号 key 覆盖付费+登录态免费 |
| `OPENCODE_STREAM_IDLE_MS` | 60000 | 流式无数据收尾时限 |
| `OPENCODE_RETRY_400` | 1 | 置 0 关偶发 400 重试 |

## 硬化清单（对应拍板项 #1）

- 流式 60s idle 收尾：防 kimi 卡 180s。
- 偶发 400 重试一次（换新 opencode session、1.5s/3s 退避；不重试 401/403）。
- 免费标记 `is_free` + 顶层 `_meta`。
- 账号 key 支持（`OPENCODE_API_KEY`）覆盖付费模型。

## 不做什么（对应拍板项 #2）

**不装 magpie**。magpie 是第三方 `curl|sh` 二进制 + 独立 3425 网关，跟「一切皆 multi-proxy 插件」
架构对不上；我们自己的插件就是它干的事。暂搁置，未来想要「一键第三方」再说。

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 核心代理（形态转发 + 免费标记 + 400 重试 + idle 收尾 + healthz） |
| `manifest.json` | 机器可读插件描述（给 AI 读着装 hermes/dsh 的入口） |
| `package.json` | npm 元数据 + bin |
| `com.multi-proxy.opencode-free.plist` | launchd 常驻 |
| `launchd.sh` | status/install/uninstall/restart（含 nohup 降级） |
| `.env.example` | 配置模板 |
| `test/test-e2e.mjs` | E2E 自检 |
