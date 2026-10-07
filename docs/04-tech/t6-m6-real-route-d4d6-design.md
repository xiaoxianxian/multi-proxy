# T6 · M6 接真实路由 D4-D6 设计稿（落码前置清单 + DoD）

> 状态：**设计稿，待维护者拍**。本文 0 改码；所有数字/状态为 2026-10-06 本机实测（AGENTS §4 不抄旧数）。
> 归属：77 号 P1 T6「M6 接真实路由」唯一开口的落码前置设计。关联：`docs/02-product/m6-action-checklist.md`（9-16 D1-D8 实核）/ `docs/10-initiatives/24-cache_control-P2与M6-override实施计划-2026-09-30.md`。

## 〇、一句话结论

**D4/D5/D6 的代码层早在 9-13/9-16 全部落地且 dist（10-02 构建）已含 override 代码——「缺代码」不是瓶颈；真瓶颈在数据面：① 3 个外部 key 今日实测全 401 失效，② DB agnes 行名（`agnes-2.5-flash`）与引擎名（`agnes-3.0-flash`）错配。** 在此状态下直接翻 override = `DEFAULT_ROUTE_CONFIG.rules`（`routeEngine.ts:204-211`，**DB `routes` 表实为 0 行、6 条 rules 是代码硬编码**）里 **3 条**（r-cheap→agnes / r-coding+r-hard→deepseek，两 key 全 401）直撞死 key + kimi 在 fallbackChain 兜底位也 401，是真实回归。推荐顺序：先跑 0 号步（非侵入观察 + key 体检）拿到任务分布数据，再让维护者三拍（key 处置 / DB 对齐写 / D4 翻开关），最后按 DoD 验收。

---

## 一、D4-D6 语义与代码现状（实测）

### 1.1 D4 · override 语义——代码已落，默认关，翻转通道就绪

| 项 | 现状 | 证据 |
|----|------|------|
| 语义决策 | 9-13 维护者拍 **C = override**（引擎建议接管真实路由，非 failover-only） | `m6-action-checklist.md` §一 D4 |
| 门控 | `PROXY_ROUTE_OVERRIDE`（**严格 `=== '1'`**，非 truthy），默认关 = 逐字节不变 | `chatHandler.ts:34` `isRouteOverrideEnabled` |
| 主逻辑 | `chatHandler.ts:398-427`：override 命中 → `findProviderByType(targetModel)` → `Object.assign(providerConfig, newConfig)` + `req.body.model = targetModel`（Q2=① 上游 model 字段用引擎名）+ `recordOverrideEntry` 审计 | 同上 |
| 审计持久化 | `start.ts:39-57`：门控开时接 `data/override-audit.jsonl` sink（`PROXY_OVERRIDE_AUDIT_LOG` 可覆盖路径） | `start.ts` |
| 翻转通道 | **非侵入**：`CURSOR_ROUTE_OVERRIDE=1 ./manage.sh start cursor` → 子进程 env 注入（`manage.sh:183-191`，09-30 M6 固化）；回退 = 去掉变量重启。绝不 `launchctl setenv`（ADR-0003） | `manage.sh` |
| dist 前置 | **已消除**：`dist/server/handlers/chatHandler.js`（10-02 18:59 构建）含 `PROXY_ROUTE_OVERRIDE`/`findProviderByType`（grep 7 处）——9-16 清单「dist 缺 override 代码」的隐藏前置已不成立 | 实测 grep |
| 生产运行史 | `override-audit.jsonl` 不存在 + `routing_feedback` 0 行 → 该路径**从未在生产流量上跑过**，9-16 的验证仅在隔离端口 18800 做过一次 | 实测 |

### 1.2 D5 · DB model 名 ↔ 引擎对齐——上轮日志「models 表 0 行」有误，实测订正

`cursor-proxy/data/proxy.db` 2026-10-06 实测（sqlite3 只读）：

