# opencode-free 插件 · 状态快照（2026-10-18）

> 自包含续跑入口：新会话读这一份 + `docs/10-initiatives/89-opencode-free插件-2026-10-18.md` + `manifest.json` 即可接手。

## 一句话
把 opencode.ai 全部模型（85 个：9 免费 + 76 付费）做成一个**可独立安装/更新/卸载的 multi-proxy 插件**，
转发到 `127.0.0.1:18800`，每条模型打 `is_free` 标记，hermes/dsh 读 manifest.json 自识别免费。
**持久实例已常驻（launchd KeepAlive，127.0.0.1:18800，healthz ok，free=9；pid 会随 kill/重启变，当前 66013）。**

## 三项拍板（2026-10-18 老板确认）落地情况
| # | 拍板 | 状态 | 证据 |
|---|---|---|---|
| 1 | 持久化+硬化插件 + 流式 60s 收尾 + 400 重试 | ✅ 完成 | `server.mjs` 已 patch（400 重试换新 session/1.5s·3s 退避；60s idle cap×2；key_mode/api_key）；`test/test-e2e.mjs` 9/0 通过；launchd bootstrap rc=0，49265 驻 18800 |
| 2 | 不装 magpie（暂搁置） | ✅ 记录 | `docs/10-initiatives/89-*.md` 第 7 节；magpie=第三方 curl|sh + 3425 网关，违"一切皆插件" |
| 3 | 落档（README/manifest + docs 条目） | ✅ 完成 | manifest.json（机器可读入口）+ README.md + .env.example + plist + launchd.sh + test-e2e.mjs + docs/89 |

## 已做（实测）
- ✅ server.mjs 硬化：400 重试、401/403 不重试、60s idle cap、is_free + _meta、KEY_MODE（public/account）、RETRY_400 可关
- ✅ E2E 自检 9/0：healthz / 85 模型 / 9 免费 / chat 路由不 500
- ✅ 打包全套 6 文件 + 6 项校验通过（plist lint、shell/manifest/node 语法、chmod +x）
- ✅ hermes `opencodezenfree` base_url **18791→18800**（备份 `~/.hermes/config.yaml.opencodezenfree-fix.20261018-072657.bak`）
- ✅ `.env` 由 `.env.example` 生成（proxy=7897）
- ✅ launchd 持久实例 49265：healthz ok，proxy=7897，total=85 free=9，chat 返 FreeTierError（路由通）

## 待办 / 待老板拍板（2026-10-18 续跑后）

### ✅ 已闭环（本次 E2E 真跑坐实）

**② key_mode 余量 —— 根因 + 修复 + 验证 ✅**
- 根因（非 STATE 猜的"重读时序"）：`server.mjs:23` `KEY_MODE = process.env.OPENCODE_API_KEY ? "account":"public"`——
  `.env` 默认 `OPENCODE_API_KEY=*** 是 truthy），故 KEY_MODE **恒为 "account"**，而 `key_set = API_KEY!=="public"` 恒 false → 矛盾。
- 修复：line 23 改为「非空且非 "public" 才算 account」。`healthz` 与 `/v1/models._meta` 现均报 `key_mode=public, key_set=false`（一致）。
- 验证：`test/test-e2e.mjs` **9 通过 / 0 失败**；`key_set=false` 与 .env=public 自洽。

**③ 跨重启 / 维护路径 —— 抓到并修了一个真 bug ✅**
- 发现：`./launchd.sh restart` 在本机 **macOS 27 上失效**——旧两段式 `launchctl kickstart -k gui/UID 标签` 被新版 launchctl 拒（rc=64），
  脚本误判"launchd 不可用"→降级 nohup→发现端口被占→空跑，**修复的代码根本没被载入**。
- 修复：`launchd.sh` 把 kickstart/bootout 改成新版 `gui/UID/标签` 单一参数（保留两段式作兜底）。修好后 `./launchd.sh restart` 前 pid=64386→后 65925，真重启。
- KeepAlive 真 E2E：`kill 65925` → 18800 空 8 秒（节流窗口）→ 第 9s launchd 自动重生新 pid 66013（healthz key_mode=public）。
- 跨重启结论：plist 在 `~/Library/LaunchAgents/` + `RunAtLoad=true` + `KeepAlive=true` → 登录时 launchd 自动 load → 跨重启+登录存活（机制已证）；
  未做整机电重启（高风险、影响全盘），用"kill→launchd 自动重生 + LaunchAgents 登录自启动"两处 E2E 坐实等价机制。

### ✅ ① 已拍板闭环（老板 2026-10-18 续跑 signoff：本地留痕，不 push 公开仓）

- 决策：opencode-free **不进公开仓**；走 safe-local-commit 本地留痕（老板点 A 选项，不脱敏）。
- 实证：`git add -- opencode-free/` 预演=10 文件、`.env` 被 `.gitignore:9` 排除、与 76 处无关脏改动零重叠；
   本地 commit **`85c1b94`**（10 文件全进、76 处无关脏改动零触碰），**未 push**（`origin/main..HEAD = 1` 即该本地 commit，本地领先不推）。
- 残留：本地领先 origin/main 1 个 commit（85c1b94），绝不 push 到 `xiaoxianxian/multi-proxy` 公开仓；要撤 `git reset --mixed HEAD~1`（文件内容在盘，可回退）。
- 注：10 文件含本机信息（`/Users/xiaota/*`、`~/.hermes`、7897），仅本地、不进公开 = 无泄密；如需上公开需另行脱敏 + internal-asset-gate。

### 已知门（非插件 bug，沿用）
- 免费模型通用 shim → `FreeTierError`（opencode 会话门，免费只在 opencode 运行时内）；直连 → `RegionError`；76 付费 → `AuthError`。列表恒 85 全可列；免费/付费调用需账号 key + 出口在放行区。

### 3. 免费模型最终清单（9 个，id 含 free 段，以 /v1/models._meta 为准，本次 E2E 复核）
beam-free / mimo-v2.6-flash-free / nemotron-3.5-super-vl-free / nemotron-3.5-lightning-free / jev-1.13-free /
longcat-2.5-preview-free / deepseek-v4.1-flash-free / glm-5.3-flash-free / space-bunny-free

## 操作速查
```bash
cd ~/Documents/AI项目/multi-proxy/opencode-free
./launchd.sh status            # 看 49265 + 端口
./launchd.sh restart           # 改 .env 后重启（.env 进程启动读）
./launchd.sh uninstall         # 卸载（不影响 multi-proxy）
node test/test-e2e.mjs         # 9/0 自检
# 接入：hermes/dsh 把 base_url 设 http://127.0.0.1:18800/v1，api_key=public（付费填 OPENCODE_API_KEY）
```

## 上游门（已知，非插件 bug）
- 免费模型通用 shim → `FreeTierError`（opencode 会话门，免费只在 opencode 运行时内）
- 直连 → `RegionError`（地区门）；76 付费 → `AuthError`（要账号 key）
- 列表恒可用（85 全可列）；免费/付费调用需账号 key + 出口在放行区

## 文件
- 插件：`opencode-free/`{server.mjs, manifest.json, README.md, .env, .env.example, com.multi-proxy.opencode-free.plist, launchd.sh, test/test-e2e.mjs, package.json, node_modules/}
- 文档：`docs/10-initiatives/89-opencode-free插件-2026-10-18.md`
- hermes：`~/.hermes/config.yaml` 已 base_url→18800（备份 .bak 在 ~/.hermes/）
