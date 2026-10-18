# multi-proxy —— 本地多编码代理的调度层

> 一句话：Codex / Claude Code / Cursor / OpenCode 照原来怎么用还怎么用，multi-proxy 站在中间，管住它们天天出事的几件小事。它不是又一个 Agent 框架，也不绑定任何 agent 厂商。

## 它解决什么

本机上同时装着几个 AI 编码工具时，有四件事天天出事：

| 场景 | multi-proxy 的做法 |
|---|---|
| cc-switch 占着 15721、Cursor 自带代理，某个 agent 的 `base_url` 被两个工具同时认领，流量去向不可预期 | **所有权冲突检测**：开代理前读各 agent 自己配置文件里 `base_url` 的实际指向，被别的工具占着就拒开（`lib/agent-owner.js` + `GET /api/conflicts`） |
| 每个 agent 各配一份 API Key，散在好几个配置文件里 | **统一入口 + 本地 `.env` 收口**：各家密钥只写一份，一个进程代发 |
| 花了多少钱说不清，哪个 agent 烧的更说不清 | **成本台账按 agent 归因**：每个代理、每个模型、每个客户端单独记账；上游单价 unknown 时记「未知」，不回落瞎估（`l2/relay-ledger.js`、`l2/savings-gateway/`） |
| 本地 Ollama 想和云端模型同台调度 | **本地是一档路由条件**：`privacy=true → 127.0.0.1`，是架构性保证，不是调参调出来的 |

## 三笔工程账（真正难抄的部分）

多模型路由聚合本身不稀缺，LiteLLM / one-api / New-API / TierFlow 都在做，**「支持本地模型」不是本项目的差异项**。真难抄的是这三笔：

1. **用量归一的自动识别** —— `lib/usage-probe.js` 只靠 usage 字段名形态就能认出不同供应商的记账口径，接入方贴一段上游原样 JSON 就够了。三家字段各不相同、Anthropic 的流式还在末事件里包一层，硬写三份解析器在跨版本升级上会反复返工。
2. **一个 agent 的 `base_url` 同一时刻只有一个所有者** —— 读的是各 agent 自己配置里 `base_url` 的实际指向，不是谁在听端口（端口在听 ≠ 正在代理这个 agent）。撞了就把该 agent 的开关置关并提示，不抢、不覆写。跨所有者的安全切换看 `tools/agent-proxy-switch`。
3. **本地是一档路由条件，不是一个开关** —— 路由规则打上 `privacy == true`，下游地址就是 `127.0.0.1`。

**只读接入，绝不写回**：5 个适配器只读 agent 的状态与结果，不改 agent 任何配置文件；编排路由默认影子模式，先记账、不动真实流量。

## 和云端 AI 网关（火山 AgentKit / 阿里云 AI 网关）不互斥

它们是**组织治理层**：合规分账、密钥托管、内容过滤、全链路日志，跑在远端。multi-proxy 是**本地层**：卡在你机器上的 agent 与上游之间。两层按需叠加，不是二选一。

叠着跑的时候你手上会有两本账，云网关一本、本地一本。本地那本不是重复建设，是你对账的底稿。

## 该说的话先说

- **只想省 API 的钱、要一个两分钟跑起来的网关，这个 repo 过重。** 它是为「本机多个 agent 同时在跑、数据不能出这台机器」这一层做重的。
- **MCP 管理、内容过滤、全链路日志目前没做。** 云网关在这些项上是现成答案，不嘴硬。
- **本地这一层的代价得自己扛**：一台机器的看护、升级、故障单点；叠着云网关跑还有双跳延迟和两本账的对账成本。

## 装与跑

```bash
git clone <你的仓库地址> && cd multi-proxy
bash install.sh          # macOS(launchd) / Linux(systemd --user) / Windows(PowerShell) 三平台同脚本
# 编辑各代理 .env 配置 API Key
manage.sh start all
# 管理面板 → http://127.0.0.1:18792
```

3 分钟跑一遍核心 demo（零副作用、影子模式、不碰任何 agent 文件）：`bash scripts/demo-tour.sh --quick`

**当前覆盖**：7 个代理适配器（codex 18790 / claude 18791 / hermes 18793 / cursor 18794 / opencode 18798 / generic 18799 / dsh 18797）+ 管理面板 18792。
**测试基线**（2026-10-14~15 实测全绿）：manager 1458 / generic 177 / claude 174 / codex 159 / opencode 159 / cursor 250 / hermes 77 / dsh 20 / l2 demo 51 / shell 11。

## 配图

- `推广素材-本地调度层定位.{svg,png}` — multi-proxy 在你本机上占哪一层
- `推广素材-与云网关能力对比.{svg,png}` — 八项能力逐行对照，★ 三笔工程账

（纯文字标签，不含任何品牌 logo；云网关数字均标“官方口径·非实测”。）

## 许可与免责

- 许可见仓库 `LICENSE`。
- 文中提及火山引擎 AgentKit、阿里云 AI 网关、LiteLLM、one-api、New-API、TierFlow 仅作品类对照，不代表任何合作、背书或关联关系；其性能与成本数字均引用官方口径，非本仓库实测。
