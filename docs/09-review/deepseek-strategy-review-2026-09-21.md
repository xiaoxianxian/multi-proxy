# DeepSeek 会话评审 · 竞争格局 + DSH 战略 + 老板三想法评估（2026-09-21）

> 来源：`chat.deepseek.com/share/26aeslhzz19kxgw3go`（右侧 preview pane 读取，未开用户 Chrome）。
> 该会话含 DeepSeek 三轮：① 七维度批评 ② 针对批评的具体建议 ③ 一人 vs 团队 vs 公司判断。
> 核实方式：竞争格局=web 搜索（外部事实，标注来源）；项目现状=本地 `docs/02-product/dsh-integration.md`、
> `l2/EXTERNAL-OPTIONS-REGISTER.md`、`docs/02-product/deepseek-baseline.md` 实读。
> 关联：`docs/09-review/deepseek-gap-assessment.md`（另一篇会话，讲文档缺口，本文不重不漏）。

---

## 一、地基事实纠偏：老板"已在做 DSH 插件路上" vs 记忆"DS2 阻塞"——不冲突，但要拆清

老板原话"已经在做成 dsh 插件的路上了"，与 §13.18"DSH DS2 保持现状等 DSH 0.2"表面冲突。实读 `docs/02-product/dsh-integration.md`（09-19）后厘清：

| 层 | 内容 | 状态 | 卡点 |
|----|------|------|------|
| **DS1** | `.dsh/skills/{multi-proxy,l2-orchestrator}/SKILL.md` + `dsh-plugin` topic 骨架 | ✅ 已做 | 无 |
| **DS2** | 发 npm bundle（`package.json` 加 `dsh.bundle` 字段对外发布） | ⏸ 暂缓 | **等 DSH 0.2 稳定** |
| **DS3** | 用户实际 `dsh plugin add` 运行 | ⏸ 暂缓 | 等 #1496 guardrail 修复 |

**关键区分（本文最重要）**：
- "**DS2/DS3 按 DSH plugin 形式发**" 被 **DSH 0.2 + #1496 外部因素卡住**——这层确实卡。
- 但"**抢占 DSH 生态位**"**不等于**"发 DSH plugin 包"。`agentgateway` 抢的是 **OpenAI 兼容网关形态**；
  DSH 天然吃 OpenAI 兼容 endpoint（其 README 原话 "will talk to any OpenAI-compatible endpoint"），
  **所以 L2 网关做成 OpenAI 兼容 + 省钱看板，DSH 用 dummy token 指过来就能省钱——这条快车道不卡 0.2。**
- 项目**已接得上 DSH**：`.dsh/skills` 两个 skill + L2 MCP bridge（`l2/mcp-server.js`，`routeTask`/`decompose`/`orchestrate`，
  门控 `PROXY_L2_MCP` 默认关）。**缺的不是"接得上"，是"发出去"。**

---

## 二、竞争格局核实（web 真查 · 标注来源 · 2026-09-21）

DSH（2026-08-13 开源，`npx @deepseek-ai/dsh web`，MIT，**0.1.0-rc.5 preview，版本在动**）生态已热：

| 竞品 | 做什么 | 来源 | 对项目的威胁 |
|------|--------|------|------|
| `agentgateway`(:4002) | OpenAI 兼容网关 + 路由 + 降本看板（Route/Log/Cost 一页） | maniak.io《Point DSH at standalone agentgateway》 | ⚠️ **最像 L2**，但缺"非侵入记忆复用"——**项目唯一差异化** |
| `dsh-system-proxy` / `dsh-proxy`(undici dispatcher) | 出站 fetch 劫持、纯透传 | DSH 插件商店 / dsh-pluginhub.dev | 不致命（不智能），但"已占"网络层生态位 |
| `dsh-full-remote` / `dsh-net-proxy` | 手机续看 / 本地路由 | github.com JUANWANG-BUAA / 鱼皮AI导航 | 不致命 |
| `dsh-cost-meter` / `dsh-token-viewer` / `dsh-context` / `DeepSeek-Balance-Whale` | **省钱看板**（峰谷计价、余额、贡献图、上下文） | dshpluginhub.dev / dshmarket.com | ⚠️ **省钱叙事已被做掉一部分** |
| `agentrouter-dsh-setup` | 接 AgentRouter，仅透传，硬编码 UA `claude-cli/1.0.0` | github.com Itsme23476 | 不致命（硬编码 UA 脆弱） |

