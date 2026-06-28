# Proxy Rebuild v1.0.0 — 功能说明书

> 多代理管理系统 · 统一管理 Codex / Hermes / Cursor 三个 AI 代理服务

---

## 一、系统架构

| 模块 | 技术栈 | 端口 | 职责 |
|------|--------|------|------|
| **multi-proxy-manager** | Node.js + Express | 18792 | Web 管理后台（前端 4 页 + 后端 API + 进程管理） |
| **codex-proxy** | Node.js + Express | 18790 | Codex CLI 代理，转发上游模型请求 |
| **hermes-proxy** | Python + Flask | 18793 | Hermes Agent 代理，YAML 配置驱动 |
| **cursor-multi-model-proxy** | TypeScript + Express + SQLite | 18794 | Cursor IDE 代理，Provider 注册表 + SQLite 持久化 |

---

## 二、管理面板功能

### 2.1 概览页 (Dashboard)

#### 顶部统计卡片

| 卡片 | 显示内容 | 数据来源 |
|------|---------|---------|
| 代理服务 | 运行中/总数（如 3/3） | `/api/status` |
| 已安装代理 | 已安装/总数（如 3/3） | `/api/installed` |

#### 版本信息卡片

| 字段 | 说明 | 数据来源 |
|------|------|---------|
| 管理器版本 | 如 v1.0.0 | `/api/version` |
| Codex Proxy | 版本号 | `/api/version` |
| Hermes Proxy | 版本号 | `/api/version` |
| Cursor Proxy | 版本号 | `/api/version` |

#### 代理状态卡片（每个代理一张）

每张卡片包含：
- **名称**：Codex Proxy / Hermes Proxy / Cursor Proxy
- **图标**：🤖 / ⚡ / ☁
- **运行状态**：● 运行中（绿色）/ ○ 未运行（灰色）
- **端口**：18790 / 18793 / 18794
- **操作按钮**：启动 / 停止 / 重启

#### 自动刷新控制面板

- 开关：自动刷新 ON/OFF
- 间隔选择：5 秒 / 10 秒（默认）/ 30 秒 / 60 秒 / 关闭
- 偏好保存：localStorage

#### 侧边栏导航

| 区域 | 项目 |
|------|------|
| 品牌区 | P 图标 + "Proxy Manager" + "Multi-Proxy Control" |
| 总览 | 📊 概览（当前页高亮） |
| 代理配置 | 动态生成（按已安装代理） |
| 系统 | 📝 日志 |
| 底部 | v1.0.0 |

### 2.2 登录页 (Login)

#### 首次设置模式

- **标题**：Set Admin Password
- **描述**：Create a secure password to protect your proxy management console.
- **字段**：
  - Password（密码输入框，最小 8 字符）
  - Confirm Password（确认密码）
- **密码强度指示器**：四级（Weak / Fair / Good / Strong），彩色条形图
- **按钮**：Create Admin Account
- **成功提示**：绿色 Toast "Password set successfully!"，1.5 秒后跳转 Dashboard

#### 常规登录模式

- **标题**：Welcome Back
- **描述**：Enter your password to access the proxy management console.
- **字段**：Password
- **按钮**：Sign In
- **底部链接**：Forgot password? Contact administrator

#### 安全机制

- 登录失败 5 次锁定 15 分钟
- 每分钟最多 5 次尝试
- 密码使用 bcrypt 哈希存储
- 登录成功返回 JWT Token，存入 sessionStorage

### 2.3 日志页 (Logs)

#### 筛选栏

| 控件 | 类型 | 选项 |
|------|------|------|
| 代理筛选 | Select | 全部代理 / Codex Proxy / Hermes Proxy / Cursor Proxy |
| 级别筛选 | Select | 全部级别 / INFO / WARN / ERROR |
| 搜索框 | Input | 关键词模糊匹配 |
| 时间范围 | 按钮组 | 1 小时 / 6 小时 / 24 小时 / 全部（默认） |
| 刷新 | 按钮 | 手动刷新日志 |
| 自动刷新 | 按钮 | 开启/关闭定时刷新 |
| 导出 | 按钮 | TXT / CSV |
| 清空 | 按钮 | 清空日志（需认证） |

#### 日志表格

| 列名 | 宽度 | 说明 |
|------|------|------|
| 时间 | 固定 | 格式化时间戳 |
| 代理 | 固定 | 服务来源标识 |
| 级别 | 固定 | INFO/WARN/ERROR 彩色标签 |
| 消息 | 自适应 | 日志内容，点击复制 |

- 排序：点击列头排序
- 分页：每页 50 条

### 2.4 代理配置页 (Proxy Config)

