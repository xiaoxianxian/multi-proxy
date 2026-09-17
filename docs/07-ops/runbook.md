# 运维手册（runbook）

> 提炼自 `manage.sh`、`07-ops/ENV-NOTES.md`、`P0-FIXES.md`、`03-adr/`。
> 生成日期：2026-09-17。

---

## 一、日常命令速查

```bash
# 状态 / 启停
./manage.sh status
./manage.sh start / stop / restart

# 单代理操作
./manage.sh codex start          # hermes / cursor / manager 同理
./manage.sh codex stop
./manage.sh codex restart
./manage.sh codex status
./manage.sh codex logs

# 桌面壳
./manage.sh gui                    # 启动 Electron 壳（复用后端 + 开壳前占检测）

# 日志目录
~/logs/multi-proxy-manager/        # codex-proxy.log / hermes-proxy.log / cursor-proxy.log / manager.log
```

---

## 二、故障诊断

### 2.1 所有代理显示"未运行"

**根因（03-adr/0001；AGENTS.md §1）**：`lsof` 未用 `/usr/sbin/lsof` 绝对路径，Node.js 子进程 PATH 不含 `/usr/sbin`。

**修复**：检查 `isProcessRunning` 的 `execSync` 调用是否带绝对路径；用 `pkill -f node.*proxy.js` 手动停后 `./manage.sh start` 重试。

### 2.2 Cursor database.test.ts 22 个全 fail

**根因（07-ops/ENV-NOTES.md）**：`better-sqlite3` native module prebuild 仅支持 Node 18 (NODE_MODULE_VERSION 127)，当前系统 Node 24 (137)。

**修复**：
```bash
cd cursor-proxy && npm rebuild better-sqlite3
# 若 npm cache 无写权限：
npm config set cache /tmp/npm-cache && npm rebuild better-sqlite3
```

### 2.3 Manager 测试 EPERM（supertest 无法绑定端口）

**根因**：沙箱环境禁止绑定 `0.0.0.0`。非代码 bug，Docker 或正常本地环境通过。

### 2.4 端口占用（`manage.sh start` 报端口冲突）

**诊断**：`lsof -i :18790`（codex）/ `18793`（hermes）/ `18794`（cursor）/ `18792`（manager）。
**处理**：`kill <PID>` 或 `./manage.sh stop <proxy>`，再启动。

---

## 三、门控配置（逐步开放 L2 能力）

| 开关 | 启用命令 | 效果 | 风险 |
|------|----------|------|------|
| `PROXY_ORCHESTRATION=1` | 写入 manager `.env` + restart | 编排路由开放，默认关 | 无 |
| `PROXY_LLM_DECOMPOSE=1` | 同上 | LLM 拆解降级回 template | 无 |
| `PROXY_HEALTH_ALERT=1` | 同上 | `GET /api/alert/*` 开放 | 需配 sink |
| `PROXY_COST_TRACK=1` | 同上 | A 路 token×单价 埋点 | 无 |
| `PROXY_DECOMPOSE_STRATEGY` | 同上 | 拆解策略 | 需配值 |

---

## 四、NO_PROXY 铁律（绝对禁止）

> **严禁往全局 launchd 环境注入裸 `*` 的 `NO_PROXY`。**

**根因（03-adr/0002；AGENTS.md §2）**：HTTP 客户端按逗号拆 NO_PROXY 做 `hostname.endsWith(项)`；`*` 去前导通配符后为空串 → `endsWith('')` 恒真 → 所有请求绕过系统代理 → 直连被墙 IP → `ETIMEDOUT`，曾把 WorkBuddy/CC Switch 全部带崩。

**正确做法**：需绕过 localhost，只在 LaunchAgent plist `<EnvironmentVariables>` 里设 `NO_PROXY=127.0.0.1,localhost,::1`，不用 `launchctl setenv` 污染全局。

---

## 五、安全加固检查清单

| 检查项 | 状态 | 来源 |
|--------|------|------|
| `/api/:proxy/*` 认证 | ✅ 已修（P0 通配符绕过） | `P0-FIXES.md` |
| `x-proxy-auth` 认证头 | ✅ codex-proxy/hermes-proxy 已支持 | `P0-FIXES.md` |
| `PROXY_AUTH_TOKEN` 环境变量 | ✅ cursor-proxy 已支持 | `cursor-proxy/.env.example` |
| `JWT_SECRET` 已改随机串 | 需检查 | `multi-proxy-manager/.env` |
| 登录速率限制 | ✅ | `install.sh` 生成 |
| CSP / CORS / 错误脱敏 | ✅ | `install.sh` 生成 |
| spawn 路径/命令白名单 | ✅ | `install.sh` 生成 |

---

## 六、数据备份

| 数据 | 路径 | 方式 |
|------|------|------|
| 供应商配置 | `~/.multi-proxy-manager/providers.json` | 手动 `cp` |
| 路由配置 | `~/.multi-proxy-manager/routing-mode.json` | 同上 |
| Cursor SQLite | `cursor-proxy/data/proxy.db` | `cp` + WAL snapshot |
| 日志 | `~/logs/multi-proxy-manager/` | 按日归档 |

**建议**：`providers.json` + `routing-mode.json` 定期 `cp ~/backup/`，避免升级丢失路由配置。

---

## 七、Docker 模式运维

| 命令 | 说明 |
|------|------|
| `docker compose up -d` | 后台启动全部 |
| `docker compose down` | 停止 |
| `docker compose logs -f` | 日志 |
| `docker compose ps` | 容器状态 |

**关键**：Manager 容器挂载 `/var/run/docker.sock`；容器网络内服务名替代 `127.0.0.1`；`IS_DOCKER` 自动检测环境切换检测方式。

---

## 数据源

- `manage.sh`（全 514 行）
- `07-ops/ENV-NOTES.md` / `P0-FIXES.md` / `03-adr/`
- `docs/04-business/commercialization-decided.md` 门控配置
- `docs/02-product/m6-action-checklist.md` M6 固化命令
