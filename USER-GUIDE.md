<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# Multi-Proxy — 新用户完整上手指南

> 面向第一次接触本项目的用户，从安装到验收的完整流程。

---

## 一、前置要求

在开始之前，确保你的系统已安装以下工具：

```bash
# 检查 Node.js（≥ 20，测试建议 24）
node --version

# 检查 Python3（≥ 3.8，Hermes 需要）
python3 --version
```

各平台安装方式：

| 平台 | Node.js + Python3 安装 |
| --- | --- |
| macOS | `brew install node python` |
| Linux (Debian/Ubuntu) | `sudo apt install nodejs npm python3`（RHEL 系用 `dnf`，Arch 用 `pacman -S nodejs python`） |
| Windows | 官网安装包：<https://nodejs.org/> 与 <https://www.python.org/> |

> 本项目支持 macOS / Linux / Windows 三端。macOS 用 launchd、Linux 用 systemd --user、Windows 用 PowerShell + 计划任务。下文默认以 bash 命令演示；Windows 请改用 `manage.ps1` / `install.ps1`。

> 如果你使用 nvm 管理 Node 版本，请确保已激活一个 ≥ 20 的版本。

---

## 二、克隆项目

```bash
cd ~/projects   # 或你喜欢的任意目录
git clone <你的仓库地址> multi-proxy
cd multi-proxy
```

项目当前包含以下本机入口与可选组件（端口按 2026-10-22 本机监听实测补齐）：

| 目录 / 组件 | 说明 | 端口 |
|------|------|------|
| `workbuddy-shim/` | 可选：WorkBuddy → OpenAI 兼容 shim | 18789 |
| `codex-proxy/` | Codex CLI / OpenAI 兼容代理 | 18790 |
| `claude-proxy/` | Claude Code 代理（Anthropic 协议 + 模型别名映射） | 18791 |
| `multi-proxy-manager/` | Web 管理后台（前端 + 后端） | 18792 |
| `hermes-proxy/` | Hermes Agent 代理 | 18793 |
| `cursor-proxy/` | Cursor IDE 代理 | 18794 |
| `tools/token-policy-bridge.js` | 可选：token 策略透明桥 | 18795 |
| `l2/savings-gateway/` | 省钱台账 + failover 网关 | 18796 |
| `dsh-proxy/` | DeepSeek Harness 专属 lane | 18797 |
| `opencode-proxy/` | opencode 代理（OpenAI 兼容透传） | 18798 |
| `generic-openai-proxy/` | Cline / Aider / OpenHands 共用代理 | 18799 |
| `opencode-free/` | 可选：opencode.ai 模型兼容插件 | 18800 |
| `unified-ingress/` | **统一入口，按路径自动分发** | **18880** |

---

## 三、安装依赖

### 方式 A：一键安装（推荐）

```bash
bash install.sh --all
```

这会自动完成：
1. 检测 Node.js 和 Python3 是否就绪
2. 为 codex-proxy 安装 npm 依赖
3. 为 hermes-proxy 安装 pip 依赖
4. 为 cursor-proxy 安装 npm 依赖并编译 TypeScript
5. 为 multi-proxy-manager 安装 npm 依赖
6. 为这四个组件准备所需配置

> **重要：**当前 `install.sh --all` 实际只覆盖 codex / hermes / cursor / manager，脚本中没有 claude / opencode / generic 的 install 函数。要使用后三者，继续执行下方「方式 C」对应目录的手动安装步骤；本文档只如实说明现状，不把未安装组件写成已安装。

### 方式 B：交互式安装

```bash
bash install.sh
```

会提示你选择要安装的组件（1=Codex, 2=Hermes, 3=Cursor, 4=Manager）。注意：Manager 是强制安装的，无法取消。

### 方式 C：逐个安装

```bash
# Codex
cd codex-proxy && npm install --production && cd ..

# Claude Code
cd claude-proxy && npm install --production && cd ..

# OpenCode
cd opencode-proxy && npm install --production && cd ..

# Generic OpenAI (Cline / Aider / OpenHands 共用)
cd generic-openai-proxy && npm install --production && cd ..

# Hermes
cd hermes-proxy && pip3 install -r requirements.txt --break-system-packages && cd ..

# Cursor
cd cursor-proxy && npm install && npm run build && cd ..

# Manager
cd multi-proxy-manager && npm install && cd ..
```

