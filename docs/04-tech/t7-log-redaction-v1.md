# T7 · log_redaction 出站脱敏 v1 提级 · 设计稿（2026-10-06 hermes）

> 触发：77号 §4.1 P1 表 T7「`log_redaction` 出站脱敏是否提级 v1（对标 agentgateway）」，依赖 T5 已收口。
> 性质：**已拍板已闭环**（10-06 维护者拍 A 全提 + 注入缝；实测 1204/1204 全绿，见 §八）。脱敏本体在 10-04 75号批已全部落地，本稿只做「v1 提级」决策 + 5 个最小改动。

## 一、真相核实（先纠正 77号 10-05 旧认知）

77号 §4.1/§4.2 把 T7 标「待做/待拍」，但脱敏本体**在 10-04 75号批已全部落地并 push**（`63c47b8`，热路径 4 文件 0 触碰）：

| 模块 | 文件 | 门控 | 状态 |
|------|------|------|------|
| 出站脱敏纯函数 | `multi-proxy-manager/lib/redact.js`（98行，6 类规则：私钥/JWT/API key/连接串密码/身份证/银行卡） | `PROXY_REDACT`（默认关） | ✅ 已落 |
| 上游横向体检 | `multi-proxy-manager/lib/upstream-check.js` | `PROXY_UPSTREAM_CHECK`（默认关） | ✅ 已落 |
| 出站脱敏+入站工具调用检查包 | `packs/sandbox-egress/{index.js,pack.yaml}` | `PROXY_PACK_SANDBOX_EGRESS`（默认关）+ `PROXY_SANDBOX_EGRESS_MODE`（默认 observe） | ✅ 已落（含 10-04 晚 `enforce` 真切断） |
| 热路径接线 | `lib/forward.js` 两处（出站 `:155-161` `sandboxEgress.inspectOutbound`、入站 `:194-195` `inspectInbound`） | 门控关=零副作用 | ✅ 已落 |
| 测试 | `tests/unit/sandbox-egress.test.js` 19/19 + `tests/unit/forward-egress-e2e.test.js` 7/7 真 HTTP 回环（7 用例：门控全关零副作用/出站真脱敏/observe 不断/enforce 真替换 OpenAI+Anthropic 双形态 tool_calls/干净响应逐字节原样） | — | ✅ 已落 |
| log_redaction 三档 | `l2/route-engine.js:30-46/78/252/296-307`（`full`/`metadata_only`/`off`，`_redact(prompt)` 已挂 decision log） | 默认 `full`（零行为变更） | ✅ 已落 |

75号 §六已诚实标注「回程占位符变回真值未做」——已知取舍，非 bug。75号 §九 还实证了 3 个坑（路径两跳不是三跳/判据 3 守卫别自作聪明/pack 复用 lib 时 env 要一起开），全部已写进代码注释。

**77号标「待做」是 10-05 审计视角没意识到 10-04 75号批已落码——又一次「已落地误读成待做」。** 本稿不重新写脱敏模块（YAGNI），只做 v1 提级。

## 二、T7 真实范围：3 个已落地门控翻到 v1 生产态

v1 = 默认关 + 默认 observe 的 3 个门控翻到生产默认开 + 1 个 observe 观察指标 + 1 个 enforce 观察期。

### 决策点 1 · 3 门控提级顺序（按风险从低到高）

| 门控 | 现状 | 风险 | 建议 |
|------|------|------|------|
| `PROXY_REDACT`（出站脱敏） | 默认关，热路径只做 1 次布尔判断（< 1μs） | **极低**：脱敏感知不破坏 agent 运行（75号 §六 已声明占位符变不回是取舍） | **优先提**（默认开） |
| `PROXY_UPSTREAM_CHECK`（上游横向体检） | 默认关，纯读 | **低**：只读 `applyTokens` 出口，不打真实流量 | 同批提 |
| `PROXY_PACK_SANDBOX_EGRESS`（出站脱敏+入站工具调用检查包） | 默认关 observe，enforce 才动响应体 | **中**：enforce 改上游响应体（tool_use/tool_calls→说明文本），observe 零副作用 | observe 默认开；enforce 留 1-2 周观察期 |

### 决策点 2 · enforce 观察期（75号 §九 已写）