#### 页面头部

- **代理图标**：C（Codex）/ H（Hermes）/ C（Cursor）
- **代理名称**：如 "Cursor Proxy"
- **状态徽章**：● 运行中（绿色）/ ○ 未运行（红色）
- **端口徽章**：Port 18794
- **操作按钮**：启动/停止切换、刷新

#### Tab 页签

| Tab | 内容 | 可操作 |
|-----|------|--------|
| 配置 | 配置文件路径、当前模型、路由模式、健康状态 | 路由模式下拉切换 |
| 供应商 | 供应商列表（名称、状态、模型数、余额） | 仅 Cursor 支持增删改查 |
| 模型 | 模型列表（名称、供应商、状态） | 切换当前模型 |
| 余额 | 各供应商余额查询结果 | 手动查询 |

#### 供应商管理（仅 Cursor）

- **新增**：弹窗表单（名称、Provider ID、API Key、Base URL、是否启用）
- **编辑**：同新增，预填充数据
- **删除**：二次确认
- **启用/禁用**：开关切换

#### 模型切换

- 下拉选择目标模型
- 提交后记录切换历史

#### 路由模式

| 模式 | 说明 |
|------|------|
| Failover | 故障转移，主 Provider 失败自动切换到备用 |
| Round Robin | 轮询分发请求 |
| Weighted | 加权分配（Cursor 特有） |

---

## 三、代理服务功能

### 3.1 Codex Proxy

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查，返回模型列表 |
| `/v1/models` | GET | 模型列表 |
| `/v1/chat/completions` | POST | 聊天补全（流式/非流式） |
| `/api/providers/status` | GET | 供应商状态 |
| `/api/routing-mode` | GET/POST | 路由模式查询/设置 |
| `/api/history` | GET | 切换历史 |
| `/api/balances` | GET | 余额查询 |

支持的模型：deepseek-v4-pro, deepseek-v4-flash, moonshot-v1-8k, kimi-k2.5, agnes-2.0-flash 等 17 个