---

## 四、配置环境变量

安装完成后，先检查你实际安装的模块是否已有 `.env`；缺少时从该目录的 `.env.example` 复制后再填写。`install.sh --all` 只处理 codex / hermes / cursor / manager，不会替 claude / opencode / generic 完成安装与配置。

### 1. Codex Proxy (`codex-proxy/.env`)

```bash
nano codex-proxy/.env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 代理端口 | `18790` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 留空 |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API Key | 留空 |
| `AGNES_API_KEY` | Agnes AI API Key | 留空 |

> 不需要的供应商可以留空，不影响其他供应商使用。

### 2. Claude Proxy (`claude-proxy/.env`)

```bash
nano claude-proxy/.env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 代理端口 | `18791` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（opus/sonnet 档默认映射目标） | 留空 |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API Key | 留空 |
| `AGNES_API_KEY` | Agnes AI API Key（haiku 档默认映射目标） | 留空 |
| `CLAUDE_ALIAS_OPUS` | 可选：覆盖 opus 档映射目标（默认 `deepseek-v4-pro`） | 留空用默认 |
| `CLAUDE_ALIAS_SONNET` | 可选：覆盖 sonnet 档映射目标（默认 `deepseek-v4-pro`） | 留空用默认 |
| `CLAUDE_ALIAS_HAIKU` | 可选：覆盖 haiku 档映射目标（默认 `agnes-3.0-flash`） | 留空用默认 |

> Claude Code 接入方式：设置环境变量 `ANTHROPIC_BASE_URL=http://127.0.0.1:18791` 即可让 Claude Code 的请求经本代理映射到上游池。

### 3. OpenCode Proxy (`opencode-proxy/.env`)

```bash
nano opencode-proxy/.env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 代理端口 | `18798` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 留空 |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API Key | 留空 |
| `AGNES_API_KEY` | Agnes AI API Key | 留空 |

> opencode 接入方式：在 `opencode.jsonc` 里加一个自定义 provider，`baseURL` 指向 `http://127.0.0.1:18798/v1`，模型直接写上游真实模型名（如 `deepseek-v4-pro`）。完整配置示例见 `FUNCTIONS.md` §3.6。

### 4. Generic OpenAI Proxy (`generic-openai-proxy/.env`)

```bash
nano generic-openai-proxy/.env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 代理端口 | `18799` |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 留空 |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API Key | 留空 |
| `AGNES_API_KEY` | Agnes AI API Key | 留空 |

> Generic OpenAI Proxy 是 Cline / Aider / OpenHands 共用的 OpenAI 兼容网关（一个适配器覆盖三件套）。三家客户端把 `baseURL` 指向 `http://127.0.0.1:18799/v1`，`api_key` 随便填，模型直接写上游真实模型名（如 `deepseek-v4-pro`）。想让成本台账按客户端归因，可在请求头带 `x-agent: cline|aider|openhands`。完整配置示例见 `FUNCTIONS.md` §3.7。

### 5. Hermes Proxy (`hermes-proxy/.env`)

```bash
nano hermes-proxy/.env
```

变量与 Codex 类似：`PORT`、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`AGNES_API_KEY`。

### 6. Cursor Proxy (`cursor-proxy/.env`)

```bash
nano cursor-proxy/.env
```

| 变量 | 说明 |
|------|------|
| `PORT` | 代理端口，默认 `18794` |
| `ENCRYPTION_KEY` | 加密密钥，**留空则自动生成** |

> 如果留空，系统会在首次启动时自动生成随机密钥并保存到 `.encryption-key` 文件中。更换密钥会导致之前加密的 API Key 无法解密。

### 7. Manager (`multi-proxy-manager/.env`)

```bash
nano multi-proxy-manager/.env
```

| 变量 | 说明 |
|------|------|
| `PORT` | 管理面板端口，默认 `18792` |
| `JWT_SECRET` | JWT 签名密钥，生产环境务必修改 |
| `MANAGER_PASSWORD` | 可选：直接设置管理员密码 |

> 如果 `MANAGER_PASSWORD` 留空，首次访问管理面板时会进入密码设置引导流程。

---

## 五、启动服务

### 方式 A：通过 manage.sh 启动

