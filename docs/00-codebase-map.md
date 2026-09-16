# docs/00-codebase-map.md — 代码库地图

> 本文件自动从项目结构 + `docs/01-feature-matrix.md` + 实际目录扫描生成，不手编。
> 最后验证：2026-09-17，HEAD `d9219af`，main。

---

## 目录总览

| 路径 | 用途 | 关键文件 |
|------|------|----------|
| 根目录/ | 项目入口 + 文档 | `AGENTS.md`, `CLAUDE.md`, `manage.sh`, `docker-compose.yml`, `ITERATION-ROADMAP.md` |
| multi-proxy-manager/ | Node.js+Express 管理后端（Web UI） | `server.js`, `lib/`, `routes/`, `public/`, `main.js`（Electron 壳） |
| codex-proxy/ | Node.js+Express Codex CLI 代理 | `proxy.js` |
| hermes-proxy/ | Python+Flask Hermes Agent 代理 | `proxy.py`, `tests/` |
| cursor-proxy/ | TypeScript+SQLite Cursor IDE 代理 | `src/server/app.ts`, `src/server/router.ts`, `data/proxy.db` |
| l2/ | L2 编排内核（10 模块 + 3 adapter） | `plugin-runtime.js`, `agent-registry.js`, `decomposer.js`, `llm-decomposer.js`, `orchestrator.js`, `alert.js`, `cost.js`, `route-engine.js`, `memory-merge.js`, `skill-service.js` |
| l2/adapters/ | L2 adapter（3 个） | `h3web-adapter.js`, `aigc-adapter.js`, `l1-agent-adapter.js` |
| docs/ | 项目文档 | `INDEX.md`, `01-feature-matrix.md`, `03-adr/`, `06-test/` 等 |
| .dsh/skills/ | DSH 技能骨架 | `multi-proxy-agent.skill.json`, `multi-proxy-skill.skill.json` |

---

## 各模块速查

### multi-proxy-manager（端口 18792）

```
multi-proxy-manager/
├── server.js              # Express 应用入口（port 18792）
├── main.js                # Electron 壳（P5 已验收）
├── launch-gui.sh          # GUI 启动脚本（xattr + 后端检查）
├── package.json           # electron@31, express, sqlite3, axios 等
├── lib/
│   ├── agent-owner.js     # 单一保护（防双开 + detectAll 占用检测）
│   ├── auth.js            # JWT + bcrypt 认证
│   ├── process-manager.js # 代理启停（进程管理）
│   ├── logger.js          # 日志聚合（TRIM_INTERVAL=500，O(n) 已修）
│   ├── cost-track.js      # 成本分析（A/B 路，门控默认关）
│   └── forward.js         # 上游转发（C2 已标幽灵路径）
├── routes/
│   ├── proxy-control.js   # 启停/状态/logs（热路径）
│   ├── proxy-api.js       # 供应商 CRUD（test-connection/fetch-models/balances）
│   ├── auth.js            # 登录/状态
│   ├── meta.js            # 健康/版本/env-check/errors
│   ├── alert.js           # 告警配置/采集
│   ├── registry.js        # Agent 注册中心
│   ├── sessions.js        # 会话管理
│   ├── orchestration.js   # L2 编排调用
│   └── provider-health.js # 供应商健康探针
├── public/
│   ├── dashboard.html     # 概览页
│   ├── logs.html          # 日志页
│   ├── proxy-config.html  # 模型切换页
│   └── login.html         # 登录页
└── tests/
    └── *.test.js          # jest，635 tests 全绿
```

### codex-proxy（端口 18790）

```
codex-proxy/
├── proxy.js               # Express 入口
├── package.json
├── tests/
│   ├── proxy.test.js
│   ├── integration.test.js
│   └── auth-and-admin.test.js  # +17 tests，53 total
└── node_modules/          # 依赖
```

### hermes-proxy（端口 18793）

```
hermes-proxy/
├── proxy.py               # Flask 入口
├── requirements.txt
└── tests/
    ├── test_proxy_logic.py
    ├── test_http_endpoints.py
    └── integration_test.py  # 63 pytest checks
```

### cursor-proxy（端口 18794）

```
cursor-proxy/
├── src/
│   └── server/
│       ├── app.ts         # Fastify 应用
│       └── router.ts      # 路由定义
├── data/
│   └── proxy.db           # SQLite 数据库（providers/models/routes/settings）
├── dist/server/
│   └── app.js             # 编译产物
└── tests/
    └── unit/*.test.ts     # jest，119 tests 全绿
```

### l2/ 编排内核

```
l2/
├── plugin-runtime.js      # 插件生命周期（register→enabled→started→stopped）
├── agent-registry.js      # Agent 能力注册中心 + 路由匹配
├── decomposer.js          # 任务拆解引擎
├── llm-decomposer.js      # LLM 驱动的任务拆解
├── orchestrator.js        # 多 agent 编排调度
├── alert.js               # 健康告警（4 规则引擎，shadow 默认关）
├── cost.js                # 成本分析（A/B 路）
├── route-engine.js        # 按任务类型路由（视频/文本/未知）
├── memory-merge.js        # 跨 agent 记忆合并
├── skill-service.js       # 技能服务注册与调用
└── adapters/
    ├── h3web-adapter.js   # 本地 H3 文生视频（HTTP 协议）
    ├── aigc-adapter.js    # AIGC 生图/生视频（通用协议）
    └── l1-agent-adapter.js # L1 chat 型（Codex/Hermes）
```

---

## 关键接口契约

详见 `docs/04-tech/api.md`。

---

## 文档索引

- `docs/INDEX.md` — 项目文档总入口
- `docs/01-feature-matrix.md` — 功能完成度矩阵（所有测试数字来源）
- `docs/04-tech/api.md` — API 接口文档
- `docs/04-tech/data-model.md` — 数据模型
- `l2/adapter-protocol.md` — L2 开放接入协议
- `l2/CASES.md` — 3 个核心使用案例
- `l2/PERF-REPORT.md` — L2 性能报告
