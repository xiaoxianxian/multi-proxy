# E2E Matrix Cases Manifest — 50 条

多仓 multi-proxy-manager 的 E2E 矩阵重生(10-16~10-18)。隔离 harness:worktree@HEAD + throwaway HOME + 18801(非生产 18792)。
真凭据全程未动。P3 全量结果:**45 passed + 5 skipped = 50**。

## 字段说明
- **id**: 60 字内唯一标识
- **intent**: 用例意图(一句)
- **scope**: e2e(真浏览器)/ skip(环境不适用)
- **priority**: P0(认证/安全核心)/ P1(核心页面)/ P2(页面细节)
- **tags**: 功能域
- **status**: ✅ 真 E2E 通过 / ⏸ skip(待拍板)

| # | id | intent | scope | priority | tags | status |
|---|---|---|---|---|---|---|
| 1 | auth-setup-mode-visible | fresh 无密码时显示 setup 态,隐藏 login 态 | e2e | P0 | auth | ✅ |
| 2 | auth-setup-then-login | 设置密码即 store token 并 auto-redirect dashboard | e2e | P0 | auth | ✅ |
| 3 | auth-reject-wrong-password | 错误密码被拒,客户端显示 Invalid password | e2e | P0 | auth | ✅ |
| 4 | auth-dashboard-after-login | 登录后 dashboard 渲染 + 代理卡 ≥1 | e2e | P0 | auth,dashboard | ✅ |
| 5 | dash-proxy-cards-names | 在跑代理(codex+hermes)渲染卡片 | e2e | P1 | dashboard | ✅ |
| 6 | dash-port-badges | 端口 badge :18790/:18793 命中 | e2e | P1 | dashboard | ✅ |
| 7 | dash-toggle-buttons | 启停按钮按在跑代理渲染 | e2e | P1 | dashboard | ✅ |
| 8 | dash-config-button-nav | 卡片配置动作可达 proxy-config | e2e | P1 | dashboard | ✅ |
| 9 | dash-version-info | 版本 section 列全 3 代理 | e2e | P1 | dashboard | ✅ |
| 10 | dash-installed-count | 已装代理数数字渲染 | e2e | P1 | dashboard | ✅ |
| 11 | dash-auto-refresh-panel | 自动刷新面板默认开 | e2e | P1 | dashboard | ✅ |
| 12 | dash-sidebar-nav | sidebar 核心 section 渲染(12 项) | e2e | P1 | dashboard | ✅ |
| 13 | logs-load-viewer | 日志 viewer 渲染 + 空态占位 | e2e | P1 | logs | ✅ |
| 14 | logs-proxy-filter | 代理筛选下拉(全 3 代理) | e2e | P1 | logs | ✅ |
| 15 | logs-level-filter | 级别筛选(INFO/WARN/ERROR) | e2e | P1 | logs | ✅ |
| 16 | logs-search-input | 搜索框占位符 + 过滤后 viewer 仍在 | e2e | P1 | logs | ✅ |
| 17 | logs-time-range-btns | 4 个时间按钮(1h/6h/24h/全部) | e2e | P1 | logs | ✅ |
| 18 | logs-refresh-btn | 刷新按钮可点 | e2e | P1 | logs | ✅ |
| 19 | logs-export-capability | 导出能力存在(window.exportLogs) | e2e | P1 | logs | ✅ |
| 20 | logs-auto-refresh-toggle | 自动刷新按钮可点 | e2e | P1 | logs | ✅ |
| 21 | logs-navigate-back | 从 logs 可回 dashboard | e2e | P1 | logs | ✅ |
| 22 | pc-load-config-page | codex 配置页加载(config tab active) | e2e | P1 | proxy-config | ✅ |
| 23 | pc-section-tabs | 4 个 section tab(配置/供应商/模型/余额) | e2e | P1 | proxy-config | ✅ |
| 24 | pc-switch-models-tab | 切到模型 tab | e2e | P2 | proxy-config | ⏸ tab 切换 HEAD 不生效 |
| 25 | pc-persist-hash | tab 选择落 URL hash(#models) | e2e | P2 | proxy-config | ✅ |
| 26 | pc-provider-tab-disabled | 供应商 tab 初始 HTML 带 disabled 属性 | e2e | P2 | proxy-config | ✅ |
| 27 | pc-balance-tab-disabled | 余额 tab 初始 HTML 带 disabled 属性 | e2e | P2 | proxy-config | ✅ |
| 28 | pc-provider-body-dom | 供应商表 body 在 DOM(空态) | e2e | P2 | proxy-config | ✅ |
| 29 | pc-model-select | 模型下拉填充 | e2e | P2 | proxy-config | ⏸ 面板不可达 |
| 30 | pc-balance-grid-dom | 余额 grid 在 DOM | e2e | P2 | proxy-config | ✅ |
| 31 | pc-routing-mode | 路由模式 Failover/Round Robin | e2e | P2 | proxy-config | ⏸ codex 用 model-switch UI |
| 32 | pc-start-stop-btn | 代理启停按钮 | e2e | P1 | proxy-config | ✅ |
| 33 | pc-stay-navigable | tab 来回切页面可达 | e2e | P2 | proxy-config | ⏸ 依赖 tab 切换 |
| 34 | pc-back-dashboard | 返回概览跳 dashboard | e2e | P1 | proxy-config | ✅ |
| 35 | authz-gate-logs | 未登录访问 logs → redirect login | e2e | P0 | auth | ✅ |
| 36 | authz-gate-proxy-config | 未登录访问 proxy-config → 受控 | e2e | P0 | auth | ✅ |
| 37 | authz-401-logs-api | 无 token 调 /api/logs/clear → 401 | e2e | P0 | auth | ✅ |
| 38 | authz-401-stop-api | 无 token 调 /api/stop/codex → 401 | e2e | P0 | auth | ✅ |
| 39 | authz-401-start-api | 无 token 调 /api/start/codex → 401 | e2e | P0 | auth | ✅ |
| 40 | authz-accept-valid-token | 有效 token 调受控端点 → 200 | e2e | P0 | auth | ✅ |
| 41 | authz-auth-status-endpoint | /api/auth/status 公开 + needsSetup | e2e | P0 | auth | ✅ |
| 42 | sec-csp-headers | CSP default-src/object-src | e2e | P0 | security | ✅ |
| 43 | sec-x-content-type | X-Content-Type-Options nosniff | e2e | P0 | security | ✅ |
| 44 | sec-x-frame-options | X-Frame-Options DENY | e2e | P0 | security | ✅ |
| 45 | sec-x-xss-protection | X-XSS-Protection 1; mode=block | e2e | P0 | security | ✅ |
| 46 | sec-referrer-policy | Referrer-Policy 存在 | e2e | P0 | security | ✅ |
| 47 | sec-xss-provider-names | 恶意 provider 名转义 | skip | P1 | security | ⏸ cursor 未运行 + tab 切换失效 |
| 48 | sec-log-viewer-safe | 日志 viewer 无注入 script | e2e | P1 | security | ✅ |
| 49 | sec-iframe-deny | iframe 嵌入被 DENY | e2e | P0 | security | ✅ |
| 50 | sec-object-src | CSP object-src none | e2e | P0 | security | ✅ |

## 分布
01(4) + 02(8) + 03(9) + 04(13) + 05(7) + 06(9) = **50**。真 E2E 通过 45,skip 5(全在 04 的 tab 切换 + 06 的 provider-XSS)。