```bash
# 启动所有服务
bash manage.sh start

# 启动单个服务
bash manage.sh codex start
bash manage.sh claude start
bash manage.sh opencode start
bash manage.sh generic start
bash manage.sh hermes start
bash manage.sh cursor start
bash manage.sh manager start
```

### 方式 B：通过 install.sh 启动

```bash
bash install.sh --start
```

### 方式 C：手动启动

```bash
# Codex
cd codex-proxy && node proxy.js

# Claude Code
cd claude-proxy && node proxy.js

# OpenCode
cd opencode-proxy && node proxy.js

# Generic OpenAI (Cline / Aider / OpenHands 共用)
cd generic-openai-proxy && node proxy.js

# Hermes
cd hermes-proxy && python3 proxy.py

# Cursor
cd cursor-proxy && node dist/server/start.js

# Manager（必须先启动所有代理后再启动 Manager）
cd multi-proxy-manager && node server.js
```

### 验证启动成功

```bash
bash manage.sh status
```

期望看到：

```
✓ Codex Proxy    - 运行中 (PID: xxx, 端口: 18790)
✓ Claude Proxy   - 运行中 (PID: xxx, 端口: 18791)
✓ OpenCode Proxy - 运行中 (PID: xxx, 端口: 18798)
✓ Generic OpenAI Proxy - 运行中 (PID: xxx, 端口: 18799)
✓ Hermes Proxy   - 运行中 (PID: xxx, 端口: 18793)
✓ Cursor Proxy   - 运行中 (PID: xxx, 端口: 18794)
✓ Manager Shell  - 运行中 (PID: xxx, 端口: 18792)
  访问地址: http://localhost:18792
```

> `install.sh --all` 只安装其中 codex / hermes / cursor / manager；Claude / OpenCode / Generic 只有在你按「方式 C」手动安装并启动后才会出现在状态列表中。

---

## 接入你的 agent（装完后的下一步）

服务运行不等于 agent 已经改道。按客户端选择一种入口；以下 `export` 只在当前 shell 生效，不污染全局环境。

### Codex CLI / OpenAI SDK / OpenAI 兼容工具

```bash
export OPENAI_BASE_URL=http://127.0.0.1:18790/v1
```

`18790` 是直接入口。统一入口 18880 已运行时，也可把值改为 `http://127.0.0.1:18880/v1`。

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18880
export ANTHROPIC_MODEL=deepseek-v4-pro
```

- `18880` 是统一入口；未运行时可把 `ANTHROPIC_BASE_URL` 改为 `http://127.0.0.1:18791` 直连 claude-proxy。
- `ANTHROPIC_MODEL` 必须是上游真实模型名；示例 `deepseek-v4-pro` 已由本机模型列表验证存在。
- claude-proxy（18791）与 codex-proxy（18790）自 2026-10-02 起均已实现 `/v1/messages`。

### 统一入口 18880 怎么分发

| 请求路径 | 后端 |
|----------|------|
| `/v1/messages` | claude-proxy（18791） |
| `/v1/responses`、`/v1/chat/completions`、`/v1/models` | codex-proxy（18790） |
| `/api/*` | manager（18792） |

### Cursor

1. 打开 `Cursor → Settings → Models → Override OpenAI Base URL`。
2. `Base URL` 填 `http://127.0.0.1:18794`。
3. `API Key` 填任意非空值；18794 的 `/v1` 端点不校验该值。
4. 模型选择 18794 `/v1/models` 返回的真实名称，例如 `agnes-3.0-flash`。不要使用 Cursor 默认的 `gpt-5` / `claude-3.7-sonnet` / `claude-sonnet-4`，这些名称实测返回 404。

### 一行验证

```bash
curl --noproxy '*' http://127.0.0.1:18790/v1/models
bash manage.sh status
```

第一条应返回 `object: "list"` 的模型清单；第二条检查服务状态。当前仓库的 `manage.sh` 文件模式是 `100644`，应使用 `bash manage.sh status`；直接执行 `./manage.sh status` 会报 `permission denied`。

---

## 六、访问管理面板

在浏览器中打开：

```
http://localhost:18792
```

### 首次访问

1. 如果是第一次使用，会跳转到登录页 (`/login.html`)
2. 页面会引导你设置管理员密码（密码强度检测）
3. 设置完成后，使用用户名 `admin` 和你设置的密码登录

### 四个页面

