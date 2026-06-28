# Proxy Rebuild — 新用户完整上手指南

> 面向第一次接触本项目的用户，从安装到验收的完整流程。

---

## 一、前置要求

在开始之前，确保你的 Mac 上已安装以下工具：

```bash
# 检查 Node.js（≥ 16）
node --version

# 检查 Python3（≥ 3.8）
python3 --version

# 如果没有，安装
brew install node python
```

> 如果你使用 nvm 管理 Node 版本，请确保已激活一个 ≥ 16 的版本。

---

## 二、克隆项目

```bash
cd ~/projects   # 或你喜欢的任意目录
git clone <你的仓库地址> proxy-rebuild
cd proxy-rebuild
```

项目包含四个模块，扁平目录结构：

| 目录 | 说明 | 端口 |
|------|------|------|
| `multi-proxy-manager/` | Web 管理后台（前端+后端） | 18792 |
| `codex-proxy/` | Codex CLI 代理 | 18790 |
| `hermes-proxy/` | Hermes Agent 代理 | 18793 |
| `cursor-multi-model-proxy/` | Cursor IDE 代理 | 18794 |

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
4. 为 cursor-multi-model-proxy 安装 npm 依赖并编译 TypeScript
5. 为 multi-proxy-manager 安装 npm 依赖
6. 为缺少 `.env` 的模块自动创建 `.env` 副本

### 方式 B：交互式安装

```bash
bash install.sh
```

会提示你选择要安装的组件（1=Codex, 2=Hermes, 3=Cursor, 4=Manager）。注意：Manager 是强制安装的，无法取消。

### 方式 C：逐个安装

```bash
# Codex
cd codex-proxy && npm install --production && cd ..

# Hermes
cd hermes-proxy && pip3 install -r requirements.txt --break-system-packages && cd ..

# Cursor
cd cursor-multi-model-proxy && npm install && npm run build && cd ..

# Manager
cd multi-proxy-manager && npm install && cd ..
```

---

## 四、配置环境变量

安装完成后，每个模块目录下会生成一个 `.env` 文件（从 `.env.example` 复制而来）。你需要根据实际需求填写。

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

### 2. Hermes Proxy (`hermes-proxy/.env`)

```bash
nano hermes-proxy/.env
```

变量与 Codex 类似：`PORT`、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY`、`AGNES_API_KEY`。

### 3. Cursor Proxy (`cursor-multi-model-proxy/.env`)

```bash
nano cursor-multi-model-proxy/.env
```

| 变量 | 说明 |
|------|------|
| `PORT` | 代理端口，默认 `18794` |
| `ENCRYPTION_KEY` | 加密密钥，**留空则自动生成** |

> 如果留空，系统会在首次启动时自动生成随机密钥并保存到 `.encryption-key` 文件中。更换密钥会导致之前加密的 API Key 无法解密。

### 4. Manager (`multi-proxy-manager/.env`)

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

# Hermes
cd hermes-proxy && python3 proxy.py

# Cursor
cd cursor-multi-model-proxy && node dist/server/start.js

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
✓ Hermes Proxy   - 运行中 (PID: xxx, 端口: 18793)
✓ Cursor Proxy   - 运行中 (PID: xxx, 端口: 18794)
✓ Manager Shell  - 运行中 (PID: xxx, 端口: 18792)
  访问地址: http://localhost:18792
```

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
rm ~/.multi-proxy-password
bash manage.sh restart manager
```

### 修改端口

编辑对应模块的 `.env` 文件中的 `PORT` 变量，然后重启。

### 修改 Manager 认证方式

在 `multi-proxy-manager/.env` 中设置 `MANAGER_PASSWORD=你的密码`，然后重启 Manager。如果想跳过鉴权（仅限开发环境），设为 `MANAGER_PASSWORD=""`。

---

## 八、开机自启

### 启用

```bash
bash install.sh --autostart
```

这会在 `~/Library/LaunchAgents/com.multi-proxy-manager.plist` 创建一个 LaunchAgent，登录后自动启动所有服务。脚本会自动检测 nvm/pyenv 路径并写入 PATH。

### 禁用

```bash
bash install.sh --autostop
```

### 诊断

```bash
# 检查 plist 是否存在
ls ~/Library/LaunchAgents/com.multi-proxy-manager.plist

# 手动加载
launchctl load ~/Library/LaunchAgents/com.multi-proxy-manager.plist

# 查看 PATH
launchctl getenv PATH
```

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
rm -rf ~/projects/proxy-rebuild
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
cd cursor-multi-model-proxy
npm run build 2>&1 | tee /tmp/cursor-build.log
cat /tmp/cursor-build.log
```

### 管理面板打不开

1. 确认 Manager 已启动：`bash manage.sh status`
2. 检查端口占用：`lsof -i :18792`
3. 查看 Manager 日志：`bash manage.sh logs manager`

### 忘记管理员密码

```bash
rm ~/.multi-proxy-password
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

### 2. 运行所有单元测试

```bash
# Manager
cd multi-proxy-manager && NODE_ENV=test npx jest --verbose --forceExit

# Codex
cd codex-proxy && NODE_ENV=test npx jest --verbose --forceExit

# Hermes
cd hermes-proxy && PYTHONPATH=. python3 -m pytest tests/ -v

# Cursor
cd cursor-multi-model-proxy && NODE_OPTIONS='--experimental-vm-modules' npx jest --verbose
```

### 2. 验收清单

| 检查项 | 预期结果 |
|--------|---------|
| Manager 测试 | 80/80 通过 |
| Codex 测试 | 36/36 通过 |
| Hermes 测试 | 41/41 通过 |
| Cursor 测试 | 49/49 通过 |
| **总计** | **206/206 通过** |

### 3. 功能验收

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
proxy-rebuild/
├── manage.sh              # 服务管理脚本（启停、状态、日志）
├── install.sh             # 安装/卸载/自启脚本
├── README.md              # 项目文档
├── CLAUDE.md              # 开发规范
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
├── hermes-proxy/          # Hermes 代理
│   ├── proxy.py
│   ├── requirements.txt
│   ├── .env.example
│   └── tests/
│
└── cursor-multi-model-proxy/  # Cursor 代理
    ├── src/               # TypeScript 源码
    ├── dist/              # 编译产物
    ├── .env.example
    └── tests/
```
