<!--
multi-proxy — Copyright © 2026 xiaoxian (Jason)
Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
This file is part of the multi-proxy project.
-->

# 快速开始(5 分钟跑通)

> 给第一次接触 multi-proxy 的开发者/操作者。5 分钟从零到 `manage.sh status` 全绿。
> 完整架构见 `docs/INDEX.md`,功能完成度见 `docs/01-feature-matrix.md`,本文件只讲怎么跑起来。

---

## 前置

| 项 | 要求 |
|---|---|
| 系统 | macOS(已验证 M5 Pro / macOS 27)或 Linux;Windows 走 `deploy-local.bat` |
| 运行时 | **Node.js 20+**;cursor-proxy 的 TypeScript 测试需 **Node 24 + ESM runner**(`NODE_OPTIONS=--experimental-vm-modules`) |
| Python | 3.9+(hermes-proxy:Python/Flask)|

---

## 5 分钟

```bash
# 1. 装依赖(4 个代理 + L2 内核)
bash install.sh --all

# 2. 配 .env(仓库根有 .env.example,含 4 个代理端口:codex 18790 / hermes 18793 / cursor 18794 / manager 18792)
cp .env.example .env           # .env 在仓库根目录,不是各 agent 子目录下
#    编辑 .env,填各代理 API key;管理面板密码 MANAGER_PASSWORD 可选(不设则首次进 Web UI 引导)
#    各代理端口/变量见 l2/adapter-protocol.md、docs/04-tech/data-model.md

# 3. 起服务
bash manage.sh start

# 4. 看状态(全绿 = OK)
bash manage.sh status
```

管理面板:http://127.0.0.1:18792(4 页面 + health/alerts/registry 3 新页面)。

---

## 接入你的 agent(改一个环境变量)

> 服务起来了,还得让 agent 的模型出口指向它,能力才有意义。**改 env,不写 agent 配置文件**(符合红线 2)。
> 现状(2026-10-01 实测):**OpenAI 系 ✅ / Claude Code ❌(实施中)**。

| agent / 客户端 | 环境变量 | 状态 | 说明 |
|---|---|---|---|
| Codex CLI、任何 OpenAI SDK 客户端、OpenAI 兼容工具 | `OPENAI_BASE_URL=http://127.0.0.1:18790/v1` | ✅ **实测通过** | 见下方验证 |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:18790` | ❌ **今天会 404** | 全仓无 Anthropic `/v1/messages` 服务端路由。实施计划见 `docs/10-initiatives/22-claude-code-anthropic-ingress实施计划-2026-09-30.md`(5.5d,未落地) |
| Hermes | — | ⚠️ 不可作 chat 出口 | `hermes-proxy` **无** `/v1/chat/completions`(chat 由 Hermes 自身转发到 Ollama),见 `l2/adapters/l1-agent-adapter.js` 头部实测注释 |
| Cursor | 在 Cursor 设置里改(不是 env) | ⚠️ 需手动配 | 走 `cursor-proxy` 18794 |

**一行验证(改道是否生效)**:

```bash
# 1) 确认代理活着
curl -s http://127.0.0.1:18790/v1/models | head -c 300      # → 200,返回 deepseek/kimi 等模型清单

# 2) 改道(仅当前 shell 生效;禁止写 ~/.zshrc、禁止 launchctl setenv —— 见红线 3)
export OPENAI_BASE_URL=http://127.0.0.1:18790/v1

