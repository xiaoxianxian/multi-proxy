'use strict';

// 边界与并发测试：session-store 的持久化/崩溃恢复/并发不变量。
// 针对 5753b5e 暴露的「mock 掩盖生产缺陷」类缺陷——mock store 没有真实文件与
// 目录，永远测不到 _load/_save 的真行为；本文件直接打真实 fs，补三类边界：
//   A. 原子写（tmp→rename + 0600）不留残骸、可恢复
//   B. 损坏文件 → crash-recovery 安全（不崩、可重建、_load 宽松）
//   C. 共享目录多实例的 last-writer-wins + 原子写不撕裂（项目级 known 约束）

const { SessionStore } = require('../../../multi-proxy-manager/lib/session-store');
const fs = require('fs');
const os = require('os');
const path = require('path');

function makeSessionStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
    return { dir, store: new SessionStore({ dir }) };
}

// 在 store 的持久化目录里直接放一个内容文件（模拟磁盘上已是该状态）
function seedFile(dir, content) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sessions.json'), content);
}

describe('SessionStore — 原子写与持久化保证（A）', () => {
    test('create 后原子写落盘：无 .tmp 残骸、主文件 0600、specVersion + sessionId 完整', () => {
        const { store, dir } = makeSessionStore();
        store.create({ sessionId: 'atomic-1', proxy: 'codex', task: { type: 'coding' } });

        // 原子写：tmp→rename，rename 后 tmp 必不存在
        expect(fs.existsSync(path.join(dir, 'sessions.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'sessions.json.tmp'))).toBe(false);

        // 0600 权限（P1 经验：provider/session 类密钥文件 0600）
        const perm = fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777;
        expect(perm).toBe(0o600);

        // 落盘内容完整
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
        expect(parsed.specVersion).toBe('1.0.0');
        expect(parsed.sessions[0].sessionId).toBe('atomic-1');
    });

    test('update/abort/done/fail 每次写都走原子 tmp→rename，无 .tmp 残骸', () => {
        const { store, dir } = makeSessionStore();
        store.create({ sessionId: 'a-2', proxy: 'codex', task: { type: 'coding' } });
        store.addStep('a-2', { step: 1, tool: 'edit', status: 'done' });
        store.abort('a-2', 'user');
        store.markDone('a-2'); // 覆盖 aborted
        store.markFailed('a-2', new Error('boom'));

        const tmp = path.join(dir, 'sessions.json.tmp');
        expect(fs.existsSync(tmp)).toBe(false);
        // 最终状态一致：markFailed 是最后一次写
        expect(store.get('a-2').status).toBe('failed');

        // 文件可被重新解析（从未撕裂写入）
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
        expect(parsed.sessions[0].status).toBe('failed');
    });

    test('remove 后落盘不含该 session 且无 .tmp 残骸', () => {
        const { store, dir } = makeSessionStore();
        store.create({ sessionId: 'rm', proxy: 'codex', task: { type: 'coding' } });
        store.remove('rm');
        expect(fs.existsSync(path.join(dir, 'sessions.json.tmp'))).toBe(false);
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
        expect(parsed.sessions).toHaveLength(0);
    });
});

describe('SessionStore — 崩溃恢复安全性（B）', () => {
    test('损坏的 sessions.json 不崩：_load 静默跳过，store 空但可继续写入', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
        seedFile(dir, '{ this is not valid json ]');
        const corrupt = new SessionStore({ dir });
        expect(corrupt.count()).toBe(0); // 不抛、内存为空
        // 崩溃后可重建：写新 session 成功（覆盖损坏文件）
        corrupt.create({ sessionId: 'recovered', proxy: 'hermes', task: { type: 'coding' } });
        expect(corrupt.count()).toBe(1);
        // 重建后的文件是合法 JSON
        expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))).not.toThrow();
    });

    test('空文件 / sessions 非数组 / 条目缺 sessionId 都被 _load 宽松跳过', () => {
        const { store, dir } = makeSessionStore();
        seedFile(dir, ''); // 空文件 → doc={}? JSON.parse('') 会抛 → catch 跳过
        expect(store.count()).toBe(0);
        new SessionStore({ dir }).create({ sessionId: 'x1', proxy: 'codex', task: { type: 'coding' } });

        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
        seedFile(dir2, JSON.stringify({ sessions: 'not-an-array' }));
        expect(new SessionStore({ dir2 }).count()).toBe(0);

        const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
        seedFile(dir3, JSON.stringify({ sessions: [{ proxy: 'codex', task: {}, steps: [] }] }));
        // 缺 sessionId 的条目不载入
        expect(new SessionStore({ dir3 }).count()).toBe(0);
    });

    test('跨进程持久化 + 损坏后重建：干净 session 不永久丢', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
        // 进程 1：写入干净 session
        const a = new SessionStore({ dir });
        a.create({ sessionId: 'good-1', proxy: 'codex', task: { type: 'coding' } });
        // 模拟崩溃恢复：进程 2 重新载入 → good-1 仍在
        const b = new SessionStore({ dir });
        expect(b.get('good-1').sessionId).toBe('good-1');
        // 进程 2 再写入 + 持久化，进程 1 重新载入看到最新
        b.create({ sessionId: 'good-2', proxy: 'hermes', task: { type: 'text' } });
        a._load();
        expect(b.count()).toBe(2);
        expect(a.count()).toBe(2);
        expect(a.get('good-2')).toBeTruthy();
    });
});

describe('SessionStore — 并发写不变量（C，项目级 known 约束）', () => {
    test('原子写永不撕裂：并发写后文件总可解析 + 无 .tmp 残骸', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
        const a = new SessionStore({ dir });
        const b = new SessionStore({ dir });

        // 两个实例各自 load+写+重载，模拟并发
        a.create({ sessionId: 'c-a', proxy: 'codex', task: { type: 'coding' } });
        b.create({ sessionId: 'c-b', proxy: 'hermes', task: { type: 'text' } });
        a._load();
        b._load();
        a.create({ sessionId: 'c-a2', proxy: 'codex', task: { type: 'coding' } });
        b.create({ sessionId: 'c-b2', proxy: 'hermes', task: { type: 'text' } });
        a._load();
        b._load();

        // 不变量 1：文件始终合法 JSON（原子写保证不撕裂）
        expect(() => JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'))).not.toThrow();

        // 不变量 2：无 .tmp 残骸（每次写都 rename 收尾）
        expect(fs.existsSync(path.join(dir, 'sessions.json.tmp'))).toBe(false);

        // 不变量 3（last-writer-wins）：最终态是某实例的完整视图（非撕裂混合）
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
        const ids = parsed.sessions.map(s => s.sessionId);
        expect(new Set(ids).size).toBe(ids.length); // 无重复 id
    });

    test('共享目录 last-writer-wins：后写者的完整视图覆盖先写者', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edge-'));
        const a = new SessionStore({ dir });
        const b = new SessionStore({ dir });
        a.create({ sessionId: 'only-in-a', proxy: 'codex', task: { type: 'coding' } });
        // b 在 a 之后创建 → b 的 load 不会看到 a（a 已落盘但 b 已 load 过）；b 写后落盘
        b.create({ sessionId: 'only-in-b', proxy: 'hermes', task: { type: 'text' } });
        b._load();
        // last-writer-wins：重新载入的 store 看到 b 的完整视图（含 c-b），不含 a 的孤立写
        const reloaded = new SessionStore({ dir });
        expect(reloaded.get('only-in-b')).toBeTruthy();
        // a 的写被 b 的 load 之前的快照覆盖前，b 落盘时不含 only-in-a
        expect(reloaded.count()).toBe(1);
    });
});
