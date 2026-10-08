// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// 崩溃演练子进程 —— 被 fork 后执行动作「到一半」，然后自我 SIGKILL。
//
// 它模拟的是 B 类副作用故障最真实的形态：
//   副作用已经发给外部系统，但结果还没拿回来，进程就死了。
//   SIGKILL 不给任何 flush / cleanup / finally 的机会 —— 这是最严苛的存活验证。
//
// 父进程（side-effect-guard-crash.test.js）随后从同一个目录重新读账本，
// 验证两件事：
//   ① 执行前留下的 proposed 痕迹在猝死下仍然活着（appendFileSync 同步写撑住了）
//   ② 事后对账给出 manual，而不是 retry（没有终态就不许自动重做）

const { ActionAudit } = require('../../lib/action-audit');
const { SessionStore } = require('../../lib/session-store');
const { SideEffectGuard } = require('../../lib/side-effect-guard');

const dir = process.env.CRASH_DIR;
const key = process.env.CRASH_KEY;
const sessionId = process.env.CRASH_SESSION || 'crash-s1';

const audit = new ActionAudit({ dir, enabled: true });
const store = new SessionStore({ dir });
const guard = new SideEffectGuard({ audit, store, enabled: true });

store.create({ sessionId, proxy: 'codex', task: { type: 'coding', prompt: 'crash demo' } });

// ① 执行前查证 —— 放行，并记一条 proposed 留痕
const verdict = guard.beforeAction({
    toolName: 'edit',
    idempotencyKey: key,
    actor: 'crash-demo',
    resource: { file: 'a.txt' },
    sessionId,
});

// ② step 落盘（带幂等键）—— 验证 session-store 的原子写在猝死下也不丢
store.addStep(sessionId, {
    step: 1, tool: 'edit', input: 'a.txt', status: 'pending', idempotencyKey: key,
});

if (!verdict.proceed) {
    // 前置就没放行，说明链路本身有问题 —— 用退出码 2 告知父进程，别误判成崩溃成功
    process.stdout.write(JSON.stringify({ proceed: false, reason: verdict.reason }));
    process.exit(2);
}

// ③ 副作用已发出、结果未知 —— 此刻进程被杀死，来不及记任何终态
process.kill(process.pid, 'SIGKILL');