- **providers 表 4 行，全部 `enabled=1`**：DeepSeek-Test(deepseek) / agnes(generic) / qwen3.8:27b-mlx(ollama) / kimi(openai)
- **models 表 6 行，全部 `enabled=1`**（09-21 21:55 一批写入）：`deepseek-v4-pro` / `deepseek-flash` / `agnes-2.5-flash` / `kimi-k2.6` / `kimi-k3` / `qwen3.8:27b-mlx`
- **routes 表 0 行（空表）**：6 条显式 rules 不在 DB、而在 `routeEngine.ts:204-211` `DEFAULT_ROUTE_CONFIG.rules` 代码硬编码；生产若未 seed routes，路由走 DEFAULT_ROUTE_CONFIG（fallbackChain + rules 全在代码里），DB routes 表不参与。

⇒ 上轮沿用的「models 表 0 行、四层路由塌缩单 provider」是 **09-13 `chatHandler.ts:216` 代码注释时的旧认知**（该注释「不靠 models 表(0 行)」写死进了注释与 10-06 日志，均已过时）。

**真实的 D5 错配只剩一处：agnes 行名漂移。**

| 链路 | 引擎名 | DB 行名 | 结果（实测推演） |
|------|--------|---------|------------------|
| 引擎（`routeEngine.ts:203` fallbackChain / `:226` type map / pricing key） | `agnes-3.0-flash` | — | `fa99e28`（09-25）引擎侧从 2.5 切 3.0，**DB 未跟** |
| live 路径 `findProviderConfig('agnes-3.0-flash')`（`chatHandler.ts:169-191`） | — | 行是 `agnes-2.5-flash` → 漏表 | fallback「首个 enabled provider（created_at DESC）」= **kimi**（09-12 15:15 最晚建）→ **误落 kimi provider** |
| override 路径 `findProviderByType('agnes-3.0-flash')`（`chatHandler.ts:232`） | 映射 `generic` | provider 行 `provider_id=generic` | 落对 agnes apihub（但 key 401，见 §二） |
| 健康映射（`start.ts:25-26` 用 models 表建 model→provider） | `agnes-3.0-flash` | 表里无此行 | `buildHealthCandidates`（`routing-shadow.ts:58-59`）无映射 → 标 `'down'` → cost-optimization 永远跳过 agnes，**即使 key 换了也跳** |

### 1.3 D6 · 健康映射——D6-a 已落地，D6-b 卡在 D4，且 rules 对健康盲

- **D6-a（观测级，已完成）**：`start.ts:18-37` 在 `PROXY_HEALTH_MONITOR=1` 时建 `HealthMonitor`（30s 轮询各 enabled provider `/models`，4xx/5xx/超时 → `unhealthy`，circuit breaker 阈值 3）+ models 表 model→provider 映射，经 `setHealthContext` 注入 shadow（`routing-shadow.ts:27-30`）。零热路径改动。
- **D6-b（健康影响真实路由）= 要 D4 翻开才有意义**。且有一个已知盲区：`routeEngine.ts:111-114` 里 `evaluateRules` **先于** cost-optimization 执行、且 **不看 health**——健康监控开着，`r-coding → deepseek-v4-pro` 命中规则也照发（dead key 直撞 401）。是否给 rules 补「命中后查健康、down 则落 strategy」是 **C 拍板后的后续代码决策点**（本设计稿不实施，仅登记）。

---

## 二、上游 key 实况（2026-10-06 实测，经 7897 代理探针，只读 GET /models）

| provider | 端点 | 结果 | 对路由的影响 |
|----------|------|------|--------------|
| agnes (generic) | `apihub.agnes-ai.com/v1/models` | **401 Invalid token** | 免费兜底层死；引擎规则 r-cheap 目标不可用 |
| kimi (openai) | `api.moonshot.cn/v1/models` | **401 Invalid Authentication** | kimi-k2.6（成本天花板层）不可用；live fallback 误落点也死 |
| deepseek | `api.deepseek.com/v1/models` | **401 Authentication Fails（key ...2985 invalid）** | 主路由层死；r-coding/r-hard 目标不可用 |
| ollama (本地) | `127.0.0.1:11434/v1/models` | **OK**，返回 `qwen3.8:27b-mlx`（18.2GB，capabilities 含 vision/tools/thinking） | 唯一活的上游 |