enforce 前必须跑 observe 观察命中率。指标：`[sandbox-egress] inbound tool-call inspection <mode> <proxy> [...]` 日志的命中计数。
- 命中过高 = 规则太宽误伤正常工具调用（一个合法 `sh -c` 也能撞上）
- 命中过低 = 形同虚设
- 观察期：`PROXY_SANDBOX_EGRESS_MODE=observe` 跑 1-2 周 + 新增 hits 落盘（见下 §三·#4）

### 决策点 3 · 配置面（3 门控当前全走 env）

3 门控目前只在 plist/`.env` 里设，管理台没有开关。v1 可选增量：
- A：管理台 `proxy-config.html` 加 3 个 checkbox，写 `.env` + 重启
- B：仅 env 开关（维护者手工）
- **C（推荐）**：YAGNI 不建 UI，门控保持 env 配置，提级价值不依赖 UI

## 三、提级改动清单（5 最小改动 + 1 新 demo，热路径 0 触碰）

| # | 改动 | 文件 | 说明 |
|---|------|------|------|
| 1 | `PROXY_REDACT` 默认翻 `true` | `lib/redact.js:40` `enabled()` | 1 行缺省 flip；显式关仍可（`PROXY_REDACT=0`） |
| 2 | `PROXY_UPSTREAM_CHECK` 默认翻 `true` | `lib/upstream-check.js:22` `enabled()` | 同 1 |
| 3 | `PROXY_PACK_SANDBOX_EGRESS` 默认翻 `true`（observe） | **根目录** `packs/sandbox-egress/index.js:34` `enabled()` | observe 默认开，enforce 留 1-2 周观察期（`PROXY_SANDBOX_EGRESS_MODE:40` 不动，仍默认 observe） |
| 4 | observe 命中计数落盘（新增） | `packs/sandbox-egress/index.js` `inspectOutbound/inspectInbound` 现有 `console.log`（`:50/:63`）改/增 `recordHit()` | `~/.multi-proxy-manager/sandbox-egress-hits.jsonl`；门控关=零写盘（非侵入，`fs.existsSync===false` 断言） |
| 5 | demo + jest（新增） | 新建 `lib/redact.demo.js` + `tests/unit/redact-default-on.test.js`（**两文件现均不存在，须新建**） | 验 flip 后默认开零回归（门控关仍可显式关）+ observe hits 落盘断言。既有覆盖 `sandbox-egress.test.js` 19/19 + `forward-egress-e2e.test.js` 7/7 不动 |

**改动面**：仅 3 库/1 pack（`multi-proxy-manager/lib/redact.js` / `lib/upstream-check.js` / **根目录** `packs/sandbox-egress/index.js`），**热路径 4 文件 0 触碰**（`forward.js` 出站 `:155-161` / 入站 `:194-195` 接线已就位，本稿不改它）。

## 四、非侵入 / 可回滚保证

- 3 门控 flip 都是 1 行缺省值改，可 1 行回滚（显式 `PROXY_*=0` 关回）
- enforce 前必须 observe 观察 1-2 周（75号 纪律）
- 门控关=零副作用，已 7/7 e2e 验过；hits 落盘门控关时 `fs.existsSync===false`（§13.6 alert.js 同款断言）
- 热路径 4 文件 0 触碰（`git diff --stat` 验）

## 五、DoD 四要件（全绿才算提级完成）

| 要件 | 命令 | 预期 |
|------|------|------|
| ① flip 后既有脱敏覆盖全绿 | `npx jest multi-proxy-manager/tests/unit/sandbox-egress.test.js multi-proxy-manager/tests/unit/forward-egress-e2e.test.js`（既有 19+7 用例，真实存在） | 26/26 PASS |
| ② manager jest 全量不回归 | `cd multi-proxy-manager && npx jest` | 基线 1197/74 + 新增 `redact-default-on.test.js` N 例，零回归 |
| ③ 热路径 4 文件 0 触碰 | `git diff --stat -- multi-proxy-manager/lib/forward.js codex-proxy/proxy.js cursor-proxy/src/server/handlers/chatHandler.ts hermes-proxy/` | 空 = 0 改动 |
| ④ 门控关零写盘断言 | 新建 `tests/unit/redact-default-on.test.js`：`PROXY_PACK_SANDBOX_EGRESS=0` 时调 `inspectOutbound`/`inspectInbound` 后 `fs.existsSync(hitsFile) === false` | PASS（非侵入，§13.6 alert.js 同款断言） |

## 六、给维护者拍板的 3 个拍板点

