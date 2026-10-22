# agent-conflict-check

独立、零依赖的**代理所有权冲突检测**工具 —— multi-proxy 的「签名能力」可分发副本。

## 它解决什么

你本地可能同时装了多个"代理工具"：multi-proxy、cc-switch、trae、workbuddy……它们都可能去接管同一个 coding agent（Codex / Hermes / Claude / OpenCode / Cursor）的流量。当某个 agent 的 `base_url` 指向了**另一个工具的端口**，就发生了"两个工具抢同一个 agent"的冲突——请求会被错误的一方吃掉，且很难排查。

本工具直接读各 agent 配置文件里的 `base_url`（而不是只看端口监听），判断它是否被 cc-switch 等其它工具占用，给你一份明确的"谁占了谁"报告。

> 判定哲学：端口监听 ≠ 正在代理这个 agent。配置文件里的 `base_url` 才是流量真正送出去的地方——这也是 multi-proxy 内核 `agent-owner.js` 的同款判定。

## 用法

```bash
# 人类可读报告
node cli.js

# JSON 输出（供脚本/其它工具消费）
node cli.js --json

# 只在有冲突时输出
node cli.js --quiet

# 自定义"占用端口清单"（逗号分隔，便于扩展 trae/workbuddy 等）
PROXY_OCCUPANT_PORTS=15721,12345 node cli.js
```

退出码：`0` = 无冲突；`1` = 检测到冲突；`2` = 运行错误。

## 三种结论（与内核一致）

| status | 含义 | 例子 |
|--------|------|------|
| `occupied` | 读到 base_url，且其端口在占用端口清单里 | codex `base_url=http://127.0.0.1:15721/v1` |
| `free` | 读到了配置真源，其中没有指向竞品端口的 base_url | claude 指向自家 18791 |
| `unknown` | 没有可解析的配置真源 / 文件不存在 / 解析失败 | cursor（base_url 在 GUI 里）、配置文件缺失 |

**`unknown` ≠ 安全。** 它表示"本工具证明不了"，上层不能把它当成"已确认未被占用"。

覆盖的 agent：`codex`（`~/.codex/config.toml`）、`hermes`（`~/.hermes/config.yaml`）、
`claude`（`~/.claude/settings.json` / `settings.local.json` 的 `env.ANTHROPIC_BASE_URL`）、
`opencode`（`~/.config/opencode/opencode.jsonc|.json`、`./opencode.jsonc|.json`，v1/v2 两种形态 + JSONC 注释），
以及恒为 `unknown` 的 `cursor` / `generic` / `dsh`。

## 自家端口永不误报

`base_url` 指向 multi-proxy 自己的端口（18790/18791/18792/18793/18794/18798/18799/18880）= 正确接入，不是冲突。即使你把 `PROXY_OCCUPANT_PORTS` 误配成含自家端口，内核也强制排除——宁可漏报，不可误报自家服务。

## 持续轮询（守护）

```bash
# 每 30s 轮询，日志写到 ~/.multi-proxy-manager/conflict-poll.log
node poll.js

# 每 10s，检测到冲突时弹系统通知（macOS）
node poll.js --interval=10 --notify

# CI / 手动只跑一次（退出码可用于门禁）
node poll.js --once
```

## 设计

- **零依赖**：仅用 Node 内置 `fs` / `os` / `path`，不要求整套 multi-proxy 安装——`npx` 即用。
- **只读**：只读各 agent 配置，绝不写入；文件不存在/解析失败一律降级 `unknown`，不崩。
- **不误报**：cursor 的 `base_url` 在 GUI 里（半自动）、无稳定配置文件可解析，工具返回 `unknown` 而非"冲突"；自家端口也强制排除。
- **与内核同源**：检测逻辑是 `multi-proxy-manager/lib/agent-owner.js` 的独立镜像副本（`conflict-check.js` 头部有同步纪律说明）。`agent-owner.js` 是 SSOT，本工具是它的可分发副本。

### 与内核的允许差异（形态差异，非逻辑分叉）

1. `detectOccupancy` 返回带 `agent` 字段、`detectAll` 返回数组（`cli.js`/`poll.js` 按数组消费）；需要内核同款对象形态时用 `detectAllMap()`。
2. 占用端口清单用 `occupantPorts()` 惰性读 `PROXY_OCCUPANT_PORTS`（常驻的 `poll.js` 改环境变量即生效），内核是加载期常量；判定优先级（自家端口优先排除）与内核一致。
3. 不 `require` manager 任何模块、不引第三方解析器（无 axios/yaml/toml），配置一律正则 / `JSON.parse` 读，与内核同款"够用即止"读法。

## 文件

| 文件 | 作用 |
|------|------|
| `conflict-check.js` | 零依赖检测内核（镜像 agent-owner.js） |
| `cli.js` | 命令行入口 |
| `poll.js` | 持续轮询守护（复用内核） |
| `package.json` | `bin: agent-conflict-check` |
