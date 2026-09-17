# 9 角色代码评审汇总 — 2026-08-24

> 各角色完整报告见本目录 `1-产品经理.md` ~ `9-普通用户.md`。
> 本次会话已完成并提交的修复：`0e60e45`（server.js childCmd 语法错误 + 测试同步 P0 认证 + 文档修正）。

## 全量测试基线（本次会话实测）
Codex 36/36 ✅ | Hermes 63/63 ✅ | Cursor 71/71 ✅（需 PATH 用 /usr/local/bin 的 Node v24）| Manager 379/379 ✅ = **549/549**

## 跨角色共识的 Top 问题（按严重度）

### 🔴 P0 — 必须修复
| # | 问题 | 来源 | 位置 |
|---|------|------|------|
| 1 | Docker 卷把密码文件路径挂成目录，首次设置密码必然 EISDIR 失败 → 认证体系瘫痪 | 普通用户 | docker-compose.yml + server.js:75 |
| 2 | hermes 容器 Flask 绑定 127.0.0.1，宿主机端口映射实际不通（冒烟实测确认：容器内 /health 正常，宿主机 curl 空响应）| 架构师 + 冒烟验证 | Dockerfile.hermes |
| 3 | 日志页解析格式与后端 JSON Lines 写入格式不匹配，级别/代理/时间过滤器全部静默失效 | 产品经理 | logs.html:747 vs server.js:196-218 |
| 4 | cursor admin-api 零认证 + CORS *，局域网内任何人可增删供应商、读取 API Key | 后端 | cursor src/server/app.ts |
| 5 | esc() 不转义引号 + CSP 允许 unsafe-inline = 存储型 XSS 完整链 | 前端 | dashboard.html:930 等三处 |
| 6 | 加密密钥用相对 cwd 路径，重启后可能无法解密已有 API Key | 数据库 | cursor src/utils/crypto.ts:29 |
| 7 | LaunchAgent KeepAlive=true + 一次性脚本 = 无限重启风暴 + stdout.log 无限增长 | 运维 | install.sh:374-377 |
| 8 | providers.json 多进程双写无锁无原子性，并发写丢数据 | 数据库/架构师 | codex proxy.js / proxy.py |

### 🟡 P1 — 尽快修复
- 忘记密码指引指向不存在的 `~/.multi-proxy-password`（实际是 `~/.multi-proxy-manager/password`）— login.html:755
- providers.json 明文存 API Key 且权限未收紧 — codex/hermes
- delete 后判空死代码 ×3 → 僵尸进程泄漏 — server.js
- JSON 解析错误直接暴露 Node 堆栈（泄露内部路径）— server.js 错误中间件
- proxy-config/login 无暗色模式初始化；proxy-config 缺字体加载链 — UI
- history/switch-model/exportLogs 前端断头路（后端就绪）— 产品经理
- logs 表零索引、models.name 无索引（热路径全表扫描）— 数据库

### 🟢 P2 — 排期优化
- server.js 1414 行单文件巨石；codex/hermes/cursor 三份跨语言重复实现已漂移约 70%
- 大面积「复制实现到测试里」伪测试（codex 全部单测、manager crash-recovery 等）
- 版本号硬编码、fault 状态不上 UI、confirm() 与自定义 modal 混用
- 无数据库迁移框架（PRAGMA user_version）、无备份策略、日志无轮转
- 间距无设计令牌、硬编码颜色逃逸遍布四页、可访问性欠账（焦点态/键盘导航）

## ✅ 共识的优点
- 安全基础扎实：JWT+bcrypt+双 limiter、spawn 白名单三重校验、转发端点白名单、PID 白名单防误杀
- cursor-proxy 工程质量最高（WAL/FK/checkpoint/AES-GCM/参数化查询）
- NO_PROXY 铁律与 lsof 绝对路径规范全仓库合规
- 文档纪律好（踩坑记忆沉淀进 CLAUDE.md）；测试规模 549 个在个人项目中罕见

## 冒烟测试结果（2026-08-24 实测）
- manage.sh status：4 服务全部显示运行中 ⚠️ 但 PID 同为 94999（Docker Desktop 进程），状态检测把 Docker 当宿主进程，参考价值有限
- codex /health /v1/models /api/routing-mode /api/history /api/balances → 全部 200 ✅
- manager /health /api/status → 200 ✅；/api/logs 无 token → 401 ✅（认证生效）
- 4 个静态页面全部 200 ✅
- cursor chat 空请求 → 规范错误 JSON ✅；admin-api 200 ⚠️（无认证，见 P0-4）
- **hermes 宿主机访问空响应 ❌**（P0-2 实锤：容器内正常、端口映射失效）