1. **3 门控提级范围**（3 选 1）：
   - A=**全提**（`PROXY_REDACT` + `PROXY_UPSTREAM_CHECK` + `PROXY_PACK_SANDBOX_EGRESS` observe）+ 5 改动全做
   - B=只提 `PROXY_REDACT`（出站脱敏优先，体检/沙箱包暂保持关）
   - C=暂不翻（门控保持关，仅补 observe hits 落盘，观察后再定）
2. **enforce 观察期**：建议 1-2 周（observe 看命中率，再翻 `PROXY_SANDBOX_EGRESS_MODE=enforce`）
3. **配置面**：C=YAGNI 不建 UI（门控全走 env，维护者手工 set）/ A=管理台 3 个 checkbox（需另起 UI 增量）

## 七、边界与后续

- **回程占位符变回真值**：75号 §六 已标未做，本稿不提（属「工具参数脱敏」策略，等真有 case 再拍）
- **macOS 强制机制（Landlock/seccomp 属 Linux 特性）**：75号 §六 已标未核到，本 pack 是控制面旁路不是执行面沙箱，不提
- **配置面 UI**：若维护者选 A，另起 `proxy-config.html` 3 checkbox 增量（需写 `.env` + 重启，门控默认关时零 UI 副作用）
- **observe hits 文件清理**：`~/.multi-proxy-manager/sandbox-egress-hits.jsonl` 门控关=零写盘，开=按天滚，超 7 天裁剪（仿 `cost-snapshots.jsonl` 模式）

## 八、实施闭环（2026-10-06 hermes，维护者拍 A 全提）

5 项改动全落地（本稿 §三清单）：

| # | 落点 | 实况 |
|---|------|------|
| 1 | `lib/redact.js` `enabled()` 默认开 | 非 `0`/`false`/`off` 一律 ON（含 `delete`/`''`） |
| 2 | `lib/upstream-check.js` 同上 | 同款 flip |
| 3 | 根目录 `packs/sandbox-egress/index.js` 同上 | observe 默认开；`PROXY_SANDBOX_EGRESS_MODE` 默认 observe 不动（enforce 留 1-2 周观察期） |
| 4 | 新增 `recordHit()` 命中落盘 | `~/.multi-proxy-manager/sandbox-egress-hits.jsonl`（jsonl，门控关=零写盘）；`setHitsFile(p)` 注入缝 + `PROXY_SANDBOX_EGRESS_HITS` env 缝（测试隔离用）；best-effort try/catch 不上抛 |
| 5 | 新增 `tests/unit/redact-default-on.test.js`（7 用例） | 默认开矩阵 / 0·false·off 可回滚 / recordHit 落盘断言（outbound+inbound 两 kind）/ enforce·observe 行可区分 / 门控关零写盘（`fs.existsSync===false`，§13.6 同款）/ 无命中不落盘 |

**🔴 污染事件与修复（10-06 14:42）**：首版 e2e 用 `pack.setHitsFile(tmp)` 防 jest 写真实目录，但 `forward-egress-e2e.test.js` 每个 `call()` 走 `jest.isolateModules` 重新 require `forward.js` → 其内部 `require(pack)` 拿的是**新模块实例**，顶层设的 `setHitsFile` 在旧实例上，两个实例 `_hitsFile` 不通 → 全量跑时写漏 5 行 mock tag `e2etest` 的测试垃圾到真实 `~/.multi-proxy-manager/sandbox-egress-hits.jsonl`（已 `rm` 清掉）。
修复：e2e 改用 **env 缝** `PROXY_SANDBOX_EGRESS_HITS`（`hitsFile()` 在 `recordHit` 调用时读 env，跨 isolateModules 新实例都生效）；`jest.setup-afterenv.js` 的 afterEach env 快照自动清掉 test 新增 key，不泄漏到其它文件/真实运行时。重验：真实目录干净 + 3 套 33/33 + 全量 1204/1204。

**DoD 四要件实测**：① 3 套定向（`sandbox-egress` + `forward-egress-e2e` + `redact-default-on`）33/33 PASS · ② `cd multi-proxy-manager && npx jest` 全量 **1204/1204**（75 suites，基线 1197 + 新增 7）· ③ 热路径 4 文件 `git diff --stat` 空 = 0 改动 · ④ 门控关零写盘断言在 `redact-default-on.test.js` 内 PASS。

---
_落盘：2026-10-06 · hermes · 设计稿 → 已拍板已闭环（A 全提 + 注入缝）· 铁律：热路径 4 文件 0 触碰 · 非侵入 · 真跑验证 · 不产假数据_