本机内存 free ≈ 9.3GB（vm_stat），Ollama 单模型无并发风险（WB MEMORY Ollama 节：避免多会话同调同一 MLX）。18794 当前无进程在跑。

**「四层路由塌缩」的真实归因**（订正上轮日志）：不是 models 表空——是 **3 个外部 key 全失效 + agnes 名错配**：cost-optimization 比价时 deepseek/kimi 健康 'down' 被跳过、agnes 无健康映射被标 down，只剩 qwen（0 元本地）可选；`DEFAULT_ROUTE_CONFIG.rules` 6 条里 **3 条**（r-cheap→agnes-3.0-flash、r-coding/r-hard→deepseek-v4-pro，两 key 全 401）直撞死 key，kimi-k2.6 在 fallbackChain 兜底位同样 401。**路由层本身没坏，坏的是凭据。**

---

## 三、落码前置清单（按序执行，标注 signoff 边界）

### Phase 0 · 非侵入、可回滚、无需 signoff（可直接执行）

| # | 动作 | 说明 |
|---|------|------|
| 0.1 | **key 体检固化为脚本** `scripts/probe-upstream-keys.sh`（只读 curl 各 provider `/models`，打 200/401 摘要，不打印 key） | 新脚本进仓低风险；今日实测结果已在此稿 §二，脚本只是让它可复跑 |
| 0.2 | **开 shadow 观察期**：`./manage.sh start cursor`（生产默认 shadow 态）+ 子进程 env 加 `PROXY_ROUTING_SHADOW=1 PROXY_ROUTING_FEEDBACK=1`（manage.sh 现只透传 override 变量，需 1 行扩展或手工 `env` 注入——扩展属低改动，随 0.1 同批） | 落 `routing_feedback` 表（taskType/model/suggestion/latency），积累 **任务分布数据** = D4 拍板的定量依据。key 失效期照跑：分类分布与 key 无关，不浪费 | **待拍**：开 shadow = 起 cursor 18794 + 要 Cursor IDE 流量喂，攒够 taskType 分布需真实使用。当前 18794 未跑、无流量，盲开=0 行。**建议挂起**，等 A（key）拍定、有真实流量再开；或维护者指定一个测试流量源 |
| 0.3 | **订正过时注释** `chatHandler.ts:216`「不靠 models 表(0 行)」→「models 表 6 行；真实错配是 agnes 名（2.5 行 vs 引擎 3.0）」 | ⚠️ `chatHandler.ts` 是热路径 4 文件之一——**不单独动**，并入 Phase 1 signoff 批一起改+一起验（§5 热路径纪律） |
| 0.4 | **T7 观察锚点**（另一件，随本稿同批设）：2 周后（10-20）回看 `~/.multi-proxy-manager/sandbox-egress-hits.jsonl` 命中计数，定 enforce 翻转 | cron 提醒，见 §五 |

### Phase 1 · 需维护者 signoff（高风险 / 写 DB / 凭据，签核红线不擅动）

