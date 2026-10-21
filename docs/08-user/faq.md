<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# FAQ 常见问题

> 提炼自 `07-ops/ENV-NOTES.md`（环境）+ `P0-FIXES.md`（P0）+ `manage.sh` + `runbook.md`。
> 生成日期：2026-09-17。命令均在 macOS（M5 Pro, 48GB, Node 24, Python 3.11）实测验证。

---

## Q1：启动后所有代理显示"未运行"

**根因**：Node.js 子进程的 `lsof` 检测路径问题。Node.js PATH 不含 `/usr/sbin`，`execSync('lsof')` 找不到。

**修复**：
```bash
# 检查 manage.sh 中 lsof 是否用绝对路径
grep "lsof" manage.sh | grep -v "#\|echo\|print"
# 应显示: /usr/sbin/lsof ...
# 若显示裸 lsof，修复：
sed -i.bak 's/execSync.*lsof/execSync("\/usr\/sbin\/lsof"/g' manage.sh
./manage.sh restart
```

---

## Q2：Cursor 测试全 fail（22 个）

**根因**：`better-sqlite3` native module prebuild 不支持当前 Node 版本。

**修复**：
```bash
cd cursor-proxy
npm rebuild better-sqlite3
# 若失败：
rm -rf node_modules && npm install
npm rebuild better-sqlite3
```

---

## Q3：如何切换模型代理所有者（proxy-rebuild vs cc-switch）

**工具**：`tools/agent-proxy-switch`。

```bash
# 切换某 agent 的 base_url 指向另一个所有者
./tools/agent-proxy-switch codex proxy-rebuild   # 或 cc-switch
# 验证
curl -s http://localhost:18790/api/status | jq .base_url
```

**纪律**：卸载/停止当前代理某 agent 前，先切到另一个所有者，否则 agent 指向死端口断连。

---

## Q4：NO_PROXY 导致网络全部断连

**根因**：往 launchd 全局环境注入裸 `*` 的 `NO_PROXY`。

**修复**：
```bash
# 清除全局污染（立即生效需重启登录 session）
launchctl unsetenv NO_PROXY
# 正确做法：只在 plist EnvironmentVariables 里设 localhost 绕过
# 编辑 ~/Library/LaunchAgents/com.multi-proxy-manager.plist
#   添加 <key>NO_PROXY</key><string>127.0.0.1,localhost,::1</string>
```

---

## Q5：如何开启 L2 门控能力

```bash
# 编辑 multi-proxy-manager/.env
PROXY_ORCHESTRATION=1
PROXY_HEALTH_ALERT=1
PROXY_COST_TRACK=1
PROXY_LLM_DECOMPOSE=1
PROXY_ROUTE_OVERRIDE=0    # 建议先 0（shadow），验证后改 1

# 重启 Manager
./manage.sh restart manager
```

---

## Q6：如何查看实时成本数据

```bash
# 开启成本埋点（如未开）
sed -i '' 's/PROXY_COST_TRACK=0/PROXY_COST_TRACK=1/' multi-proxy-manager/.env
./manage.sh restart manager

# 查余额趋势（B 路）
curl -s http://localhost:18792/api/alert/history | jq '.[] | {event, ts}'
# 成本数据在 l2/cost.js 维护，通过 alert history 或 API 查询
```

---

## Q7：Docker 和本地模式可以混用吗

**不行。** 两种模式进程检测方式不同：
- 本地：`/usr/sbin/lsof` 端口检测
- Docker：`docker container inspect`

同一时间只运行一种，混用会导致状态检测冲突。

---

## Q8：桌面壳 Gatekeeper 报错"已损坏"

**修复**：
```bash
cd multi-proxy-manager
# 清除 quarantine
xattr -cr node_modules/electron/dist/Electron.app
# 自签名
codesign -s - node_modules/electron/dist/Electron.app
# 启动
./manage.sh gui
```

---

## Q9：agent 能力怎么注册？两个 agent 都有同一能力时怎么选

**现状**：能力是 profile 里的 `capabilityTags` **静态声明**，非运行时探测——在 adapter 构造时挂上（`l2/adapters/l1-agent-adapter.demo.js:30` `new L1AgentAdapter({ capabilities: ['code','writing'] })`）。注册走 `AgentRegistry`（`l2/agent-registry.js`）：`REQUIRED` 字段含 `capabilityTags`（:27），按能力查询用 `byCapability(tag)`（:118-119），命中多个同能力 agent 时按 `strategy` 选（cost-optimization 取最便宜 / priority / round-robin）。

