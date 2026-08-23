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

- **供应商管理** — 增删改查供应商配置（Codex、Hermes、Cursor 三个代理均支持完整 CRUD）
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

## 模型代理切换工具（agent-proxy-switch）

当 proxy-rebuild 正在修 bug、暂时用不了时，你可能想让某个 agent 退回其它方式；
反之 proxy-rebuild 修好后想切回来。为避免「两套代理同时拥有同一个 agent 的
base_url 而打架」，项目提供统一切换器 `tools/agent-proxy-switch`。

### 设计铁律
1. **单一所有者**：每个 agent 同一时刻的 `base_url` 只能指向一个代理。这由
   配置文件结构天然保证（base_url 只能有一个值），无需额外加锁。
2. **绝不污染全局环境**：切换器只改各 agent 自己的配置文件，绝不使用
   `launchctl setenv NO_PROXY/no_proxy`。历史上往 launchd 注入含裸 `*` 的
   NO_PROXY 曾导致所有走系统代理的 GUI 应用直连被墙 IP 而超时（详见
   下方「已知问题 #1」）。**任何代码都禁止写裸 `*`**。
3. **不误伤其它 agent / 不管理进程**：切 codex 只动 codex 配置，切 hermes 只动
   hermes 配置；启停代理由 install.sh / manage.sh 负责。
4. **不死链**：切到某代理前先确认其端口在监听，否则拒绝写入。

### 各 agent 的可选所有者
| agent  | proxy-rebuild 端口 | 另一候选 | 配置位置 | 切换方式 |
|--------|-------------------|----------|----------|----------|
| codex  | 18790             | cc-switch (15721) | `~/.codex/config.toml` 的 `[model_providers.custom]` | 全自动 |
| hermes | 18793             | direct（直连 agnes 真实地址） | `~/.hermes/config.yaml` 的 `model.base_url` + `providers.custom.base_url` | 全自动 |
| cursor | 18794             | direct（清空 Cursor 自带 base） | Cursor GUI（Settings → Models） | 半自动（打印步骤） |

> 说明：CC Switch 实际只代理 Claude（codex 是你手动 pin 到 15721 的），
> 不支持 hermes/cursor，所以 hermes/cursor 的另一候选是「直连真实服务商」。

### 用法
```bash
bash tools/agent-proxy-switch                  # 状态总览（全部 agent）
bash tools/agent-proxy-switch <agent>          # 单个 agent 状态
bash tools/agent-proxy-switch <agent> <owner>  # 切换所有者

# 例：把 codex 从 cc-switch 切到 proxy-rebuild（需 proxy-rebuild 已启动）
bash tools/agent-proxy-switch codex proxy-rebuild
# 例：proxy-rebuild 修 bug 时，把 hermes 退回直连
bash tools/agent-proxy-switch hermes direct
```
（该脚本已软链到 `/usr/local/bin/agent-proxy-switch`，可直接敲命令名调用。）

### 重要纪律
卸载或停止「当前正在代理某个 agent 的代理工具」之前，务必先用本工具把该 agent
切到另一个所有者，否则 agent 会指向死端口而断连。

## 已知问题与待修复

### #1 〔历史·已规避〕裸 `*` 污染全局 NO_PROXY（曾导致全系统代理失效）
- **现象**：往 launchd 注入 `NO_PROXY=127.0.0.1,localhost,*`，使所有走系统代理
  环境变量的 GUI 应用（WorkBuddy、CC Switch 的 outbound 等）把「所有域名」判定为
  不走代理，直连被墙 IP → `ETIMEDOUT`。
- **精确位置**：旧版 `codex-multi-model-proxy-deploy`（proxy-rebuild 前身）的
  `install.sh` 第 195–196 行与 `README.md` 第 133–134 行含
  `launchctl setenv no_proxy "127.0.0.1,localhost,*"`。
- **当前状态**：`proxy-rebuild` 源码已无此写法（全仓库扫描确认），autostart plist
  仅设 `PATH`，未塞 `NO_PROXY`。
- **修复写法**：`*` 改为 `::1`，即 `127.0.0.1,localhost,::1`；更好的做法是只在
  「该代理自身 plist 的 `<EnvironmentVariables>`」里设 `NO_PROXY`，绝不用
  `launchctl setenv` 污染全局。
- **原理**：HTTP 客户端对 `NO_PROXY` 按逗号拆项做 `hostname.endsWith(项)`；`*`
  去前导通配符后为空串 → `endsWith('')` 恒真 → 全部绕过代理。

### #2 〔当前〕`install.sh --uninstall` 卸载不完整（LaunchAgent 残留）
- **现象**：`uninstall_launchd`（install.sh:212–219）只删除
  `com.multi-proxy-manager.plist`，不清理早期部署遗留的 `com.codex.*` /
  `com.xiaoxian.*` LaunchAgents。重装新版本时可能与旧 plist 冲突。
- **修复**：卸载时扫描并移除已知 plist 名称集合（`com.multi-proxy-manager`、
  `com.codex.*`、`com.xiaoxian.*`）；或统一成单一 LaunchAgent 命名，避免多套并存。

### #3 〔设计〕缺少「单一所有者」保护 / 安全切换手段
- **现象**：项目没有机制防止 proxy-rebuild 与 cc-switch 同时把同一 agent 的
  `base_url` 指向自己；也没有安全的翻转手段。
- **修复**：`tools/agent-proxy-switch` 已提供安全切换（见上节）。install.sh /
  manage.sh 在安装或启停代理时，应**避免改动 cc-switch 已拥有的 agent 配置**
  （如 codex 的 `config.toml`）。

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
