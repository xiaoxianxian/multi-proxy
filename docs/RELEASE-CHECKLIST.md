# v1.0.0 发布打包清单（RELEASE-CHECKLIST）

> 状态快照：2026-10-15。生成方：贾维斯（Hermes）。
> 本清单如实记录 v1.0 pin 前的完整状态，含已完成 / 待办 / 阻断 / 需老板 signoff 四类。
> 关联：`docs/legal/`（用户服务协议 + 隐私政策 + REVIEW-2026-10-15）· `docs/design-system/`（基线 + REVIEW-2026-10-15）· `docs/frontend-review/README.md` · `PROJECT-STATE/2026-10-15.md`。

## 0. 一句话

法务两协议已评审 + 老板填入 5 项经营值；设计基线达标；全量测试绿；版本号已 pin 1.0.0。
**卡发布的只剩 3 件：① 首启法务同意弹窗（未实现）② 9 页 public 重构（未做）③ sifking 更新 manifest 契约（源不可达）+ 生效日期具体日历（发布当天补）。**

## 1. 已完成（有证据）

| 项 | 状态 | 证据 |
|---|---|---|
| 版本号 pin 1.0.0 | ✅ | `VERSION` + 4 份 package.json 全 = `1.0.0`；`sync-version --check` exit 0；`version-channel.test` 9/9 PASS |
| 法务评审（3 视角） | ✅ | `docs/legal/REVIEW-2026-10-15.md`（8 P0 + 6 P1 + D-3/D-4） |
| 法务应用评审优化 | ✅ | 两源稿各应用全部 P0/P1；回验旧串全 0 |
| 法务填入经营值 | ✅ | 公司=`Jason Sifa`（笔名，不含真名）/ 邮=`281330913@163.com` / 官网=`www.sifking.cn` / 有效期=`长期有效（至服务终止）` / 生效=`首次发布日`；旧示例残留 0 |
| 设计基线 P0 | ✅ | `--faint` 对比度 AA · `prefers-reduced-motion` · 状态胶囊 `.page-status` · 版本号 9 页统一 `v1.0.0` · 无散落 hex · floor 不填 0 · 暗色完整 · 零 Google Fonts（`TOKEN` 单一源） |
| 设计 P1/P2（部分） | ✅ | 上述 P1 三件套 + 版本号已落；砍 6 假 tab / 补 Settings 页 / 「代理」语意解耦 → 排 v1.1（待老板定） |
| 前端安全护栏 | ✅ | `docs/frontend-review/README.md`：`esc()` DOM+引号转义、proxy-config key 全 mask「•••」+ toggle 默认关、XSS sink 全过、proxyManager_password 无 setItem 残留；后端 bcrypt + crypto.randomBytes(32) + MFA + 限流 |
| 更新机制（in-app auto-update） | ✅ | `tools/update-check.js` 默认门控关 + sifking opt-in（`MP_UPDATE_ON` + `API_HOST/OWNER/REPO` env）；3 态实测 0/1/4；install.sh `case ... *)` 兜底兼容；version-channel 9/9 覆盖「静默 / 干净 exit0 / 脏 exit1」 |
| 全量测试绿（变更后复跑） | ✅ | jest 1954（manager 1523 / cursor 250 / codex 159 / generic 177）+ hermes pytest 80（1 urllib3 warning 非失败）+ l2 demo 56 = **0 失败**。2026-10-15 变更后复跑 |
| 签名决策 | ✅ | ② 半发布/不签名（老板定）：macOS 手拖 `.dmg` + Gatekeeper 自解隔离；Windows Electron autoUpdater 自动下载+安装。②→①（Developer ID 签名 + notary）非破坏性 |

## 2. 待办（不阻断 v1.0，但发布前需处理 / 已排期）