# 3) 用任意 OpenAI 客户端发一次请求
#    返回 {"success":false,"code":"UNSUPPORTED_MODEL"} 即证明请求落在 multi-proxy(不是 OpenAI)
#    这是 multi-proxy 自己的响应格式,OpenAI 不会这么回
```

### ⚠️ 鉴权坑(做跨机/公网前必读)

`codex-proxy` 的鉴权**只认 `x-proxy-auth` 头,不认标准的 `Authorization: Bearer`**(`codex-proxy/proxy.js:31-36`)。
当前本机 `PROXY_AUTH_TOKEN` 未设 = **fail-open**(全部放行),所以上面验证能过。
**一旦设了 `PROXY_AUTH_TOKEN`(暴露到非本机时必须设),所有标准 agent 的 Bearer 请求会被 401。**
代码自身也会打告警:`[SECURITY][fail-open] PROXY_AUTH_TOKEN unset — /api/* open to anyone reachable`。

---

## 常用命令

```bash
# 全量 / 单服务 生命周期(中文 label:codex / hermes / cursor / manager)
bash manage.sh start [codex|hermes|cursor|manager]      # start/stop/restart/status 同理
bash manage.sh status                                   # 全部服务一览
# 查单个服务:bash manage.sh status [codex|hermes|cursor|manager]
bash manage.sh logs {all|codex|hermes|cursor|manager}    # 看日志
```

---

## 跑全套测试(全绿 = 可交付)

```bash
# manager
cd multi-proxy-manager && npx jest --silent --forceExit          # 770/770 (47 suites)

# codex-proxy
cd codex-proxy && npx jest --silent --forceExit                  # 62/62 (6 suites)

# cursor-proxy(ESM,必须设 NODE_OPTIONS)
cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit   # 219/219 (17 suites · ESM)

# hermes-proxy(Python)
cd hermes-proxy && /usr/bin/python3 -m pytest tests/ -q          # 77/77 (4 files)

# L2 内核 demo(13 demo,~182 checks)
cd .. && for f in l2/*.demo.js; do node "$f"; done
# 省钱网关/成本 watchdog 单独 demo
node l2/savings-gateway/cost-watchdog.demo.js                    # 34/34
```

**测试数会随迭代增长**,以上为本轮实测值(2026-09-23);以 `docs/01-feature-matrix.md` 为准。

---

## 双入口:开源接入层 vs DSH 生态

multi-proxy 走 **接入层(永远开源) / 服务层(未来付费)** 分层(`docs/04-business/open-core-boundary.md`)。两条入口:

### 入口一:直接接入(开发者/操作者)
就是上面这套:`install → .env → manage.sh`。本机跑的 100% 能力(4 代理 + L2 内核 + L1 网关 + 省钱网关)全开源,服务层断网本机 100% 照常。

### 入口二:DSH 生态(DeepSeek Harness)
仓库 `.dsh/skills/` 注册了 2 个 DSH Skill,生态 Agent 可直接加载本项目,无需通读代码:

| DSH Skill | 用途 |
|---|---|
| `l2-orchestrator` | L2 内核(10 模块 + 4 守卫 + 23 demo)开发导引 |
| `multi-proxy` | 项目操作入口(3 代理端口 + 管理台 + 4 守卫 + 全套测试) |

> 术语:DSH 全称 **DeepSeek Harness**(官方 `deepseek-ai/deepseek-harness`,官方 `dsh-plugin` 生态)。本项目 `.dsh/skills/` 两个 SKILL.md 即按官方 `dsh-plugin` 规范编写。此前内部旧称 "Declarative Skill Hub" 已弃用。

DSH 发布(DS2 `dsh plugin add` / cordis.patch.yml)依赖 DSH 0.2,见 `docs/02-product/dsh-integration.md`;本地 DS1 骨架 + /3 能力已就绪。

---

## 红线(非侵入,务必遵守)

1. **热路径不动**:`forward.js` / `codex-proxy/proxy.js` 非授权不改。
2. **不写 agent 文件**:`~/.codex` / cursor 配置只读。
3. **不注入全局 env**:禁 `launchctl setenv NO_PROXY '*','...'`(曾崩全系统,见 AGENTS.md §2)。
4. **门控默认关 / shadow 默认开**:省钱网关、成本 watchdog、MCP 等新增能力默认不改变现状,观察后再开。
5. **lsof 用全路径** `/usr/sbin/lsof`(Node 子进程 PATH 不含 `/usr/sbin`,裸名会误判代理未运行)。

---

## 常见问题

- 代理显示未运行但实际在跑 → 确认 `/usr/sbin/lsof` 可用(必须全路径)。
- 启动失败 → `bash manage.sh logs <agent>` 看日志。
- Type