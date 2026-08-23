# Proxy Rebuild - Multi-Proxy Manager

## 项目概述

这是一个多代理管理系统，用于统一管理三个 AI 代理服务（Codex、Hermes、Cursor），并提供统一的 Web 管理界面。

## 架构

| 模块 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| `multi-proxy-manager/` | Node.js + Express | 18792 | Web 管理界面（前端+后端） |
| `codex-proxy/` | Node.js + Express | 18790 | Codex CLI 代理 |
| `hermes-proxy/` | Python + Flask | 18793 | Hermes Agent 代理 |
| `cursor-multi-model-proxy/` | Node.js + TypeScript + SQLite | 18794 | Cursor IDE 代理 |

## 快速开始

```bash
# 安装依赖
bash install.sh --all

# 启动所有服务
bash manage.sh start

# 查看状态
bash manage.sh status

# 查看日志
bash manage.sh logs all

# 停止所有服务
bash manage.sh stop
```

## 启动方式

- **一键脚本**: `manage.sh start`（启动所有服务）
- **单独启动管理器**: `node multi-proxy-manager/server.js`
- **预览面板**: 使用 Launch preview 启动 `multi-proxy-manager` 配置
- **Docker**: `docker compose up -d`

## 关键文件

- `manage.sh` - 日常服务管理（启停、日志、状态）
- `install.sh` - 安装/卸载/开机自启
- `multi-proxy-manager/public/` — Web 管理界面（4 个独立 HTML 页面）
  - `dashboard.html` — 概览页（代理状态、版本信息、自动刷新）
  - `login.html` — 登录/首次设置密码
  - `logs.html` — 日志查看（筛选、导出、复制）
  - `proxy-config.html` — 代理配置（供应商 CRUD、模型切换、余额）
  - `index.html` — 重定向到 dashboard.html
- `multi-proxy-manager/server.js` - 管理器后端（进程管理 + API 转发 + 认证 + 安全中间件）

## 已知限制与注意事项

### 关键约束
- **`lsof` 必须使用完整路径 `/usr/sbin/lsof`**：Node.js 子进程的 PATH 不包含 `/usr/sbin`，所有 `execSync` 调用中的 `lsof` 必须使用绝对路径。违反此规则会导致代理状态检测失败（`isProcessRunning` 返回 false），表现为所有代理显示"未运行"。
- **代理进程由外部管理**：管理器通过 `lsof` 端口检测回退判断代理是否运行。如果代理不是通过管理器启动的（如直接 `node proxy.js`），`proxyProcesses` 中不会有追踪记录，但端口检测仍能工作。
- **Cursor 代理的 CRUD 功能**：Cursor、Codex、Hermes 均支持供应商/模型的增删改查。Codex 和 Hermes 的供应商页面从只读改为完整 CRUD。
- **better-sqlite3 native module**：Cursor 代理依赖 better-sqlite3，Node.js 升级后需要 `npm rebuild better-sqlite3`。当前 prebuild 仅支持 Node 18 (NODE_MODULE_VERSION 127)，Node 24 需重新编译。

### 启停优化
- 启停操作使用**乐观更新**：API 成功后立即更新 UI，无需等待全局状态刷新。
- 停止代理时，`killPort` 使用 SIGTERM → 500ms → SIGKILL 的两阶段机制。
- 启动代理时，使用轮询等待端口绑定（最多 5 秒），而非固定延迟。

### 前端路由
- SPA fallback 在 `server.js` 中按路由映射 HTML 文件（`/` → dashboard, `/logs` → logs, `/proxy-config` → proxy-config）
- 各页面之间通过相对路径链接（`dashboard.html`, `logs.html`, `proxy-config.html?proxy=codex`）
- 认证 token 通过 `x-auth-token` header 注入 fetch 请求

### Docker 模式
- Manager 通过 `IS_DOCKER = fs.existsSync('/.dockerenv')` 检测 Docker 环境
- Docker 模式下：
  - 进程状态检测使用 `docker container inspect` 替代 `lsof`
  - API 转发使用服务名（`codex-proxy`, `hermes-proxy`, `cursor-proxy`）替代 `127.0.0.1`
  - 启停用 `docker stop/start` 替代 `kill`
- Docker Compose 配置文件：`docker-compose.yml`
- 各服务 Dockerfile：`Dockerfile.codex`, `Dockerfile.hermes`, `Dockerfile.cursor`, `Dockerfile.manager`
- Manager 容器需要挂载 `/var/run/docker.sock` 以控制其他容器
- 容器名约定：proxy-rebuild-codex, proxy-rebuild-hermes, proxy-rebuild-cursor, proxy-rebuild-manager
- 服务名约定：codex-proxy, hermes-proxy, cursor-proxy（Docker network 内 DNS 解析用）

### 开发注意

