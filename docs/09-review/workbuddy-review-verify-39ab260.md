# WorkBuddy 七角色评审 · 当前 revision 核对报告（39ab260，2026-09-24）

- **评审对象**：`/Users/xiaota/Documents/AI项目/multi-proxy`
- **被核对的总报告**：`/Users/xiaota/WorkBuddy/2026-09-14-09-45-18/multi-proxy-评审-2026-09-23/00-总报告.md`（7 角色 · 严重强迫症人设 · 独立复现 P0 · 只读+隔离端口 · 4405 行逐条含 `文件:行`）
- **核对 revision**：`39ab260`（评审针对的是 `ab1e4d2 ~ 0c1a969`，09-23 快照；本核对在 09-24 当前 HEAD）
- **方式**：逐条核对代码位点（真读文件、不抄文档），区分「仍成立 / 已修 / 部分修正 / 需精化」，给优先级。
- **约束遵守**：本报告只读核对 + 分析，**未改任何源文件、未 commit/push**；热路径 `forward.js`/`codex-proxy/proxy.js` 0 触碰。

---

## 0. 元信息核对（两条，均属实）

1. **移动靶属实**：评审区间 `ab1e4d2~0c1a969` 确在历史；09-23 之后到 `39ab260` 的 commit（`e5aed42` kimi 定价 / `b639951` M2 接线+logs 契约 / `b3aae5f` 知识库 UI / flaky 四件）**均未触碰安全相关文件** → 评审的 P0 安全类在 39ab260 上**大概率仍成立**。本轮已逐条坐实。
2. **测试数字与 README 脱钩属实**：`README`「882/882 全绿」是复制值；实跑是 manager 768（09-24 复核）+ codex 59 + cursor 193 + hermes 77 + shell 15+25 ≈ 1074（数量级）。**同一份绿被复制到 8+ 文档**，无 CI 门禁。

---

## 1. 关键纠偏（评审是 09-23 快照，2 条对 39ab260 已部分过期）

| 总报告原结论 | 39ab260 实况 | 判定 |
|---|---|---|
| **P1-1「cursor-proxy `/admin-api/*` 完全无鉴权，一个月前已报至今未闭环」** | `cursor-proxy/src/server/app.ts:34` **已挂 `requireAdminAuth`**（注释 `P0-4`，源码 `33a542c` 改名 commit 即有，**非本次评审后新修**）；`dist/server/app.js`+`middleware.js` 已编译进 `requireAdminAuth` | **部分过期**：鉴权中间件已存在；**残余风险=`PROXY_AUTH_TOKEN` 空时仍 `fail-open`**（`middleware.ts:12` `if(!ADMIN_AUTH_TOKEN) return next()`），与 codex/hermes 同款 fail-open，非 cursor 独有 |
| **C0-1「三 proxy token 泄露」**（笼统） | codex-proxy 确证 3 件齐发（见 §2）；**hermes-proxy 绑 `127.0.0.1`（`proxy.py:704`）**，不暴露；只有 codex `app.listen(PORT)` 全网卡 + 吐 token 全文 | **codex 为真 P0；hermes 默认安全**；三 proxy 共性是 `fail-open` |
| **C0-4 / P2-5 / P2-6 汇率·dist 陈旧** | `dist/server/start.js` mtime `09-16 17:48` ≪ `src/pricing/seed.ts` `09-23 19:31`；`process-manager.js:47` 只 `existsSync` 不比 mtime → **dist 确证陈旧** | 仍成立 |

---

## 2. P0 核对（39ab260 上仍成立，均带 `文件:行`）

### 🔴 C0-1 真 P0（codex-proxy 凭证泄露，坐实）
- **fail-open**：`codex-proxy/proxy.js:22` `if (!AUTH_TOKEN) { /* no token set */ return next(); }`；`AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || ''`（`:18`）→ **默认空 = 鉴权不启用**。
- **吐 token 原文**：`/api/config`（`:309-315`）→ `parseConfigToml`（`:60`）`return { ..., raw: content }`（`:98`）**回 config.toml 全文**；`findConfigToml` 命中 `~/.codex/config.toml`（已核实存在，**含 bearer + sk- token 行**）。即 `curl http://<LAN-IP>:18790/api/config` → 200 + 真实上游 token 裸奔。
- **公网可达**：`app.listen(PORT)`（`:657`）无 host = 全网卡 0.0.0.0；默认 `PORT=18790`（`:16`）无 127.0.0.1。
- **修复**：① `/api/config` 对 token/api_key/sk- 行做掩码或只回白名单字段；② 默认绑 `127.0.0.1`（hermes 已是范本）；③ fail-open 改 fail-closed 或至少启动时醒目 WARN。

### 🔴 C0-2 真 P0（存储型 XSS，坐实）
- `multi-proxy-manager/public/dashboard.html:1560/1561/1723` 把 `esc(a.id)`/`esc(s.sessionId)` **拼进 `onclick="..."` 属性**；`esc()`（`:1098`）做 HTML-entity 转义（`'`→`&#39;`），但浏览器**先解码 entity 再交给 JS**，引号逃逸 → 点击即执行。
- 后端 `l2/agent-registry.js:30 validate()` 只校验 `typeof id==='string' && id 非空`，**不校验字符集** → 注入 `id` 落库返回 201，点击触发。
- **修复**：① 前端改 `addEventListener` + 事件委托，禁把数据拼 `on*` 属性；② 后端 `validate()` 加 id 字符集正则（如 `^[a-z0-9._-]+$`）。

