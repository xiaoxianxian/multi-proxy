# 部署指南（deployment）

> 提炼自 `manage.sh`、`install.sh`、`docker-compose.yml`、各 `.env.example`、`07-ops/ENV-NOTES.md`。
> 生成日期：2026-09-17（HEAD `a94de96`，main）。

---

## 一、前置依赖检查

| 依赖 | 检测方式 | 缺失处理 |
|------|----------|---------|
| Node.js | `command -v node` | `brew install node` |
| Python3 | `command -v python3` | `brew install python3` |
| Docker + Docker Compose | `docker compose version` | `brew install --cask docker` |

---

## 二、三种部署模式

### 2.1 manage.sh 模式（macOS 本地，推荐）

```bash
# 启动全部
./manage.sh start

# 停止全部
./manage.sh stop

# 查看状态
./manage.sh status

# 查看日志
./manage.sh logs              # 全部
./manage.sh logs codex        # 单代理
```

**四代理端口**：codex:18790 / hermes:18793 / cursor:18794 / manager:18792。

开机自启（macOS LaunchAgent）：

```bash
./manage.sh autostart --codex   # 或 hermes / cursor / manager
./manage.sh autostop --codex    # 禁用
```

plist 路径：`~/Library/LaunchAgents/com.multi-proxy-manager.plist`。

**关键注意（来自 07-ops/ENV-NOTES.md / 03-adr）**：
- `lsof` **必须用完整路径 `/usr/sbin/lsof`**，Node.js 子进程 PATH 不含 `/usr/sbin`，违反则代理状态检测全部失败（所有代理显示"未运行"）。
- `killPort` 使用 SIGTERM → 500ms → SIGKILL 两阶段。
- 启动轮询等端口绑定（最多 5s），非固定延迟。

### 2.2 install.sh 模式（一键安装/启停/自启）

```bash
./install.sh                  # 交互式
./install.sh --all            # 静默全部
./install.sh --uninstall      # 卸载
./install.sh --reinstall      # 卸载后重装
./install.sh --start          # 启动全部
./install.sh --stop           # 停止
./install.sh --status         # 状态
./install.sh --autostart      # 开机自启
./install.sh --autostop       # 禁用自启
```

macOS pip：`pip3 install -r requirements.txt` **不加 `--break-system-packages`**（该参数仅 Debian/Ubuntu，macOS 报错）。

### 2.3 Docker 模式

docker-compose.yml 定义 4 服务（codex-proxy/hermes-proxy/cursor-proxy/manager），命名：`multi-proxy-{code}`，bridge 网络。

```bash
docker compose up -d          # 启动
docker compose down           # 停止
docker compose logs           # 日志
```

Manager 容器挂载 `/var/run/docker.sock` 控制其他容器；`IS_DOCKER = fs.existsSync('/.dockerenv')` 自动识别 Docker 环境，进程检测切 `docker container inspect`，API 转发用服务名替代 `127.0.0.1`。

---

## 三、环境变量配置

### 3.1 各 `.env.example`

| 文件 | 必填 |
|------|------|
| `codex-proxy/.env` | `PORT=18790` `DEEPSEEK_API_KEY` `AGNES_API_KEY` `MOONSHOT_API_KEY` |
| `hermes-proxy/.env` | 同上，`PORT=18793` |
| `cursor-proxy/.env` | `PORT=18794` `PROXY_AUTH_TOKEN` `CORS_ORIGIN` `ENCRYPTION_KEY` |
| `multi-proxy-manager/.env` | `PORT=18792` `JWT_SECRET`（改随机串）`MANAGER_PASSWORD` `CORS_ORIGIN` |

### 3.2 L2 门控开关（生产环境逐步开启）

| 开关 | 值 | 默认 | 说明 |
|------|----|----|------|
| `PROXY_ROUTE_OVERRIDE` | `1`/`0` | 空=shadow | M6 路由覆盖，建议 shadow 验证后固化 |
| `PROXY_DECOMPOSE_STRATEGY` | 值 | — | 拆解策略，见 `m6-action-checklist` |
| `PROXY_LLM_DECOMPOSE` | `1`/`0` | `0` 关 | LLM 拆解 fallback on error |
| `PROXY_HEALTH_ALERT` | `1`/`0` | `0` 403 | 告警规则，启用后 `GET /api/alert/*` 开放 |
| `PROXY_COST_TRACK` | `0`/`1` | `0` | 成本埋点，A 路 token×单价 |

> 固化 M6 路由：`PROXY_ROUTE_OVERRIDE=1` 写进 `mult...[truncated]