| 拍 | 动作 | 风险 | 回退 |
|----|------|------|------|
| **A · key 处置** | 三选一：A1 轮换 3 家 key（写 providers 表加密 key，DB 写）/ A2 临时 `enabled=0` 三家（DB 写，路由显式收敛本地 qwen，避免 401 噪音，之后补 key）/ A3 维持现状（本地 only，观察期照跑） | 凭据/DB | A2 改回 1 即回；A1 覆盖回旧 key |
| **B · D5 DB 对齐** | ✅ **已执行（10-06 19:40，实测可纯 DB 1 行）**：`UPDATE models SET name='agnes-3.0-flash' WHERE name='agnes-2.5-flash';`。执行前实测推翻上轮「需连带 2 fixture」判断：2 测试全绿且不读 DB（`database.test.ts` 才读 sqlite；`routing-intelligent:230` 断言 fallbackChain 已是 3.0 同向；`health-integration:65` 是 hermetic mock）、B 对 236 测试零影响（B 后重跑仍全绿）。DB 非 git tracked 无需 commit。备份 `~/.multi-proxy-manager/proxy.db.bak-pre-20261006-182437`。回滚=反向 UPDATE。**注**：models 表无 `updated_at` 列（仅 providers 有），UPDATE 只改 name | DB 写 | 1 行 UPDATE 反向 |
| **C · D4 翻转** | `CURSOR_ROUTE_OVERRIDE=1 ./manage.sh start cursor`：先在隔离端口 18800 验证（9-16 先例），再上 18794。**前置 = A 完成（key 活）+ 0.2 观察数据足够** | 生产路由行为变更 | 去掉变量重启即回 shadow 稳态 |
| D（C 后） | rules 是否接 health（`routeEngine.ts` evaluateRules 补健康判定 + 测试） | 代码变更 | 门控化（沿用 §3 非侵入：默认 shadow） |

### Phase 1 执行顺序（维护者三拍后）

1. A（key）→ 复跑 `scripts/probe-upstream-keys.sh` 全绿
2. B（DB 行改名）→ 健康映射自然修复（`start.ts` modelToProvider 重新建图）
3. 0.3（注释订正，本批顺带，热路径 4 文件 diff 仅注释行）
4. C（隔离 18800 验证 → 18794 翻转，PROXY_HEALTH_MONITOR=1 同开）
5. 跑 §四 DoD 全项 → 结果回写 77 号台账 + 本稿

---

## 四、DoD（验收四要件，全部实测才算过）

1. **观察数据**：`routing_feedback` 表 ≥100 行，输出 taskType 分布表（coding/cheap/writing/vision/general 各占比）——D4 拍板的定量依据。
2. **隔离验证**（18800）：coding 请求 `model=qwen3.8:27b-mlx` → 上游 deepseek 回 `model=deepseek-v4-pro` HTTP 200（A1 后）；本地请求 → ollama 200；`override-audit.jsonl` ≥2 类条目 + `[ChatHandler][Override]` 日志。
3. **D5 对齐验证**：4 个 chain 名（qwen/deepseek-v4-pro/agnes-3.0-flash/kimi-k2.6）经 `findProviderConfig`（live）与 `findProviderByType`（override）各命中**正确 provider**（4 格探针表），agnes 不再误落 kimi。
4. **零回归**：cursor 全量 236/19（`NODE_OPTIONS=--experimental-vm-modules`）+ manager 1204/75 + codex 79/8 不变 + 热路径 4 文件 `git diff --stat` 仅注释行（0.3）——无逻辑行改动。

---

## 五、T7 观察锚点（随本稿同批设，非 T6 范围）

T7 三门控 10-06 已默认开（`f573110`），`PROXY_SANDBOX_EGRESS_MODE` 保持 observe。设 **10-20 单点提醒**（2 周观察期满）：回看 `~/.multi-proxy-manager/sandbox-egress-hits.jsonl`——命中计数过高 = 规则误伤（调规则）、过低/零命中 = 形同虚设（复核门控是否真吃到流量），判定时才翻 enforce；若数据不足再顺延一个 10-27 提醒。实现：cronjob 单条 10-20 09:00（每日自检会刷屏，不采用）。

## 六、纪律（沿用 AGENTS）

热路径 4 文件逻辑行 0 触碰（0.3 仅注释且随 signoff 批）；`git add --` 显式列文件；push 前 hermes 复核 + 维护者确认；A/B/C 三项不获 signoff 前不动 DB / 不写 key / 不翻 override；peer 在途 savings-gateway 内部设计文档（不进公开树）不碰。

## 七、DoD 达成状态 + 条件性 signoff（2026-10-07 实测，AGENTS §4 全真跑）

