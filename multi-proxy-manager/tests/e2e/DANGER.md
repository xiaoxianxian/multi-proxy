# ⚠️ DANGER — 勿直接 `npx playwright test tests/e2e`

`tests/e2e/*.test.ts`（6 文件 ≈165 用例，AGENTS.md 口径「独立矩阵，jest 不跑，沿历史快照」）
**未经隔离直接在本机跑有生产级风险**。任何人/agent 跑这套之前先读本文件。

## 三个硬风险

1. **端口=生产**：6 个 .ts 各自硬编 `BASE_URL = 'http://localhost:18792'`（非 env 注入）。
   `18792` 是 `multi-proxy-manager` 生产端口。直接跑=对生产实例做断言 + 操作。

2. **会改写真实登录凭据（不可逆）**：`helpers.ts` 的 `login()` 先 `rm -f ~/.multi-proxy-password`
   （本机此文件不存在=空操作，无害），但 setup 流程会把 `TestPass123!` 写进**真实数据目录**
   `~/.multi-proxy-manager/password`（现为 60 字节、10-05 的真实登录凭据）。
   **直接跑 = 覆盖真登录态，不可逆。**

3. **假设 setup 态 + 可能已 stale**：全矩阵假设「无密码=setup 模式」，生产已有 auth →
   断言行为不符；且矩阵为历史快照、未纳入当前测试门，可能因 10-06/10-07 的接口改动已 stale。

## 安全跑法（前置条件，缺一不可）

- 隔离 HOME：auth 存储 + `rm` 目标必须落在**一次性目录**，绝不碰真实 `~/.multi-proxy-manager`。
- 非生产端口：如 `18801`（`MP_CONSENT_BYPASS=1` 旁路同意门），不碰 `18792`。
- `BASE_URL` 改成 env 注入（`process.env.BASE_URL || '...'`），6 个 .ts 一并去硬编。
- 每套件 fresh auth 态（独立数据目录）。

## 当前处置（2026-10-16 hermes 评估）

- **本 v1.0 收口不跑该矩阵**：它是独立快照、非当前 gate，且缺上述隔离脚手架。
- 转独立任务：先搭隔离 harness（env/HOME/port），再决定是否跑；跑前 `rm` 真实 `password` 之前必备份。
- 已用真浏览器 smoke（`e2e/smoke.spec.js` + `e2e/index-redirect.spec.js`，系统 Chrome、测试服 18801）覆盖
  7 壳页 + index redirect 的「加载不崩」口径，**与本矩阵解耦**。

> 教训：本机 e2e 测试服须用一次性数据目录（`HOME=临时` 或 server.js 的 data-dir 注入），
> 避免对真实 `~/.multi-proxy-manager/*`（`password` / `cost-ledger.jsonl` 等）产生副作用。
