# Proxy Rebuild — 多代理管理系统

统一管理 Codex、Hermes、Cursor 三个 AI 代理服务，提供 Web 管理界面、进程管理、日志查看和代理配置。

## 架构

| 模块 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| `multi-proxy-manager/` | Node.js + Express | 18792 | Web 管理界面（前端 + 后端） |
| `codex-proxy/` | Node.js + Express | 18790 | Codex CLI 代理 |
| `hermes-proxy/` | Python + Flask | 18793 | Hermes Agent 代理 |
| `cursor-multi-model-proxy/` | TypeScript + Express + SQLite | 18794 | Cursor IDE 代理 |

## 快速开始

```bash
# 安装依赖
bash install.sh --all

# 编辑各代理的 .env 文件配置 API Key
nano codex-proxy/.env
nano cursor-multi-model-proxy/.env

# 启动所有服务
bash manage.sh start

# 打开管理面板
# http://localhost:18792
```

## 常用命令

```bash
# 管理服务
bash manage.sh start          # 启动所有服务
bash manage.sh stop           # 停止所有服务
bash manage.sh restart        # 重启所有服务
bash manage.sh status         # 查看服务状态
bash manage.sh logs all       # 查看所有日志
bash manage.sh logs codex     # 查看单个服务日志

# 单独管理
bash manage.sh codex start
bash manage.sh hermes stop
bash manage.sh cursor restart
bash manage.sh manager status

# 安装/卸载
bash install.sh               # 交互式安装
bash install.sh --all         # 一键安装全部
bash install.sh --uninstall   # 卸载
bash install.sh --autostart   # 启用开机自启
bash install.sh --status      # 查看安装状态
```

## 管理面板功能

- **概览页** — 代理运行状态、版本信息、一键启停、自动刷新
- **日志页** — 全代理日志聚合、过滤/搜索/时间范围/TXT+CSV 导出
- **代理配置页** — 供应商管理（Cursor）、模型切换、余额查询、切换历史

## 安全须知

- 首次访问管理面板时需要设置管理员密码
- 密码使用 bcrypt 哈希存储，不保存在代码或 Git 中
- 支持 `MANAGER_PASSWORD` 环境变量设置初始密码
- 开发时可设 `MANAGER_PASSWORD=""` 跳过鉴权

## 常见问题

### 代理显示"未运行"但实际在运行？

管理器通过 `lsof` 端口检测判断代理状态。确保 `lsof` 命令可用：
```bash
/usr/sbin/lsof -i :18790  # 测试 lsof 是否能查到端口
```

### 代理启动失败？

```bash
# 查看日志
bash manage.sh logs codex
bash manage.sh logs hermes
bash manage.sh logs cursor
bash manage.sh logs manager

# 手动启动查看错误
cd codex-proxy && node proxy.js
cd cursor-multi-model-proxy && node dist/server/start.js
```

### Cursor 代理 TypeScript 编译失败？

```bash
cd cursor-multi-model-proxy
npm run build 2>&1 | tee /tmp/cursor-build.log
```

### 忘记密码怎么办？

删除密码文件后重启管理器会进入密码设置模式：
```bash
rm ~/.multi-proxy-password
bash manage.sh restart manager
```

### 开机自启不生效？

```bash
# 启用自启
bash install.sh --autostart

# 检查 LaunchAgent
ls ~/Library/LaunchAgents/com.multi-proxy-manager.plist

# 手动加载
launchctl load ~/Library/LaunchAgents/com.multi-proxy-manager.plist
```

### 使用 nvm 的用户？

自启脚本会自动检测 nvm 路径。如果仍然找不到 node：
```bash
# 检查 PATH
launchctl getenv PATH

# 手动编辑 plist 添加 nvm 路径
nano ~/Library/LaunchAgents/com.multi-proxy-manager.plist
```

## 目录结构

```
proxy-rebuild/
├── manage.sh              # 服务管理脚本
├── install.sh             # 安装/卸载脚本
├── multi-proxy-manager/   # Web 管理后台
│   ├── server.js          # 后端服务
│   └── public/            # 前端页面
│       ├── dashboard.html
│       ├── login.html
│       ├── logs.html
│       └── proxy-config.html
├── codex-proxy/           # Codex CLI 代理
│   ├── proxy.js
│   └── .env.example
├── hermes-proxy/          # Hermes Agent 代理
│   ├── proxy.py
│   └── requirements.txt
└── cursor-multi-model-proxy/  # Cursor IDE 代理
    ├── src/               # TypeScript 源码
    ├── dist/              # 编译产物
    └── .env.example
```

## License

Internal use only.
