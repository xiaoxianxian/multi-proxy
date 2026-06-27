# Proxy Rebuild — 多代理管理系统

统一管理 Codex、Hermes、Cursor 三个 AI 代理服务，提供 Web 管理界面。

## 架构

| 模块 | 技术栈 | 端口 | 说明 |
|------|--------|------|------|
| `codex-proxy/` | Node.js + Express | 18790 | Codex CLI 代理 |
| `hermes-proxy/` | Python + Flask | 18793 | Hermes Agent 代理 |
| `cursor-multi-model-proxy/` | Node.js + TypeScript + SQLite | 18794 | Cursor IDE 代理 |
| `multi-proxy-manager/` | Node.js + Express | 18792 | Web 管理界面 |

## 快速开始

```bash
# 安装依赖
bash install.sh --all

# 编辑 .env 配置 API Key
nano codex-proxy/.env
nano cursor-multi-model-proxy/.env

# 启动所有服务
bash manage.sh start

# 查看状态
bash manage.sh status

# 访问管理后台
open http://localhost:18792
```

## 常用命令

```bash
# 管理服务
./manage.sh start          # 启动所有
./manage.sh stop           # 停止所有
./manage.sh restart        # 重启所有
./manage.sh status         # 查看状态
./manage.sh logs all       # 查看所有日志

# 单个服务
./manage.sh codex start
./manage.sh cursor logs
./manage.sh manager status

# 安装/卸载
./install.sh               # 交互式安装
./install.sh --start       # 启动所有服务
./install.sh --uninstall   # 卸载
./install.sh --autostart   # 启用开机自启
```

## 各代理模块

- [Codex Proxy](codex-proxy/README.md) — Codex CLI 多模型代理
- [Hermes Proxy](hermes-proxy/README.md) — Hermes Agent 多模型代理
- [Cursor Multi-Model Proxy](cursor-multi-model-proxy/README.md) — Cursor IDE 多模型代理

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 管理器端口 | `18792` |
| `MANAGER_PASSWORD` | 管理员密码（首次使用后建议设置） | 空 |
| `JWT_SECRET` | JWT 签名密钥 | 自动生成 |

各代理模块的 `.env` 文件在其目录下，配置 API Key 后即可使用。

## 常见问题

**Q: 启动后所有代理显示"未运行"**

A: 检查 `manage.sh logs all` 查看日志。如果代理是通过其他方式启动的，管理器会通过端口检测自动识别。

**Q: 忘记密码怎么办**

A: 删除 `~/.multi-proxy-password` 文件后重启管理器，会进入密码设置模式。

**Q: 开机自启不生效**

A: 运行 `./install.sh --autostart` 配置 LaunchAgent。使用 nvm/pyenv 的用户会自动检测并添加到 PATH。

**Q: TypeScript 编译失败**

A: Cursor 代理需要编译 TypeScript。查看编译日志: `cat /tmp/cursor-build.log`。ARM Mac 可能需要 `xcode-select --install`。