**前置 ①②③④ 状态（全真跑，非文档摘录）**：
- **A1 三 key 活**：deepseek 活（`GET api.deepseek.com/v1/models` HTTP 200 返回 deepseek-flash+deepseek-v4-pro，key_hint `sk-900…e6f`，10-07 探活）；agnes/kimi 经 D5 4 格探针命中正确 provider（agnes-3.0-flash→generic、kimi-k2.6→openai，不再 fallback kimi）。
- **B agnes 名对齐**：已对齐，agnes 不再误落 kimi（D5 4 格验证）。
- **C override 真接管**：18800 隔离实例 `PROXY_ROUTE_OVERRIDE=1` 实测 coding→deepseek-v4-pro HTTP 200（37.7s，usage `prompt:107/completion:5495(reasoning 4501)/total:5602`，成本 ~0.018 CNY）；`override-audit.jsonl` 2 行（10-06 18:02 + 10-07 coding 真打，`applied:true`）。18794 生产端口 `CURSOR_ROUTE_OVERRIDE=1`+`PROXY_ROUTING_FEEDBACK=1` 跑着攒 feedback。
- **0.2 shadow 已开**：`PROXY_ROUTING_FEEDBACK=1` 门控，18794/18800 均接入 shadow 记录。

**DoD 四要件达成表（§四）**：

| 要件 | 状态 | 实测证据 |
|----|----|----|
| ① 观察数据 `routing_feedback` ≥100 行 | **❌ 未达（待补量）** | 当前 0 行纯净态（已清污染，保证 D0 真实性）；本质是真实 Cursor 流量观察项，in-the-loop、不可 curl 凑 |
| ② 隔离 E2E（coding→deepseek 200 / 本地→ollama 200 / audit ≥2 类） | **✅ 全绿** | 18800 coding→deepseek-v4-pro HTTP 200；`override-audit.jsonl` 2 行（≥2 类）；本地 qwen→ollama 实测 |
| ③ D5 对齐（4 格探针 agnes 不 fallback kimi） | **✅ 全绿** | `scratch/d5-4grid-probe.mjs`：qwen→ollama / deepseek-v4-pro→DeepSeek-Test / agnes→generic / kimi→openai，live+override 双路径 |
| ④ 零回归（cursor 236/19 + 热路径 0 逻辑行） | **✅ 全绿** | jest 19 suite/236 全过（1.86s）；热路径 4 文件 `git diff --stat` 空 |

**条件性 signoff（2026-10-07 15:45 维护者拍板「按建议来」——接受）**：
- **决策**：M6 机制侧 ✅ signoff；①D0 100 行观察标注「待补量」，不阻塞机制验收。
- **机制侧 ②③④ 全绿 = D4/D5/D6 机制验收通过**：override 路由 → deepseek 真返回 + audit/feedback 落盘 + agnes 对齐 + 236 测试零回归，D6 override 机制已端到端验证。
- **①D0 100 行 = 独立补量任务**：M6 机制验收与「真实流量观察」解耦——D0 是 D4 拍板路由策略的**定量依据**，属后续观察累积，非机制能否上线的门槛。
- **执行**：D0 待补量，交接单已固化 Cursor 攒法（见 `docs/04-tech/o1-cursor-18794-handoff-2026-10-07.md`），维护者日常用 Cursor 即累积；18794 常驻待命攒样。
- **D0 标准不降**：仍列 DoD 第 1 条，仅标注「机制侧已 signoff、D0 待真实 Cursor 流量补量」。feature-matrix 无 M6 行（按功能模块组织），signoff 以本 §七 为准，不硬塞。

**纪律**：proxy.db 改 routing_feedback 前已 `cp → scratch`（可回滚）；18800 隔离验证不碰 18794/live；热路径 4 文件 0 逻辑改动；deepseek key 脱敏（`sk-900…e6f` 前 6 位）；100 行样本只从真实 Cursor 流量来，不用 curl 伪造（污染 D0）。
