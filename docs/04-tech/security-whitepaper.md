# 安全模型白皮书 — 密钥/日志/网络边界（2026-09-21）

> 来源：老板转 DeepSeek 会话（批评⑥"缺安全/隐私白皮书"）+ AGENTS.md 安全铁律。
> 把项目**已有**的安全机制整理成一份可对外的安全白皮书，并**诚实标注缺口与待拍板项**。
> 每节 grounded 到代码行。**不编造；现状与待决策分开列。**

---

## 一、已有安全机制（据实，可对外讲）

### 1.1 认证
| 机制 | 实现 | 证据 |
|---|---|---|
| JWT 签发/验证 | `jsonwebtoken` | `lib/auth.js:2` |
| JWT secret 持久化 | `~/.multi-proxy-jwt-secret`，**0o600 权限**，64 随机字节生成，env `JWT_SECRET` 优先 | `lib/auth.js:10,34,36` |
| 密码哈希 | `bcryptjs`（bcrypt，非明文） | `lib/auth.js:3` |
| 管理面板密码 | `MANAGER_PASSWORD`（可选，未设则 Web UI 首次引导设） | `.env.example` |

### 1.2 前端安全头（CSP 三件套，齐全）
`server.js:44-51` 全局中间件，每响应注入：
| 头 | 值 | 作用 |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; ... object-src 'none'; base-uri 'self'; form-action 'self'` | 防 XSS / 注入外部脚本 |
| `X-Content-Type-Options` | `nosniff` | 防 MIME 嗅探 |
| `X-Frame-Options` | `DENY` | 防点击劫持 |
| `X-XSS-Protection` | `1; mode=block` | 旧浏览器 XSS 过滤 |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | 限制 referrer 泄露 |

### 1.3 错误不泄露内部
`server.js:91-98`：JSON 解析失败/内部错误统一返回简洁文案（`Invalid request body` / `Internal server error`），**不暴露 Node 堆栈/内部路径**。

### 1.4 密钥管理
| 项 | 现状 | 证据 |
|---|---|---|
| `.env` 不入库 | `.gitignore` 第 6 行 | `.gitignore:6` |
| `result.json` 不入库 | `.gitignore` 第 22 行（option3 产物） | `.gitignore:22` |
| `.env` 权限 | `0o600`（`-rw-------`） | `ls .env` |
| JWT secret 权限 | `0o600` | `lib/auth.js:36` |

### 1.5 agent 侧安全铁律（AGENTS.md §1/§2 + P0-FIXES）
| 铁律 | 落地 |
|---|---|
| 单一所有者 | `agent-proxy-switch`：一 agent base_url 同时只指向一代理 |
| NO_PROXY 铁律 | 绝不 `launchctl setenv NO_PROXY '*'`；代理自身 plist 内 `=127.0.0.1,localhost,::1` |
| lsof 全路径 | `/usr/sbin/lsof`（子进程 PATH 缺 `/usr/sbin`，裸用误判代理未运行） |
| 非侵入 | 不写 agent 文件 / 不注入全局 env / 不写死端口 / 门控默认关（见 `non-intrusion.md`） |

---

## 二、[现状缺口 / 待拍板] 诚实标注

| 项 | 现状（据实，grep+ls 实证） | 风险 | 待拍板（明早老板定） |
|---|---|---|---|
| **服务绑定地址** | `multi-proxy-manager` `app.listen(PORT)` **不带 host = 0.0.0.0 全网卡**（`server.js:131`，Node 默认）；`hermes-proxy` 默认 `127.0.0.1`（`proxy.py:704`，可 `BIND_HOST` 改） | 管理面板全网卡可达；**缓解**：有 JWT 保护，无 token 打不到受保护 API | **是否统一收 127.0.0.1**？或保持 0.0.0.0 + JWT 双保险？ |
| **日志脱敏** | route 决策日志记 `taskPrompt` 截前 50 字（`route-engine.js` decision ring）；**无 `log_redaction` 三档配置** | shadow 日志可能含任务内容摘要 | 是否加 `log_redaction: full / metadata_only / off` 三档？ |
| **路由覆盖硬规则** | 未实现（`routing_overrides`/`force_provider` 全仓 0 命中） | 用户无法"某些任务锁强模型" | 是否实现 `routing_overrides` 配置形（DeepSeek 建议） |
| **跨机访问** | 无 SSH 隧道文档 | 远程看面板需暴露端口 | README 附 SSH 隧道命令示例（文档级，零代码风险） |

---

## 三、给用户的即时建议（现状即可）

1. **管理面板只开本机能访问**：建议把 `multi-proxy-manager` 绑定收到 127.0.0.1（`server.js:131` 加 host 参数）或走 SSH 隧道；当前 0.0.0.0 靠 JWT 兜底，但多一层隔离更稳。**（待老板拍板后我改，热路径 server.js 不擅自动）**
2. **改 JWT_SECRET**：`.env` 里 `JWT_SECRET` 已从 `.env.example` 模板值（`change-me-to-a-random-string`）改成本机随机值（见 §1.1，持久化 0o600）；生产环境务必保持非默认。
3. **`.env` 永不入库**：已 gitignore + 0o600，保持。
4. **agent 侧按铁律**：用 `agent-proxy-switch` 切代理，不手改 config、不碰 launchd。

---

## 四、grounded 总表

| 断言 | 证据 |
|---|---|
| JWT + secret 0o600 | `lib/auth.js:2,10,34,36` |
| bcrypt 密码哈希 | `lib/auth.js:3` |
| CSP 三件套 | `server.js:44-51` |
| 错误不泄堆栈 | `server.js:91-98` |
| .env / result.json gitignore + 0o600 | `.gitignore:6,22`；`ls .env` |
| manager 0.0.0.0 / hermes 127.0.0.1 | `server.js:131`；`hermes-proxy/proxy.py:704` |
| 无 log_redaction / 无 routing_overrides | grep 全仓 0 命中 |

_落盘：2026-09-21 · 作者：贾维斯（Hermes Agent）· 据实 grep+ls 实证 · 缺口诚实标注 · 热路径 server.js 仅文档引用、未改_