| 页面 | 路径 | 功能 |
|------|------|------|
| 概览 | `/` (dashboard.html) | 代理状态卡片、版本信息、一键启停、自动刷新 |
| 日志 | `/logs` (logs.html) | 全代理日志聚合、过滤/搜索/时间范围/TXT+CSV 导出 |
| 代理配置 | `/proxy-config` (proxy-config.html) | 供应商管理（仅 Cursor 支持 CRUD）、模型切换、余额查询 |
| 登录 | `/login` (login.html) | 登录 / 首次设置密码 |

---

## 七、修改配置

### 修改 API Key

直接编辑对应模块的 `.env` 文件，然后重启服务：

```bash
bash manage.sh restart codex
# 或
bash manage.sh restart all
```

### 修改 Manager 密码

```bash
# 删除密码文件后重启，会进入设置引导
rm ~/.multi-proxy-manager/password
bash manage.sh restart manager
```

### 修改端口

编辑对应模块的 `.env` 文件中的 `PORT` 变量，然后重启。

### 修改 Manager 认证方式

在 `multi-proxy-manager/.env` 中设置 `MANAGER_PASSWORD=你的密码`，然后重启 Manager。如果想跳过鉴权（仅限开发环境），设为 `MANAGER_PASSWORD=""`。

---

## 八、开机自启

开机自启按平台不同：

### macOS（launchd）

```bash
bash install.sh --autostart    # 启用
bash install.sh --autostop     # 禁用
```

这会在 `~/Library/LaunchAgents/com.multi-proxy-manager.plist` 创建一个 LaunchAgent，登录后自动启动所有服务。脚本会自动检测 nvm/pyenv 路径并写入 PATH。

诊断：
```bash
ls ~/Library/LaunchAgents/com.multi-proxy-manager.plist
launchctl load ~/Library/LaunchAgents/com.multi-proxy-manager.plist
launchctl getenv PATH
```

### Linux（systemd 用户服务）

```bash
bash install.sh --autostart    # 启用
bash install.sh --autostop     # 禁用
```

会写入 `~/.config/systemd/user/multi-proxy-manager.service`，登录时自启。

诊断：
```bash
systemctl --user status multi-proxy-manager
systemctl --user restart multi-proxy-manager
# 若希望无登录也常驻：
loginctl enable-linger "$USER"
```

### Windows（计划任务）

```powershell
.\install.ps1            # 安装并自动配置登录自启
.\install.ps1 -Uninstall # 移除自启任务
```

自启通过当前用户的登录计划任务 `MultiProxyManager` 实现，无需管理员权限。

---

## 九、查看日志

### 命令行

```bash
# 查看所有服务日志
bash manage.sh logs all

# 查看单个服务日志
bash manage.sh logs codex
bash manage.sh logs hermes
bash manage.sh logs cursor
bash manage.sh logs manager
```

日志文件位于 `/tmp/` 目录下：
- `/tmp/codex-proxy.log`
- `/tmp/hermes-proxy.log`
- `/tmp/cursor-proxy.log`
- `/tmp/manager.log`

### 管理面板

打开 `http://localhost:18792/logs.html`，可以在 Web 界面中：
- 按服务/时间范围过滤
- 全文搜索
- 导出为 TXT 或 CSV
- 点击复制单条日志

---

## 十、停止服务

```bash
# 停止所有
bash manage.sh stop

# 停止单个
bash manage.sh stop codex
bash manage.sh stop hermes
bash manage.sh stop cursor
bash manage.sh stop manager
```

Manager 停止时采用两阶段机制：先 SIGTERM，等待 500ms 后如果进程仍在运行则 SIGKILL。

---

## 十一、卸载

```bash
bash install.sh --uninstall
```

这会：
1. 停止所有服务
2. 删除各模块的 `.env` 文件
3. 移除开机自启配置
4. **保留** `node_modules` 和源代码目录

如需彻底删除，手动删除整个项目目录：

```bash
rm -rf ~/projects/multi-proxy
```

---

## 十二、常见问题排查

### 代理显示"未运行"但实际在运行

管理器通过 `lsof` 端口检测判断状态。测试 lsof 是否可用：

```bash
/usr/sbin/lsof -i :18790
```

如果返回空但端口确实在监听，可能是 PATH 问题。确保 `lsof` 使用完整路径 `/usr/sbin/lsof`。

### Cursor 代理 TypeScript 编译失败