**结论**：竞争不在"plugin 透传"（已有 8+ 个），在「**网关 / 智能路由 / 降本**」的**差异化**。
`agentgateway` 在切这块，**但"非侵入 + 记忆复用 + 按难度省钱"的组合还没人做**——这是项目的牌。

---

## 三、DeepSeek 七维度批评 · 逐条 grounded 到项目现状

| DS 批评 | 项目现状核实 | 贾维斯判断（DS 是否对） |
|---|---|---|
| ①定位过重 vs 痛点过窄 | L2 中台 10 内核 vs "省额度"核心诉求 | **半对**。架构没错，错在**暴露顺序**——README 开篇铺 L2 全景吓退只想省钱的用户。修法=**双入口**（省钱默认 / 编排显式） |
| ②非侵入理念好、路径没讲清 | 四铁律 + `agent-proxy-switch` 切 base_url | **对**。"切 base_url"本身是配置层侵入，含糊说"非侵入"不如**摊开讲**（`agentgateway`/`dsh-system-proxy` 竞品都摊开讲） |
| ③调度/成本策略黑盒 | `route-engine`+`cost.js` 有实现，文档未披露权重/规则 | **对，且最该补**。shadow 日志要算钱——竞品 `dsh-cost-meter`/`dsh-token-viewer` 已在算钱 |
| ④多技术栈维护重 | Node/Py/TS 三栈并存 | **对但非致命**。项目是"一人 + agent 开发"非社区贡献；**新 adapter 统一 Node** 这条建议可采纳 |
| ⑤缺 5 分钟快速开始 | 无 `quickstart/` | **最该先做**，高杠杆低成本 |
| ⑥安全/隐私没白皮书 | 有 JWT/bcrypt/AES-256-GCM/CSP/CORS，散落 | **对**。整理成 `docs/security.md` 即可，工程量小 |
| ⑦性能开销没量化 | 无 `docs/benchmark.md` | **部分对**。代理层开销可量化，但非最致命，可排后 |
| ⑧ DSH 场景 ROI > Codex，应优先做 | 见 §一/§五 | **方向对，结论修正**：缺的不是适配器，是"发出去"（§一关键区分） |
| ⑨ DSH plugin 用 fetch 劫持非侵入集成 | 社区已验证：`dsh-system-proxy`/`dsh-proxy`(undici dispatcher)/`dsh-proxy-routing`(SOCKS5) | **对**。现成路径可立刻复用 |
| ⑩ Octop 缓做但要看 | Octop=自托管多 Agent 平台 | **对**。option2 中间件已出 spec（`docs/octop-harness-failover-middleware-spec.md`），发版缓等 DSH 0.2 |

DeepSeek 自己排的建议优先级（它给的）：①双入口+快速开始 → ②非侵入边界说明+路由策略透明化 → ③安全白皮书；技术栈收敛+基准测试可稍后。

---

## 四、老板三个想法 · 明确判断

### 想法①：尽快抢占 DSH 生态，别憋大招，参考竞品取精华去糟粕
**✅ 同意，方向正确。修正点 = "抢占"≠"发 DSH plugin 包"。**
- 战略对：DSH 场景 ROI > Codex 成立（DSH token 方差大、省钱意愿强），`agentgateway` 已证明 OpenAI 兼容网关形态能吃 DSH。**但缺的不是接得上，是发出去。**
- **快车道（不卡 0.2，可今天动）**：L2 网关做成 **OpenAI 兼容 + 省钱看板**（仿 agentgateway：dummy token 进 → 路由到真实 key → 省钱日志一页）。内核（route-engine/cost/memory-merge）全现成。
- **被卡着的（等 DSH 0.2 + #1496）**：只限 `package.json 加 dsh.bundle 发 npm` + 实 `dsh plugin add`（DS2/DS3）。**别把"抢占"和"DS2/DS3 发包"绑死。**
- **取精华去糟粕（已映射好）**：
  - **取**：`agentgateway` 的 OpenAI 兼容快速接入 + Route/Log/Cost 一页；`dsh-cost-meter`/`dsh-token-viewer` 的峰谷计价/余额/贡献图；`dsh-system-proxy` 的 fetch 劫持零重启。
  - **丢**：纯透传无智能（`dsh-system-proxy`）、硬编码 UA `claude-cli/1.0.0`（`agentrouter`，脆弱）、不暴露安全边界。
  - **项目唯一差异化 = "非侵入记忆复用 + 按难度省钱"**，竞品都在透传，这块没人做。

