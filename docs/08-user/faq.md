# FAQ 常见问题

> 提炼自 `CLAUDE.md §已知限制/开发注意/P0/环境问题` + `manage.sh` + `runbook.md`。
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

## 数据源

- `CLAUDE.md §已知限制/环境问题/NO_PROXY 铁律`
- `docs/07-ops/runbook.md`
- `manage.sh`
- `MEMORY-2026-09-17.md` P5 桌面壳修复记录
