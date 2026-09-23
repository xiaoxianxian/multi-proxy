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
cd multi-proxy-manager && npx jest --silent --forceExit          # 当前 722/722

# codex-proxy
cd codex-proxy && npx jest --silent --forceExit                  # 55/55

# cursor-proxy(ESM,必须设 NODE_OPTIONS)
cd cursor-proxy && NODE_OPTIONS=--experimental-vm-modules npx jest --forceExit   # 193/193

# hermes-proxy(Python)
cd hermes-proxy && /usr/bin/python3 -m pytest tests/ -q          # 63/63

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

### 入口二:DSH 生态(Declarative Skill Hub)
仓库 `.dsh/skills/` 注册了 2 个 DSH Skill,生态 Agent 可直接加载本项目,无需通读代码:

| DSH Skill | 用途 |
|---|---|
| `l2-orchestrator` | L2 内核(10 模块 + 4 守卫 + 13 demo)开发导引 |
| `multi-proxy` | 项目操作入口(3 代理端口 + 管理台 + 4 守卫 + 全套测试) |

DSH 发布(DS2 `dsh plugin add` / cordis.patch.yml)依赖 DSH 0.2,见 `docs/02-product/dsh-integration.md`;本地 DS1 骨架 + option2/3 能力已就绪。

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