| 项 | 类型 | 处理 |
|---|---|---|
| `[生效日期]` 具体日历 | 占位 | 「首次发布日」语义已填；**具体日历等产品正式发布当天补** |
| `[备案号]` / ICP / 生成式 AI 备案 | 合规 | 本服务**纯本地调用中枢、默认不提供具舆论属性生成式服务**→无需独立备案/算法备案，公示所调用模型备案信息即可；**仅当**开通「向境外公众开放 / 具舆论属性」时按监管补办（§4.5/§5.4 已写明） |
| 设计 IA 3 件（砍 6 假 tab / 补 Settings 页 / 「代理」语意解耦） | IA 重构 | 排 v1.1（待老板拍板，避免越权改 IA） |
| 密钥接 Keychain(mac)/DPAPI(win) | 工程 | 排 v1.1；v1.0 文案已降格写实（AES-256-GCM 存本机 + 建议全盘加密/钥匙串） |

## 3. 阻断 / 风险（发布前须解决）

| 项 | 现状 | 解法 |
|---|---|---|
| 首启法务同意弹窗（D-1）·纳 v1.0 | 状态层已建+跑绿（`lib/consent.js` 6/6）；**剩 overlay UI + server 路由接入（待 2 决策：默认拦截 vs 非侵入 / 壳原生 vs web overlay）** |
| 9 页 public 重构·纳 v1.0 | ⚠️ **冲突未解**：`design-system.test.js`（449 行）钉死 `public/colors_and_type.css` 旧色板，与新 `tokens.css` 并行；须老板定 **A 迁移（改测试契约）/ B 叠加门控（非侵入·推荐）**；**未擅动 public/ 与测试** |
| sifking.cn 更新 manifest 契约 | `sifking.cn` **当前不可达**（连通性故障），`update-ui.html` 现为 mock | 须老板提供 `manifest.json` 契约 + 样例（不可凭空编 URL 形态）；gate-closed 暂不阻断 v1.0 功能 |

## 4. 需老板 signoff / 提供值（不可自动）

1. **生效日期**具体日历（发布哪天）——我留了「首次发布日」占位，发布当天补。
2. **sifking 更新 manifest** `manifest.json` 字段契约 + 样例（源不可达，需你给/建）。
3. **首启同意弹窗** 是否纳入 v1.0（建议纳入；否则 v1.0 缺「首启告知/同意」法务要件）。
4. **9 页 public 重构** 是否纳入 v1.0 范围。
5. Cloudflare 把 `www.sifking.cn` 指向（你侧操作，本清单不涉及凭据）。

## 5. 已锁定不动的东西（红线）

- 热路径 `forward.js` / `codex-proxy/proxy.js` 未改（本轮 0 改动）。
- 未提交 / 未推远程（本轮改动全未 commit，等老板批次确认）。
- 密钥存储、NO_PROXY、lsof 完整路径三条 AGENTS 红线遵守。

---

## 6. ③ 收尾（2026-10-16 补）—— 矩阵重生 SPEC + WIP 分小批

> v1.0 收口已 push `485af35`（5 commit 齐 origin），jest 1529 全绿，E2E smoke 9/9，热路径 5 次 push 后仍 0 改，真实登录态全程未外泄。以下为「③ 待拍板三件事」评估 + 矩阵重生 SPEC（独立任务，新窗口执行）。续跑提示词见 `PROJECT-STATE/RESUME-MATRIX-REGEN-1016.md`（已含本节 P0-P3）。

| 项 | 结论 | 处理 |
|---|---|---|
| ③-1 165-matrix 能否安全跑 | **能（隔离 harness 已证）**，但矩阵实为 **50 用例（非 165，AGENTS.md 旧高估）**，隔离实跑 7 pass/43 fail，**全矩阵 stale**（根因：`#setupPassword` 双态异步渲染，矩阵没等），**不 gate v1.0** | 转「矩阵重生」独立任务（见 P0-P3 + DANGER.md 已 commit `485af35`）|
| ③-2 他人 WIP 能否 commit / ping | **不 commit**（35+ 文件跨 agent 混合批，§5.9 不擅动）；**ping 做不到**（无 inter-agent 频道），已 ABCD 登记 + 报老板协调 owner | 转 owner |
| AGENTS.md §6 165→50 修正 | 受保护 agent 文件，审批弹窗未过（系统明令不绕路） | 待老板定 a 审批同意 / b 手动 / c 仅记录 |

