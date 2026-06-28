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
nano hermes-proxy/.env
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
bash install.sh --autostop    # 禁用开机自启
```

## 管理面板功能

### 概览页 (Dashboard)

- **代理状态卡片** — 实时显示 Codex、Hermes、Cursor 三个代理的运行状态（运行中/未运行/未安装）
- **版本信息** — 显示当前系统版本号
- **一键启停** — 对每个代理独立执行启动/停止/重启操作
- **自动刷新** — 支持 5/10/30/60 秒和关闭五种刷新间隔，偏好自动保存到 localStorage
- **移动端适配** — 侧边栏折叠 + hamburger 菜单

### 日志页 (Logs)

- **全代理日志聚合** — 统一查看四个模块的运行日志
- **多维过滤** — 按代理类型、日志级别（INFO/WARN/ERROR）、关键词搜索、时间范围筛选
- **快速操作** — 点击复制单行日志、导出为 TXT/CSV、清空日志
- **自动刷新** — 支持定时刷新实时查看日志

### 代理配置页 (Proxy Config)

- **供应商管理** — 增删改查供应商配置（目前仅 Cursor 代理支持完整 CRUD，Codex/Hermes 为只读展示）
- **模型切换** — 为每个代理选择当前使用的模型
- **余额查询** — 查询 DeepSeek、Moonshot、Agnes AI 等供应商的账户余额
- **切换历史** — 记录模型切换操作的历史日志
- **路由模式** — 支持 Failover（故障转移）、Round Robin（轮询）等路由策略

### 登录页 (Login)

- **首次设置** — 首次访问引导创建管理员密码，带密码强度指示器
- **常规登录** — 已有密码时输入密码登录
- **速率限制** — 登录失败 5 次锁定 15 分钟，每分钟最多 5 次尝试
- **密码强度检测** — 四级强度指示（Weak/Fair/Good/Strong）

## 代理服务功能

### Codex Proxy

- 上游模型转发（DeepSeek、Moonshot、Agnes AI）
- 模型列表查询 (`/v1/models`)
- 健康检查 (`/health`)
- 供应商状态查询 (`/api/providers/status`)
- 路由模式管理 (`/api/routing-mode`)
- 切换历史 (`/api/history`)
- 余额查询 (`/api/balances`)
- 流式传输支持 (`/v1/chat/completions` stream)

### Hermes Proxy

- YAML 配置文件解析
- 模型切换 (`/api/switch-model`)
- 路由模式管理 (`/api/routing-mode`)
- 供应商状态查询 (`/api/providers/status`)
- 健康检查 (`/health`)
- 余额查询 (`/api/balances`)
- 切换历史 (`/api/history`)

### Cursor Proxy

- **Provider 注册表** — 支持 OpenAI Compatible、Anthropic Claude、Google Gemini、Ollama、Generic Provider 五种供应商适配器
- **SQLite 持久化** — 供应商配置、模型列表、路由规则、日志均持久化到本地数据库
- **路由引擎** — Priority（优先级）、Round Robin（轮询）、Cost Optimization（成本优化）三种路由策略
- **熔断器** — 连续失败自动熔断，防止雪崩效应
- **限流器** — 基于令牌桶算法的速率限制
- **流式翻译** — 请求/响应格式标准化转换
- **健康监控** — 定期轮询供应商健康状态
- **加密存储** — AES-256-GCM 加密 API Key

## 安全机制

- **认证鉴权** — JWT + bcrypt 密码哈希，首次访问引导设置密码
- **进程沙箱** — spawn 路径/命令白名单校验，防止命令注入
- **API 转发白名单** — 精确控制每个代理允许的端点和方法
- **速率限制** — 登录双重限流，防止暴力破解
- **CSP 头部** — 内容安全策略防止 XSS
- **CORS 策略** — 限制跨域访问来源
- **错误信息脱敏** — 生产环境不暴露堆栈和内部细节
- **密钥加密** — Cursor 代理使用 AES-256-GCM 加密存储 API Key

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
npm run build 2>&1 | tee logs/cursor-build.log
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
├── logs/                  # 日志输出目录
├── multi-proxy-manager/   # Web 管理后台
│   ├── server.js          # 后端服务
│   └── public/            # 前端页面
│       ├── dashboard.html
│       ├── login.html
│       ├── logs.html
│       ├── proxy-config.html
│       └── index.html
├── codex-proxy/           # Codex CLI 代理
│   ├── proxy.js
│   └── .env.example
├── hermes-proxy/          # Hermes Agent 代理
│   ├── proxy.py
│   └── requirements.txt
└── cursor-multi-model-proxy/  # Cursor IDE 代理
    ├── src/               # TypeScript 源码
    │   ├── providers/     # 供应商适配器
    │   ├── routing/       # 路由引擎
    │   ├── monitoring/    # 熔断器/限流器/健康监控
    │   ├── translate/     # 流式翻译器
    │   ├── server/        # Express 路由和中间件
    │   ├── db/            # SQLite 数据库
    │   └── utils/         # 加密工具
    ├── dist/              # 编译产物
    └── .env.example
```

## License

Internal use only.
