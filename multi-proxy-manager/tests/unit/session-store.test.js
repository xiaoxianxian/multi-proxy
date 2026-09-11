'use strict';

// jest test for SessionStore
const { SessionStore } = require('../../../multi-proxy-manager/lib/session-store');
const fs = require('fs');
const path = require('path');

describe('SessionStore', () => {
    let store;
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync('/tmp/session-test-');
        store = new SessionStore({ dir: tmpDir });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('create session', () => {
        const s = store.create({
            sessionId: 'sess-001',
            proxy: 'codex',
            task: { type: 'coding', prompt: 'fix bug' },
        });
        expect(s.sessionId).toBe('sess-001');
        expect(s.status).toBe('running');
        expect(s.steps).toEqual([]);
    });

    test('auto-generates sessionId if missing', () => {
        const s = store.create({ proxy: 'hermes', task: { type: 'text', prompt: 'hi' } });
        expect(s.sessionId).toMatch(/^sess_/);
    });

    test('addStep', () => {
        const s = store.create({ sessionId: 's1', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        const updated = store.addStep('s1', { step: 1, tool: 'edit', input: 'file.txt', status: 'done', checkpoint: { file: 'file.txt' } });
        expect(updated.steps).toHaveLength(1);
        expect(updated.steps[0].tool).toBe('edit');
        expect(updated.steps[0].status).toBe('done');
    });

    test('abort session', () => {
        const s = store.create({ sessionId: 's2', proxy: 'cursor', task: { type: 'vision', prompt: 'x' } });
        const aborted = store.abort('s2', 'user');
        expect(aborted.status).toBe('aborted');
        expect(aborted.abortedBy).toBe('user');
    });

    test('markDone', () => {
        const s = store.create({ sessionId: 's3', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        const done = store.markDone('s3');
        expect(done.status).toBe('done');
    });

    test('markFailed', () => {
        const s = store.create({ sessionId: 's4', proxy: 'hermes', task: { type: 'text', prompt: 'x' } });
        const failed = store.markFailed('s4', new Error('timeout'));
        expect(failed.status).toBe('failed');
        expect(failed.error).toContain('timeout');
    });

    test('getRunning returns only running sessions', () => {
        store.create({ sessionId: 'r1', proxy: 'codex', task: { type: 'coding', prompt: 'a' } });
        store.create({ sessionId: 'r2', proxy: 'cursor', task: { type: 'vision', prompt: 'b' } });
        store.markDone('r1');
        const running = store.getRunning();
        expect(running).toHaveLength(1);
        expect(running[0].sessionId).toBe('r2');
    });

    test('list with filter', () => {
        store.create({ sessionId: 'l1', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        store.create({ sessionId: 'l2', proxy: 'hermes', task: { type: 'text', prompt: 'y' } });
        const codexSessions = store.list({ proxy: 'codex' });
        expect(codexSessions).toHaveLength(1);
        expect(codexSessions[0].sessionId).toBe('l1');
    });

    test('remove session', () => {
        store.create({ sessionId: 'rm1', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        store.remove('rm1');
        expect(store.count()).toBe(0);
        expect(() => store.get('rm1')).toThrow('not found');
    });

    test('persist across re-instantiation', () => {
        store.create({ sessionId: 'p1', proxy: 'codex', task: { type: 'coding', prompt: 'x' } });
        const store2 = new SessionStore({ dir: tmpDir });
        expect(store2.get('p1').sessionId).toBe('p1');
        expect(store2.count()).toBe(1);
    });

    test('validateSession rejects invalid', () => {
        expect(() => store.create({})).toThrow('invalid session');
        expect(() => store.create({ sessionId: 'bad', task: { type: 'coding', prompt: 'x' } })).toThrow('missing proxy');
    });
});
