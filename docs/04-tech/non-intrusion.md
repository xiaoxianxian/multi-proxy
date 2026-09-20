# 非侵入边界白皮书 — 中枢如何做到"agent 感知不到"（2026-09-21）

> 来源：老板转 DeepSeek 会话（批评②"非侵入实现路径需澄清"）+ 项目 AGENTS.md 非侵入铁律。
> 核心：把"非侵入"的活证据摊开讲，消除"网关拦截 = 侵入"的观感冲突。
> 每节 grounded 到真实文件/代码行。**诚实标出现状缺口，不编造。**

---

## 一、"非侵入"的两层含义（先讲清，免歧义）

| 层 | 含义 | 本项目怎么做 |
|---|---|---|
| **L1 不写 agent 文件** | 中枢不写 `~/.codex` / `~/.cursor` / `~/.hermes` 等 agent 配置文件 | ✅ agent-registry 只写**中枢自己的** registry（`agent-registry.js:8` 注释"绝不写 agent 自身文件"）；文件持久化写注入 dir，绝不默认写 home |
| **L2 不注入全局 env** | 不 `launchctl setenv NO_PROXY` 污染系统 | ✅ `agent-proxy-switch` 只改 agent **自己 config 里的 base_url**，绝不碰 launchd（铁律②） |

> DeepSeek 担心的"网关拦截需要侵入 agent 网络配置"——**本项目的答案是 L1**：agent 的 base_url 指向本地代理端口，这是**用户在代理切换时显式选择的配置**，不是中枢偷偷写的，且切换有单一所有者铁律兜底（见 §三）。

---

## 二、活证据：`tools/agent-proxy-switch`（非侵入的活样本）

这是一条 11KB 的 bash 脚本，是"非侵入边界"最直观的物证（`tools/agent-proxy-switch`）：

- **单一所有者铁律**：同一时刻，一个 agent 的 base_url **只能指向一个代理**（cc-switch 或 proxy-rebuild），结构上不可能被两个工具同时拥有（不加锁即安全）。
- **绝不污染全局环境**：只改各 agent 自己配置文件里的 base_url；**绝不**用 `launchctl setenv NO_PROXY/no_proxy`。
- **不死链**：切到某代理前先确认它真在监听对应端口，否则拒绝写入（避免 agent 断连）。
- **不误伤**：切 codex 只动 codex 的 config，hermes/cursor 互不干扰。

支持的切换（`agent-proxy-switch` 注释）：
| agent | 可切 owner | 配置文件 |
|---|---|---|
| codex | `cc-switch` / `proxy-rebuild` | `~/.codex/config.toml` |
| hermes | `proxy-rebuild` / `direct` | `~/.hermes/config.yaml` |
| cursor | `proxy-rebuild` / `direct` | GUI（半自动） |

> 这就是"非侵入"的落地：**切换是用户用工具显式做的，中枢本身从不写 agent 文件、从不污染全局 env**。

---

## 三、四条非侵入铁律（贯穿 L2 全部模块，AGENTS.md §3）

| 铁律 | 落地 | 证据 |
|---|---|---|
| ① 不写 agent 文件 | registry/memory/skill 全写中枢自己的存储 | `agent-registry.js:8` 注释；`newFileStorage(dir)` 绝不默认写 home |
| ② 不注入全局 env | 代理自身 plist 内 `NO_PROXY=127.0.0.1,localhost,::1`（白名单，非通配） | `agent-proxy-switch` 铁律②；AGENTS.md §2 NO_PROXY 铁律 |
| ③ 不写死端口 | h3web adapter 动态探测 8731/8732 | 记忆 §"H3Web 端口漂移"；adapter 动态探测 |
| ④ 门控默认关 / shadow 默认开 | 新增能力不改变现有行为，观察后上线 | `PROXY_*` 系列门控（orchestration/alert/health/skill/memory/mcp 全默认关）；`route-engine.js:22` shadowMode 默认 true |

> ③ 不写死端口 / ④ 门控默认关 两条，是"非侵入"延伸到**行为层**：即便中枢接线了某能力，**默认零副作用、不改现有行为**，用户开了才生效。

---

## 四、[现状缺口] 诚实标注（避免观感冲突）

| 项 | 现状 | 证据 | 处置 |
|---|---|---|---|
| **agent base_url = 轻量侵入** | base_url 指向本地代理端口，本质是"配置层轻量侵入"（同 DeepSeek 提的 OpenCodex "两个 config.toml 条目"） | `agent-proxy-switch` 切换机制 | **已摊开讲**（本文 §二），不否认、不包装 |
| **更新兼容性** | agent 自身协议变 → 网关 adapter 需跟改；本项目用 adapter 协议隔离（`l2/adapter-protocol.md`），变更只动 adapter 不动 agent | `l2/adapter-protocol.md` | 已在协议里隔离 |
| **base_url 单一所有者** | 已用 `agent-proxy-switch` 单一所有者铁律兜底（不会多工具打架） | `agent-proxy-switch` | ✅ 已落地 |

> "非侵入"不是"零配置"，而是"**不偷偷写、不污染全局、可单向切回 direct**"。本文把这层讲透，消除冲突。

---

## 五、给用户的操作建议

1. **切/回代理用工具，不用手改 config**：`agent-proxy-switch <agent> <owner>`，含存活检查 + 单一所有者铁律。
2. **要完全绕开中枢**：`agent-proxy-switch <agent> direct` 把 base_url 指回真实服务商（`DIRECT_HERMES_URL=https://apihub.agnes-ai.com/v1`）。
3. **看谁在管哪个 agent**：`agent-proxy-switch`（无参）列出全部 agent 的当前所有者 + 端口状态。

---

## 六、grounded 总表

| 断言 | 证据 |
|---|---|
| 单一所有者 / 不死链 / 不污染全局 | `tools/agent-proxy-switch`（11KB bash） |
| 四非侵入铁律 | AGENTS.md §3 / §2 |
| registry 不写 agent 文件 | `l2/agent-registry.js:8` |
| 门控默认关 / shadow 默认开 | `server.js:65-84` 各 `PROXY_*` 默认关；`route-engine.js:22` |
| adapter 协议隔离 | `l2/adapter-protocol.md` |

_落盘：2026-09-21 · 作者：贾维斯（Hermes Agent）· 据实，缺口诚实标注 · 热路径零改动_