---

## Q10：PROXY_ADAPTER_REAL 是什么

`l2/mcp-server.js:86`：二级门控，默认 `'0'`。关时 `orchestrate` 始终 **shadow**（只产出 plan JSON，executor 不被调用，不触碰下游 adapter，符合非侵入铁律）；开时才经注入缝真调 adapter 执行。缺省路径下 `listTools()` / `orchestrate` 行为完全不变（零回归）。

---

## Q11：路由兜底是写死 deepseek 吗

**不是。** `cursor-proxy/src/routing/routeEngine.ts`：

- 有健康候选：`pickByCost`（:136）按 cost 排序取最便宜，无价（`Infinity`，:147）排最末。
- 无候选集：退化为 `DEFAULT_ROUTE_CONFIG.fallbackChain[0]`（:162），即 `defaultModel='qwen3.8:27b-mlx'`（本地、0 成本），非 deepseek。
- `fallbackChain = ['qwen3.8:27b-mlx', 'deepseek-v4-pro', 'agnes-2.5-flash', 'kimi-k2.6']`（:187）。没配 deepseek-v4-pro 时 DB `providers` 表无 `enabled=1` 行 → 退回 qwen 本地。

路由是 DB 驱动 + 成本排序，非写死。

---

## Q12：override 为什么只在 cursor，codex / hermes 没有

**现状**（已 grep 全仓确认）：`PROXY_ROUTE_OVERRIDE` 只在 `cursor-proxy/src/server/handlers/chatHandler.ts:32/396`。`codex-proxy/proxy.js`（687 行，Node）与 `hermes-proxy/proxy.py`（708 行，Python）是独立代理实现，**没有 L2 架构**（无 routeEngine / AgentRegistry / classifyTask），故无 override。

cursor-proxy 是新写的 L2 架构载体（chatHandler + routeEngine + agentRegistry），override 是它独有的。

---

## Q13：override / 这类能力应该放哪一层

按 `AGENTS.md` §3 末条「**通用能力放 L2 公共层，不重复实现**」（09-30 维护者拍板落地）：跨 proxy 的通用能力（路由决策 / override / 成本优化 / 能力注册 / 语义审阅）统一实现于 `l2/`，各 proxy 仅作 L1 消费方。

据此 override 应抽到 `l2/route-engine.js` 或上层 `l2/mcp-server.js`，让 codex / hermes 共用一套路由 + 能力注册，不在 cursor 单独维护一份。

---

## Q14：还没实现 / 挂起的是哪些

来源 `docs/10-initiatives/45-未做与待拍板清单-2026-09-30.md` §二：

| 项 | 状态 | 优先级 |
|----|------|--------|
| P4 continuity-kernel 真代码 | ❌ 仅设计稿，无 `.js` | 高 |
| P3 进程级崩溃恢复 | ❌ 草案未落 | 高 |
| `/v1/messages` Anthropic ingress | ✅ 2026-10-02 起已实现：claude-proxy（18791）与 codex-proxy（18790）均有路由，本机 POST 实测 HTTP 200；旧结论“全仓无路由”已作废 | — |
| provider-selector 4 策略（smart/order/rotate/usage） | ❌ 现状 order 隐式 | 中 |
| hermes E2E 补 1 pytest | ❌ 未实施 | 中 |
| D3-③ decomposer 扩 5-stage | ⏸ 挂起（消费方不存在） | 低 |
| M6 override 固化到 manage.sh | ✅ `commit d85565a`（2026-09-30） | — |
| override 抽到 L2 公共层 | ❌ 未做（§3 末条铁律已立） | 高 |

竞品深调研（Claude Code / Cursor / n8n / Dify / magpie 的 agent 路由 + multi-proxy / Hermes 生存空间）见 `docs/10-initiatives/26-竞品深调研-agent路由与生存空间-2026-09-30.md`。

---

## 数据源

- `07-ops/ENV-NOTES.md` / `03-adr/0002`（NO_PROXY 铁律）
- `docs/07-ops/runbook.md`
- `manage.sh`
- `docs/09-review/archive/MEMORY-2026-09-17.md` P5 桌面壳修复记录
- Q9–Q14（2026-09-30 续跑）：`l2/agent-registry.js` / `mcp-server.js` / `adapters/l1-agent-adapter.demo.js`、`cursor-proxy/src/routing/routeEngine.ts`、`docs/10-initiatives/25-续跑状态`、`19-未做与待拍板清单`、`26-竞品深调研`