### 想法②：用户痛点 → Marvis-GUI（GUI 降使用/学习成本）
**✅ 痛点直觉对，但载体优先级要调和。**
- 真问题不是"要 GUI"，是 **"5 分钟快速省钱模式"**（最小配置 2 provider + shadow → 观察 → 一键切真实路由）。这是 DS 排第一的最高杠杆动作。
- `marvis-p5-gui-design`（P5 草案，desktop 壳 + dashboard 6/7 页）是它的**呈现载体之一**，**锦上添花可延后**（与 5-决策②一致）。
- **调和结论**：先做"双入口 + 快速省钱模式"（低成本），GUI 作为其前端；别先砸 GUI 再谈省钱。
- **GUI 另一价值（呼应想法③商业化）**：对外讲"一人公司"故事时，能展示的桌面壳加分。

### 想法③：继续一人掌控，不引团队/公司
**✅ 完全成立，且是老板当前处境（待业 / 家庭负担 / 家中）的最优解。**
- **公司：现在不该做**。纯开源个人维护无收益反增税务；触发条件=收到企业采购/付费需求（目前没有）。
- **团队：时机未到**。DS 的"瓶颈信号"（核心抽象稳定 / 重复非核心任务 >20h·周 / DSH 进度被拖）目前**一个都没触发**。
- **唯一要听的隐性风险**：单人崩溃点=精力碎片化 + 单点依赖。结合家庭负担，**更要防**——集中打"非侵入记忆复用 + 省钱"一个差异化，其余透传活不做。
- **建议动作（降单点依赖，不招聘不公司）**：给 `adapters/dsh/` 开放写权限 + README 维护者说明 + help-wanted issue，**测社区是否有人主动接**。

---

## 五、总排序（贾维斯建议 · 供老板拍板）

1. **【立即·最高杠杆】"快速省钱模式"快车道**：OpenAI 兼容网关 + 省钱看板（仿 agentgateway），让 DSH 立刻能用、**不卡 0.2**。内核全现成。=抢占生态位的真动作。
2. **【高杠杆·低成本】双入口 + 5 分钟 quickstart + 路由策略透明化（shadow 算钱）+ security.md**（DS 批评 ①③⑤⑥，改 README/docs 不碰热路径）。
3. **【锦上添花·可延后】Marvis P5-GUI**（想法②，作为快速省钱模式前端载体，排 P5.0）。
4. **【待外部】DS2/DS3 发 npm dsh plugin**（等 DSH 0.2 + #1496）。
5. **【保持】一人 + 开放 adapter 目录测社区**（想法③）。

## 六、落地纪律（本轮）
- 本评审**已落盘未 commit、未 push、未碰热路径**（`forward.js`/`codex-proxy/proxy.js` 0 改动）。
- 数字口径：jest 基线现用 **701/701**（09-20 实盘），旧 `deepseek-gap-assessment.md` 的 837 已过期。
- 竞争事实均来自 web 搜索（外部，版本在动）+ 本地三文档实读；未编造。
- `DS2/DS3`、`dsh plugin add` 仍受 DSH 0.2 + #1496 阻塞——本文不解除该阻塞，仅厘清"抢占"与"发包"的边界。

_评审日期：2026-09-21 · 作者：贾维斯（Hermes Agent）· 关联：`dsh-integration.md` / `EXTERNAL-OPTIONS-REGISTER.md` / `marvis-p5-gui-design.md` / `deepseek-gap-assessment.md`_