### 3.2 Hermes Proxy

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/api/models` | GET | 模型列表 |
| `/api/config` | GET | 配置信息 |
| `/api/providers/status` | GET | 供应商状态 |
| `/api/routing-mode` | GET/POST | 路由模式 |
| `/api/switch-model` | POST | 切换模型 |
| `/api/history` | GET | 切换历史 |
| `/api/balances` | GET | 余额查询 |

配置文件：`~/.hermes/config.toml`

### 3.3 Cursor Proxy

| 端点 | 方法 | 说明 |
|------|------|------|
| `/chat/completions` | POST | 聊天补全（标准化 OpenAI 格式） |
| `/v1/chat/completions` | POST | 兼容 OpenAI 格式 |
| `/admin-api/providers` | CRUD | 供应商管理 |
| `/admin-api/models` | CRUD | 模型管理 |
| `/admin-api/routes` | CRUD | 路由规则管理 |
| `/admin-api/settings` | GET/PUT | 系统设置 |
| `/admin-api/logs` | GET | 系统日志 |
| `/health` | GET | 健康检查 |

支持的 Provider：
- OpenAI Compatible（通用 OpenAI 兼容接口）
- Anthropic Claude
- Google Gemini
- Ollama（本地模型）
- Generic Provider（透传模式）

高级特性：
- **熔断器**：连续失败自动熔断，指数退避恢复
- **限流器**：令牌桶算法
- **健康监控**：定期轮询供应商状态
- **加密存储**：AES-256-GCM 加密 API Key

---

## 四、安全机制

| 机制 | 实现 | 说明 |
|------|------|------|
| 认证鉴权 | JWT + bcrypt | 首次访问引导设置密码 |
| 速率限制 | express-rate-limit | 登录 5 次/分钟，失败 5 次锁定 15 分钟 |
| CSP 头部 | Content-Security-Policy | 限制资源加载来源 |
| CORS 策略 | 仅允许 localhost:18792 | 限制跨域访问 |
| 进程白名单 | spawn 路径/命令校验 | 防止命令注入 |
| API 转发白名单 | FORWARD_ENDPOINTS | 精确控制代理端点访问 |
| 错误脱敏 | 不暴露堆栈和内部细节 | 生产安全 |
| 密钥加密 | AES-256-GCM | Cursor 代理 API Key 加密存储 |

---

## 五、服务管理

### 5.1 manage.sh

| 命令 | 说明 |
|------|------|
| `manage.sh start` | 启动所有服务 |
| `manage.sh stop` | 停止所有服务（SIGTERM → 1s → SIGKILL） |
| `manage.sh restart` | 重启所有服务 |
| `manage.sh status` | 查看服务状态（端口检测） |
| `manage.sh logs [all\|codex\|hermes\|cursor\|manager]` | 查看日志 |
| `manage.sh codex start` | 单独管理 Codex |
| `manage.sh hermes stop` | 单独管理 Hermes |
| `manage.sh cursor restart` | 单独管理 Cursor |
| `manage.sh manager status` | 单独管理 Manager |

### 5.2 install.sh

| 命令 | 说明 |
|------|------|
| `install.sh` | 交互式安装向导 |
| `install.sh --all` | 静默安装全部组件 |
| `install.sh --uninstall` | 卸载（停止服务 + 删除 .env + 移除 LaunchAgent） |
| `install.sh --autostart` | 启用开机自启 |
| `install.sh --autostop` | 禁用开机自启 |
| `install.sh --status` | 查看安装状态 |

### 5.3 开机自启

- 使用 macOS LaunchAgent
- 配置文件：`~/Library/LaunchAgents/com.multi-proxy-manager.plist`
- 自动检测 nvm/pyenv 路径
- RunAtLoad + KeepAlive 保证持续运行

---

## 六、测试覆盖

| 模块 | 测试文件 | 测试数 | 框架 |
|------|---------|--------|------|
| Manager | tests/unit/api.test.js | 13 | Jest |
| Manager | tests/unit/secrets.test.js | 8 | Jest |
| Manager | tests/unit/providers.test.js | 8 | Jest |
| Manager | tests/unit/crash-recovery.test.js | 27 | Jest |
| Manager | tests/unit/e2e-scenarios.test.js | 24 | Jest+supertest |
| Codex | tests/proxy.test.js | 19 | Jest |
| Codex | tests/integration.test.js | 17 | Jest+supertest |
| Hermes | tests/test_proxy_logic.py | 21 | Pytest |
| Hermes | tests/integration_test.py | 20 | Pytest |
| Cursor | tests/unit/providers.test.ts | 29 | Jest+TS |
| Cursor | tests/unit/engine-monitoring.test.ts | 20 | Jest+TS |
| **总计** | | **206** | |

---

## 七、文件结构

```
proxy-rebuild/
├── manage.sh              # 服务管理脚本
├── install.sh             # 安装/卸载脚本
├── logs/                  # 日志输出目录
├── CLAUDE.md              # 开发规范
├── README.md              # 用户文档
├── USER-GUIDE.md          # 新用户上手指南
├── PROJECT-STATUS.md      # 项目状态记录
├── multi-proxy-manager/
│   ├── server.js          # 后端服务
│   ├── package.json
│   ├── public/
│   │   ├── dashboard.html  # 概览页
│   │   ├── login.html      # 登录页
│   │   ├── logs.html       # 日志页
│   │   ├── proxy-config.html # 配置页
│   │   └── index.html      # 重定向到 dashboard
│   └── tests/
├── codex-proxy/
│   ├── proxy.js
│   ├── package.json
│   └── tests/
├── hermes-proxy/
│   ├── proxy.py
│   ├── requirements.txt
│   └── tests/
└── cursor-multi-model-proxy/
    ├── src/
    │   ├── providers/       # 供应商适配器
    │   ├── routing/         # 路由引擎
    │   ├── monitoring/      # 熔断器/限流器/健康监控
    │   ├── translate/       # 流式翻译器
    │   ├── server/          # Express 路由和中间件
    │   ├── db/              # SQLite 数据库
    │   └── utils/           # 加密工具
    ├── dist/                # 编译产物
    └── tests/
```

---

## 八、环境变量配置

### Codex / Hermes Proxy

```
PORT=18790                    # 代理端口
DEEPSEEK_API_KEY=             # DeepSeek API Key
MOONSHOT_API_KEY=             # Moonshot/Kimi API Key
AGNES_API_KEY=                # Agnes AI API Key
```

### Cursor Proxy

```
PORT=18794                    # 代理端口
ENCRYPTION_KEY=               # 留空自动生成，或自定义（≥32 字符）
```

### Manager

```
PORT=18792                    # 管理面板端口
JWT_SECRET=                   # JWT 签名密钥
MANAGER_PASSWORD=             # 可选：预设管理员密码
```

---

## 九、已知限制

1. `lsof` 必须使用完整路径 `/usr/sbin/lsof`（macOS 环境）
2. 代理进程由 Manager 通过端口检测回退判断运行状态
3. 仅 Cursor 支持完整的供应商 CRUD，Codex/Hermes 的供应商页面为只读展示
4. 日志文件输出到 `logs/` 目录（非 `/tmp/`）