### P0 · 安全（先于一切矩阵动作 · 新窗口第一件事）
> 读 `01-auth-flow.test.ts` + `helpers.ts`（全读）发现：隔离跑之所以安全，是 `#setupPassword not visible` 恰好挡住了 POST；**正常跑有「撞生产 + 写/覆盖真密码」风险，P0 必须先修再重生**。

1. **`BASE_URL` 硬编生产端口**：`helpers.ts:12` + `01-auth-flow.test.ts:16` 写死 `const BASE_URL = 'http://localhost:18792'`（非参数化）→ 矩阵正常跑直撞真实 manager。两文件改 `const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:18801'`，**永不默认 18792**。
2. **清密码路径错**：`01:23` `beforeEach` + `helpers.ts:21` `login()` 都 `rm -f ~/.multi-proxy-password`，但**真实凭据在 `~/.multi-proxy-manager/password`**（+jwt `~/.multi-proxy-jwt-secret`）→ no-op 清不掉。改在 **throwaway HOME** 下清 `os.homedir()/multi-proxy-manager/password` + `multi-proxy-password` + `multi-proxy-jwt-secret`。
3. **始终 throwaway HOME 跑**；跑完核 `ls -la ~/.multi-proxy-manager/password` mtime 不变。

### P1 / P2 / P3
- **P1 异步等待**：`login()` 的 `isVisible().catch(()=>false)` + `waitForTimeout(2000)` → `await expect(page.locator('#setupMode')).toBeVisible()`（按真实 needsSetup 渲染走）；01 的 3 条 setup 用例同样等渲染再 fill。
- **P2 安全类**：05「无 token 应 401」按 P0/P1 修好 setup+token 流后重核（git `a49bb37`「删 routes/auth.js bypass 块」可能改 401 行为）；06 XSS 改「注入名含 `</script>`/`<img onerror>` 后查是否被转义」（现仅查 `script[src]` 长度，断言浅）。
- **P3 全量**：7 pass 保绿；改完跑全量 1529 jest（`NODE_OPTIONS=--experimental-vm-modules --maxWorkers=1`）不回归；热路径 0 改；范围 50 用例（6 .ts）；01 先 spoken 验证再铺 02-06；push 前 hermes 复核 + 老板确认；`git add --` 逐文件。

### ③-2 WIP 分小批（待 owner 协调，按组独立提）
- **A · cost 上报闭环**（`routes/cost-report.js` + `lib/cost-track.js`，已 wire 进 server.js）：self-contained，**可先独立提**（提完跑全量确认无回归）。
- **B · l2/* untracked**（`l2/content-guard.js` `l2/context-report.js` `l2/sentinel-guard.js` `l2/watchtower-report.js` + `routes/capability-profile.ts`）：多未 wire，需 owner 补完/确认是否纳入版本控制。
- **C · 碰热路径**（`lib/guard/dsh-guard.js` `lib/guard/generic-guard.js` `routes/codex-config.js` + 4×`package.json` 版本 bump）：须 hermes 复核 diff + 老板 signoff。
- **D · 5 页 M**（`logs` `dashboard` `knowledge` `proxy-config` `skills`，均 `M`）：矩阵 stale 的视觉/结构漂移源，是否随设计系统迁移重构由 owner 定。

### 收口核验（2026-10-16 21:xx）
- 误建子目录副本 `multi-proxy-manager/docs/RELEASE-CHECKLIST.md` 已删；热路径 `forward.js` / `codex-proxy/proxy.js` 0 改；真实 `~/.multi-proxy-manager/password`（60B 10-05）+ jwt 全程未动；HEAD = `485af35`。
- 待老板定：AGENTS.md §6 165→50（a/b/c）；矩阵重生执行（开新窗口粘 `RESUME-MATRIX-REGEN-1016.md`）；WIP ABCD 协调 owner。
