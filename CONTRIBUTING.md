# 贡献 / 接入指引 — multi-proxy

> 给外部开发者与合作方的接入入口。先读 `docs/INDEX.md`(文档总入口)+ `AGENTS.md`(AI 代理铁律)。

## 项目状态(2026-09-23)

| 维度 | 状态 |
|---|---|
| 开源层 | 4 代理 + L2 内核(10 模块 + 4 守卫 + 13 demo)+ L1 网关 + 省钱网关 + 成本 watchdog + MCP bridge + 3 adapter,**100% 开源** |
| 服务层 | 未来闭源,预留 `services/`(仅文档,未落代码);凭据不出本机,服务层断网本机 100% 照常 |
| 测试 | manager **722/722** + codex **55/55** + cursor **193/193** + hermes **63/63** + L2 **13 demo / ~182 checks** + 省钱网关 **34/34** |

## 想做什么?找对应文档

| 意图 | 文档 |
|---|---|
| 5 分钟跑通 | `docs/quickstart.md` |
| 改/扩 L2 内核 | `l2/README.md` + `.dsh/skills/l2-orchestrator/SKILL.md` |
| 加新 agent adapter | `l2/adapter-protocol.md`(四类接口 + 能力声明 + 任务契约)|
| 接 MCP(主流 agent 零改造)| `.dsh/skills/l2-orchestrator/SKILL.md` §MCP bridge |
| 接 DSH 生态 | `docs/02-product/dsh-integration.md`(DS1 已落,DS2/DS3 等 DSH 0.2)|
| 看开放 vs 闭源边界 | `docs/04-business/open-core-boundary.md` |
| 非侵入纪律 | `AGENTS.md` + `.dsh/skills/multi-proxy/SKILL.md` |
| 竞品 backlog(I1 RAG / I2 圆桌 / I3 本地 LLM 一等公民)| `docs/04-business/vetarai-competitive-analysis.md` |
| 已知风险与待修复 | `docs/09-review/risk-register.md` |

## 接入层贡献(开源)

1. **铁律(非侵入,4 条,违反即打回):**
   1. **热路径不动**(`forward.js` / `codex-proxy/proxy.js` 非授权不改)。
   2. **不写 agent 文件**(`~/.codex` / cursor 配置 只读)。
   3. **不注入全局 env**(禁 `launchctl setenv NO_PROXY '*','...'`;曾崩全系统,AGENTS.md §2)。
   4. **门控默认关 / shadow 默认开**:新增能力不改变现状,观察后再开。

2. **lsof 用全路径** `/usr/sbin/lsof`(Node 子进程 PATH 不含 `/usr/sbin`)。

3. **git 规范**:
   - 显式列文件(`git add -- <file> ...`),**绝不 `git add -A` / `git add .`**。
   - commit 前 `git status --short` 确认恰好预期文件数。
   - 每批文档/功能单独 commit,message 说明内容。
   - **push 前需仓库 owner 确认**,不擅自推远端。

4. **测试必真跑**(铁律,AGENTS.md §4):
   - 新增/改动必跑全套;数字只取真实运行结果,不从文档摘录。
   - 改动热路径(若获授权)必跑 4 模块全测试不回归。

5. **PR/issue**:走 GitHub PR/issue,owner 审。CI 标签(建议加 `.github/workflows/`):
   - `pr-hotpath-guard`:PR diff 含 `forward.js` / `codex-proxy/proxy.js` 触发 hotpath-guard 门禁(单独 CI workflow)。
   - `pr-label-non-invasive`:PR 含 `gate`/`shadow` 改动,CI 验证「门控默认关」逐字节等价。

## 服务层贡献(闭源,需 owner 授权)

`services/` 预留位置,owner 授权后按 `open-core-boundary.md` 分层接入。原则:
- 服务层 **协议上就不接收** 用户 key / 代码 / 提示词 / 会话原文(红线)。
- 同步类:密钥客户端加密后再上传,服务端只存密文。
- 情报类:只上报聚合指标,不存原文。
- 服务层断网,本机功能 100% 照常。

## 想帮忙?认领哪个

| 缺口 | 优先级 | 入口 | 卡点 |
|---|---|---|---|
| 加新 adapter(任意 agent) | P0 | `l2/adapter-protocol.md` | 无 |
| DSH DS2/DS3 发 npm 包 | P0 | `docs/02-product/dsh-integration.md` | DSH 0.2 未发(外部)|
| I1 RAG 知识库(P0)| P0 | `vetarai-competitive-analysis.md §八` | 草图已出,未开发 |
| option2 failover middleware | P1 | `docs/octop-harness-failover-middleware-spec.md` | 跨语言(Python),老板发话再做 |
| 本地 LLM 一等公民(agent type:model)| P2 | vetarai-competitive i3 | 无 |
| 圆桌共识 mode | P1 | vetarai-competitive i2 | 无 |
| 卸载 plist 清理(README §十二#2)| P2 | `install.sh --uninstall` | 无 |
| CI 标签(PR 门禁)| P3 | 本文件「PR/issue」 | 无 |

## 行为守则

见 `.github/CODE_OF_CONDUCT.md`。

_最后更新:2026-09-23 · 贾维斯(Hermes Agent)。数字为本轮实测(722/55/193/63/34),会随迭代增长。_
