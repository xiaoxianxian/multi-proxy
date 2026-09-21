#!/usr/bin/env node
'use strict';

// hermetic 假 tmux — 纯 node 实现 TmuxKeepalive 用到的 tmux 子命令语义，
// 让 session-keepalive / tmux-keepalive / p3d-crash-recovery 单测与系统 tmux daemon 解耦，
// 根治「多 worker 并发踩同一 tmux daemon + 单一 state 文件跨 worker 串味」的 flaky。
//
// 关键设计（实证过的两点）：
//   1) jest worker 内【运行时改的 process.env 不传给 spawn 子进程】，故 state 路径不靠 env 注入；
//   2) 但 `JEST_WORKER_ID` 是 jest 注入的【OS 级 env，能传给 spawn 子进程，且 worker 内稳定唯一】
//      （实测：parallel 与 --runInBand 下 test/child 均读到 WID=1，spawn 出来的 fake 子进程也读到）。
//   → 故 state 用 `fakemux-wid-<JEST_WORKER_ID>-state.json` 做 per-worker 隔离：
//     不同 worker 不同文件，互不串味；同一 worker 内各用例共享该文件，靠测试侧 beforeEach 清。
// 真 tmux（3.7c 已装）仍由各 suite 的可用性探测 + 注入不存在命令降级两类用例覆盖。
//
// 用法：作为可执行 binary 被 spawn 调用，argv 对齐真实 tmux 子集：
//   fake-tmux -V | new-session -d -s <name> -c <cwd> | has-session -t <name>
//   fake-tmux kill-session -t <name> | list-sessions -F <fmt>   (fmt 仅认 #{session_name})

const fs = require('fs');
const os = require('os');
const path = require('path');

// per-worker 隔离的 state 文件。WID 缺省则用 '0'（实测两种模式 WID 都在，缺省极少触发）。
// 外部可覆盖：FAKETMUX_STATE（手动/e2e 传入单个 state 路径，优先级最高）。
const WID = process.env.JEST_WORKER_ID || '0';
const STATE = process.env.FAKETMUX_STATE || path.join(os.tmpdir(), 'fakemux-wid-' + WID + '-state.json');

function load() {
    try {
        const o = JSON.parse(fs.readFileSync(STATE, 'utf8'));
        return Array.isArray(o.sessions) ? o.sessions : [];
     } catch {
        return [];
     }
}
function save(sessions) {
    fs.writeFileSync(STATE, JSON.stringify({ sessions }, null, 2));
}

const argv = process.argv.slice(2);
const cmd = argv[0];

// 取 -s / -t 后的值
const valAfter = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
};

switch (cmd) {
    case '-V':
        console.log('tmux-3.6b (fake)');
        process.exit(0);
    case 'new-session': {
        const name = valAfter('-s');
        const cwd = valAfter('-c') || process.cwd();
        let sessions = load();
        if (!sessions.find((s) => s.name === name)) {
            sessions.push({ name, cwd });
            save(sessions);
         }
        process.exit(0);           // 幂等：已存在也成功（调用方 start 前先 isLive 判活）
     }
    case 'has-session': {
        const name = valAfter('-t');
        process.exit(load().some((s) => s.name === name) ? 0 : 1);
     }
    case 'kill-session': {
        const name = valAfter('-t');
        const sessions = load();
        const before = sessions.length;
        const next = sessions.filter((s) => s.name !== name);
        save(next);
        process.exit(next.length === before ? 1 : 0);     // 不存在 → 1（对齐真 tmux）
     }
    case 'list-sessions': {
        const sessions = load();
        if (!sessions.length) {
            process.stderr.write('no server running\n');
            process.exit(1);            // 对齐真 tmux：空 server 退出非 0
         }
        console.log(sessions.map((s) => s.name).join('\n'));
        process.exit(0);
     }
    default:
        process.stderr.write(`fake-tmux: unsupported command '${cmd}'\n`);
        process.exit(2);
}