### 🔴 C0-3 价值闭环未接线（坐实，= 本项目 Q3）
- **智能路由不进热路径**：`route-engine.js:124` shadow 模式「只记录不执行」；`proxy.js:589` 聊天链路直接 `proxy.provider.baseUrl`，**从不触达 L2** → 路由决策对真实请求 0 影响。
- **成本闭环 0 接线**：`l2/cost-watchdog.js`(304 行)/`l2/cost.js` 生产消费者 0；`lib/cost-track.js` 门控默认关；**无 `/api/cost` 读接口**；面板成本数字来自 `dashboard.html` `Math.random()*100` 假数据。
- **可观测缺字段**：`/api/status` 无 model/cost/balance。
- 结论：`ACCEPTANCE-CHECKLIST` 的「已上线」在**运行态不成立**。成本闭环正是老板 Q3 待办。

### C0-4 / C0-5 / C0-6（部分坐实）
- **C0-4 dist 陈旧**：坐实（`process-manager.js:47` 只 `existsSync`，dist 09-16 ≪ src 09-23）。修复：启动前比对 `dist` vs `src` mtime，落后拒启或自动 build。
- **C0-5 安装死点**：`install.sh` 涉 Docker 主路径 + `logs/` 不建 + `.env.example` 不存在——**本轮未逐条坐实**（属 shell 死点，需单独跑 install.sh 干跑），标「待核实」，不盲信。
- **C0-6 测试证据失效**：codex 59 测试不覆盖 `proxy.js`（内联重建 app）→ P0 修完无处验证；`pricing-cache-drift.test.ts` 两逃生口恒绿；`jest --coverage` exit=1 但无 CI 门禁。→ 修 P0 必须先补 codex-proxy 真实门禁测试。

---

## 3. P1 抽样核对（均 09-23 快照，39ab260 上仍待逐项确认）
- A1 三 proxy 零共享抽象（含跨语言镜像）；A4 L2 HTTP 面鉴权不一致（`/api/mcp`/`/api/orchestration` 匿名可读 vs `/api/logs` 需 auth）；A10 错误脱敏 5 处裸回 `e.message`。
- P1-2 `mcp-server.js` `const id` 被重赋值 → 异常误报 `-32700` 且 id=null；P2-3 `hasCycle` 只读 `dag.edges` ≠ 调度 `deps`；P2-5 `estimateCost` cacheHit 不参与（`Math.max` 写法）；P2-6 汇率兜底方向反 + `DEFAULT_FX_USD_CNY` 未接线。
- 前端：自动刷新被永久杀死、假成功反馈群、mock 兜底覆盖「离线」、变量提升恒不可用；契约漂移（`/api/errors/patterns` 等不可达、字段名不符恒空/恒 `-`）。

> P1 条目量大、多为低危累积项，本轮不逐条坐实，建议**修完 P0 后由测试轮统一核对**，避免「移动靶」二次过期。

---

## 4. 优先级（39ab260 视角，给老板拍板）

**第一批 · 安全 P0（必须，真实漏洞）**
| # | 项 | 落点 | 风险 | 说明 |
|---|---|---|---|---|
| **P0-A** | codex-proxy `/api/config` 掩码 token / 白名单字段 | `proxy.js:309-315,98` | 热路径(读) | 真凭证泄露，最紧急 |
| **P0-B** | codex-proxy 默认绑 `127.0.0.1` | `proxy.js:657` | 热路径 | hermes 已范本 |
| **P0-C** | 三 proxy fail-closed 或启醒目 WARN | `proxy.js:22`/`proxy.py:46`/`middleware.ts:12` | 低 | 共性 fail-open |
| **P0-D** | XSS：`addEventListener`+委托 / id 字符集 | `dashboard.html:1560-1561,1723` + `agent-registry.js:30` | 低 | 真漏洞 |
| **P0-E** | codex-proxy `proxy.js` 真实门禁测试 + 拆 drift 逃生口 + 上 CI | 测试基建 | 低 | 否则 P0 修完无从验证 |

**第二批 · 价值闭环（让卖点不空）**
| # | 项 | 落点 | 风险 | 说明 |
|---|---|---|---|---|
| **P1-A** | L2 接进热路径（门控默认关，shadow→可生效；共用 AgentRegistry 单例；`/api/mcp/call` 改 `callToolAsync`/`handleMessageAsync`） | `route-engine.js`/`routes/mcp.js`/`registry` | **中** | ≈3 处、不破铁律，但是功能改动 |
| **P1-B** | 成本闭环（= 老板 Q3）：`/api/status` 补 model/cost/balance + `/api/cost` 接 cost-watchdog 实采 + 去 `Math.random` | 热路径 + 新读接口 | 中 | 即 Q3，单独一轮 |

**第三批 · P1~P3 清理（低危累积/文档）**
- dist 陈旧门禁（C0-4）、测试数字收敛到单一来源 + 删 5-6 套复制值、README 链接、install.sh 死点（C0-5 待核实）、`const id`→`let id`、错误脱敏统一、面板死代码/假数据清理、失实文档修订。风险低，量大，修完 P0 后批量。

---

## 5. 核对方法学结论（供后续 agent）
- **多 agent 协作铁律兑现**：先读对方产出（WorkBuddy 8 份）→ 不照搬，逐条回源到「我当前 revision 的代码」→ 用 git 查「是不是我 09-23 后修的」（发现 cursor admin-api 鉴权非评审后新修、是 09-23 快照就过期项）。
- **移动靶教训**：任何跨会话/跨 agent 的评审结论，落地前必须按当前 HEAD 重核对文件:行号与 git 历史。
- **本轮 0 改源文件 / 0 热路径 / 0 commit**，仅本报告 `docs/09-review/workbuddy-review-verify-39ab260.md`。