```bash
cd cursor-proxy
npm run build 2>&1 | tee /tmp/cursor-build.log
cat /tmp/cursor-build.log
```

### 管理面板打不开

1. 确认 Manager 已启动：`bash manage.sh status`
2. 检查端口占用：`lsof -i :18792`
3. 查看 Manager 日志：`bash manage.sh logs manager`

### 忘记管理员密码

```bash
rm ~/.multi-proxy-manager/password
bash manage.sh restart manager
```

然后重新访问 `http://localhost:18792` 进行密码设置。

---

## 十三、验收测试

### 1. 安装测试依赖

运行测试前，确保 Python 测试依赖已安装：

```bash
pip3 install flask pyyaml requests pytest --break-system-packages
```

> **注意：** `flask` 是 Hermes 代理的运行时依赖，但沙箱/新环境中可能未安装。如果跑 Hermes 测试时报 `ModuleNotFoundError: No module named 'flask'`，请先执行上面的命令。

### 2. 运行测试

以下命令都从仓库根目录执行：

```bash
(cd multi-proxy-manager && npx jest --silent --forceExit)
(cd codex-proxy && npx jest --silent --forceExit)
(cd claude-proxy && npx jest --silent --forceExit --worker=1)
(cd generic-openai-proxy && npx jest --silent --forceExit --worker=1)
(cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --silent --forceExit)
(cd hermes-proxy && python3 -m pytest tests/ -q)
find l2 -name '*.demo.js' -print0 | xargs -0 -n1 node
```

### 3. 2026-10-22 真跑基线

| 检查项 | 真实结果 |
|--------|----------|
| Manager 测试 | 1579 pass / 1 fail |
| Codex 测试 | 179 pass |
| Claude 测试 | 174 pass |
| Generic 测试 | 207 pass / 3 timeout |
| Cursor 测试 | 258 pass |
| Hermes 测试 | 80 pass |
| L2 demo | 55 pass / 1 fail |

失败与超时均按 2026-10-22 输出原样保留，当前基线不是“全绿”。opencode / dsh / shell 没有纳入本次真跑，不沿用旧数字。

### 4. 功能验收

| 检查项 | 验证方式 |
|--------|---------|
| 所有服务启动成功 | `bash manage.sh status` 显示 4 个 ✓ |
| 管理面板可访问 | 浏览器打开 `http://localhost:18792` |
| 登录/登出正常 | 设置密码后登录，点击登出 |
| 代理启停按钮 | Dashboard 页面对各代理点击启停 |
| 日志查看 | Logs 页面能看到各代理日志 |
| 供应商配置 | Proxy Config 页面能查看/编辑供应商 |
| 余额查询 | 配置 API Key 后能查询余额 |

---

## 十四、项目结构速览

```
multi-proxy/
├── manage.sh              # 服务管理脚本（启停、状态、日志）
├── install.sh             # 安装/卸载/自启脚本
├── README.md              # 项目文档
├── AGENTS.md              # 开发规范
│
├── multi-proxy-manager/   # Web 管理后台
│   ├── server.js          # 后端（Express）
│   ├── public/            # 前端页面
│   │   ├── dashboard.html  # 概览页
│   │   ├── login.html      # 登录页
│   │   ├── logs.html       # 日志页
│   │   ├── proxy-config.html # 配置页
│   │   └── index.html      # 重定向到 dashboard
│   ├── .env.example       # 环境变量模板
│   └── tests/             # 测试
│
├── codex-proxy/           # Codex 代理
│   ├── proxy.js
│   ├── .env.example
│   └── tests/
│
├── claude-proxy/          # Claude Code 代理（Anthropic 协议 + 模型别名映射）
│   ├── proxy.js
│   ├── .env.example
│   └── tests/
│
├── opencode-proxy/        # opencode 代理（OpenAI 兼容透传）
├── generic-openai-proxy/  # Cline/Aider/OpenHands 共用代理（OpenAI 兼容透传）
│   ├── proxy.js
│   ├── .env.example
│   └── tests/
│
├── hermes-proxy/          # Hermes 代理
│   ├── proxy.py
│   ├── requirements.txt
│   ├── .env.example
│   └── tests/
│
└── cursor-proxy/  # Cursor 代理
    ├── src/               # TypeScript 源码
    ├── dist/              # 编译产物
    ├── .env.example
    └── tests/
```