- Web 界面是 4 个独立 HTML 文件，每个包含完整的 CSS + JS（无框架依赖）
- 后端通过 `express.static()` 提供静态文件，通过 API 路由转发请求到各代理
- 代理进程由管理器自动检测和启动/停止
- 开机自启使用 macOS LaunchAgent（`~/Library/LaunchAgents/com.multi-proxy-manager.plist`）
- 安全加固：登录速率限制、CSP headers、CORS 策略、错误信息脱敏、spawn 路径/命令白名单
- **路由端点顺序**：`/api/fetch-models`、`/api/test-connection`、`/api/balances`、`/api/providers/:id` 必须注册在 wildcard `/api/:proxy/*` 之前，否则会被 wildcard 捕获。server.js 中这些端点已前置。
- **Hermes 启动**：`manage.sh` 启动 Hermes 后 sleep 1s 再检测端口，避免 Flask 启动过快导致误报"启动失败"。
- **macOS pip 安装**：`install.sh` 中 `pip3 install` 不使用 `--break-system-packages`（该参数仅 Debian/Ubuntu 有效，macOS 会报错）。
- **供应商启用开关**：checkbox 用 `pointer-events: none` + `opacity: 0` 隐藏，label 包裹整个 toggle 区域，点击 slider 通过 label 关联触发 checkbox。
- **跨页面状态同步**：dashboard.html 和 proxy-config.html 使用 `BroadcastChannel('proxy-status')` 通信。stop/start 成功后广播 `proxy-status-changed` 事件，其他页面收到后立即 `loadStatus()`。
- **路由模式**：Cursor 支持 Failover（故障转移）和 Round Robin（轮询分发）。Weighted 模式未实现，已从 UI 移除。
- **统一数据目录**：codex-proxy 和 hermes-proxy 共享 `~/.multi-proxy-manager/` 目录存储 providers.json 和 routing-mode.json
- **agent-proxy-switch**：`tools/agent-proxy-switch` 用于在 proxy-rebuild 与 cc-switch 间切换各 agent 的 base_url，详见下方说明

## P0 安全修复记录 (2026-07-03)

### 已修复的关键安全问题

1. **通配符路由认证绕过**: `/api/:proxy/*` 不再允许 GET/HEAD/OPTIONS 请求绕过认证
2. **XSS 漏洞**: `proxy-config.html` 中的 `onclick="copyToClipboard(...)` 已移除，改用 `data-*` 属性 + 事件委托
3. **MANAGER_PASSWORD 绕过**: 移除了设置 `MANAGER_PASSWORD` 后跳过认证的逻辑
4. **代理认证机制**: `codex-proxy` 和 `hermes-proxy` 添加了 `PROXY_AUTH_TOKEN` 环境变量支持
5. **Manager→Proxy 认证头传递**: `forwardProxy` 函数自动将 `x-proxy-auth` 头添加到转发请求

### 生产环境配置

```bash
# 设置代理认证 token（可选，不设置则禁用认证）
export PROXY_AUTH_TOKEN="your-secure-random-token"

# 重启服务
bash manage.sh restart
```

详细修复记录见: [P0-FIXES.md](P0-FIXES.md)

## P1 优化记录 (2026-07-04)

### 已完成

1. **代码重构** (P1-1): 统一 codex-proxy 和 hermes-proxy 的 `generateId()` 格式、文件路径 (`~/.multi-proxy-manager/`)、`BALANCE_ENDPOINTS` 结构
2. **日志性能优化** (P1-3): logs.html 使用事件委托替代 per-line 监听器 (500→1)，搜索输入 250ms 防抖
3. **加载状态** (P1-4): 全局 loading bar CSS 动画，dashboard/logs/proxy-config 共 8 个 API 调用已包裹 loading 状态

### 暂缓

- **前端测试覆盖** (P1-2): 现有 206 个测试已充分，抽取内联 JS 需大规模重构，不符合简洁优先原则

## 模型代理切换与 NO_PROXY 铁律

### 各 agent 代理端口（务必一致）
- codex-proxy: 18790 / hermes-proxy: 18793 / cursor-multi-model-proxy: 18794 / multi-proxy-manager: 18792
- cc-switch（独立 App，非本项目）: 15721

### 安全切换工具
- `tools/agent-proxy-switch` 用于在 proxy-rebuild 与「另一候选」间切换各 agent 的
  `base_url`（支持 codex / hermes / cursor）。设计原则：单一所有者、绝不污染全局
  环境、不误伤其它 agent、切前校验端口防死链。详见 README「模型代理切换工具」。
- **纪律**：卸载/停止「当前正在代理某 agent 的代理工具」前，先用该工具把 agent
  切到另一个所有者，否则 agent 会指向死端口而断连。

### ★ 绝对禁止：往全局环境注入裸 `*` 的 NO_PROXY
- 任何代码（install.sh / 管理脚本 / 新增工具）**禁止**执行
  `launchctl setenv NO_PROXY "...,*"` 或类似写法。
- 原因：HTTP 客户端对 NO_PROXY 按逗号拆项做 `hostname.endsWith(项)`；`*` 去前导
  通配符后为空串 → `endsWith('')` 恒真 → 所有请求绕过系统代理 → 直连被墙 IP →
  `ETIMEDOUT`，曾把 WorkBuddy、CC Switch 等全部带崩。
- 正确做法：如确需绕过 localhost，只在「该代理自身 LaunchAgent plist 的
  `<EnvironmentVariables>`」里设 `NO_PROXY=127.0.0.1,localhost,::1`，绝不用
  `launchctl setenv` 污染全局 launchd 环境。
- 历史来源：旧版 `codex-multi-model-proxy-deploy` 的 install.sh:195-196。当前
  `proxy-rebuild` 源码已无此写法，新增代码务必保持。

## 环境问题与修复

### better-sqlite3 native module 版本不匹配
- 现象：Cursor database.test.ts 22 个测试全 fail
- 根因：prebuild 仅支持 Node 18 (NODE_MODULE_VERSION 127)，当前系统 Node 24 (137)
- 修复：`cd cursor-multi-model-proxy && npm rebuild better-sqlite3` 或 `npm install`
- 若 npm cache 无写权限：`npm config set cache /tmp/npm-cache && npm rebuild better-sqlite3`

### Manager supertest EPERM
- 现象：Manager 测试中 supertest 发起 HTTP 请求时 EPERM 无法绑定 0.0.0.0
- 根因：沙箱环境禁止绑定端口
- 这是环境问题，非代码 bug。在正常本地环境或 Docker 中应通过
