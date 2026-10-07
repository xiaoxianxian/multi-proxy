'use strict';

// jest test for ActionAudit（外部动作审计）
const fs = require('fs');
const { ActionAudit, ACTION_RESULTS } = require('../../lib/action-audit');

describe('ActionAudit', () => {
    let tmpDir;
    let audit;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync('/tmp/action-audit-test-');
        audit = new ActionAudit({ dir: tmpDir, enabled: true });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('disabled by default does not write', () => {
        const off = new ActionAudit({ dir: tmpDir }); // enabled 未传且无 env
        expect(off.enabled).toBe(false);
        expect(off.record({ action: 'x' })).toBeNull();
        expect(fs.existsSync(off.file)).toBe(false);
    });

    test('records an action and persists it', () => {
        const e = audit.record({
            actor: 'agent:coding-1',
            action: 'update:order.delivery_date',
            resource: 'order:12345@v7',
            idempotencyKey: 'edit:order12345:v7',
            result: 'accepted',
            sourceOfTruth: 'gateway-receipt',
        });
        expect(e.result).toBe('accepted');
        expect(e.ts).toBeTruthy();
        expect(audit.count()).toBe(1);
    });

    test('unknown is a valid result and queryable', () => {
        audit.record({ action: 'refund', idempotencyKey: 'k1', result: 'unknown' });
        audit.record({ action: 'notify', idempotencyKey: 'k2', result: 'completed' });
        const unknown = audit.queryUnknown();
        expect(unknown).toHaveLength(1);
        expect(unknown[0].idempotencyKey).toBe('k1');
    });

    test('invalid result falls back to unknown (fail-safe)', () => {
        const e = audit.record({ action: 'x', result: 'totally-bogus' });
        expect(e.result).toBe('unknown');
        expect(ACTION_RESULTS).toContain('unknown');
    });

    test('queryByIdempotencyKey returns history for reconciliation', () => {
        audit.record({ action: 'update', idempotencyKey: 'k1', result: 'proposed' });
        audit.record({ action: 'update', idempotencyKey: 'k1', result: 'accepted' });
        audit.record({ action: 'update', idempotencyKey: 'k1', result: 'completed' });
        const h = audit.queryByIdempotencyKey('k1');
        expect(h).toHaveLength(3);
        expect(h.map((x) => x.result)).toEqual(['proposed', 'accepted', 'completed']);
        expect(audit.queryByIdempotencyKey('missing')).toEqual([]);
    });

    test('queryByResource answers how many times it was changed', () => {
        audit.record({ action: 'a', resource: 'order:1@v1', result: 'completed' });
        audit.record({ action: 'b', resource: 'order:1@v2', result: 'unknown' });
        audit.record({ action: 'c', resource: 'order:2@v1', result: 'completed' });
        expect(audit.queryByResource('order:1@v1')).toHaveLength(1);
        expect(audit.queryByResource('order:1@v2')).toHaveLength(1);
        expect(audit.queryByResource('nope')).toEqual([]);
    });

    test('records survive re-instantiation (persisted, not in-memory only)', () => {
        audit.record({ action: 'x', idempotencyKey: 'persist-1', result: 'completed' });
        const audit2 = new ActionAudit({ dir: tmpDir, enabled: true });
        expect(audit2.queryByIdempotencyKey('persist-1')).toHaveLength(1);
        expect(audit2.count()).toBe(1);
    });

    test('corrupted log line does not break queries', () => {
        fs.appendFileSync(audit.file, 'not-json-at-all\n{"action":"ok","idempotencyKey":"k9","result":"completed"}\n');
        expect(audit.count()).toBe(1);
        expect(audit.queryByIdempotencyKey('k9')).toHaveLength(1);
    });

    // 🔴 以下一组是 2026-10-07 真实 SIGKILL 演练发现的 bug 的回归测试：
    //    queryUnknown() 只筛 result==='unknown'，会漏掉崩溃留下的 proposed 孤儿
    //    （进程在执行前记了 proposed 就被杀死，没有终态，result 是 'proposed'）。
    //    待对账队列必须用 queryUnresolved()，不能用 queryUnknown()。

    test('queryUnresolved: proposed 孤儿算未终结（queryUnknown 会漏掉它）', () => {
        audit.record({ action: 'edit', idempotencyKey: 'orphan', result: 'proposed' });
        // 这就是那个 bug：严格筛 unknown 查不到
        expect(audit.queryUnknown()).toHaveLength(0);
        // 未终结查询必须查得到
        const unresolved = audit.queryUnresolved();
        expect(unresolved).toHaveLength(1);
        expect(unresolved[0].idempotencyKey).toBe('orphan');
    });

    test('queryUnresolved: accepted / unknown 算未终结，completed / failed 不算', () => {
        audit.record({ idempotencyKey: 'a1', result: 'accepted' });
        audit.record({ idempotencyKey: 'u1', result: 'unknown' });
        audit.record({ idempotencyKey: 'c1', result: 'completed' });
        audit.record({ idempotencyKey: 'f1', result: 'failed' });

        const keys = audit.queryUnresolved().map((e) => e.idempotencyKey).sort();
        expect(keys).toEqual(['a1', 'u1']);
    });

    test('queryUnresolved: 同一 key 取最后一条，终态覆盖未终结', () => {
        audit.record({ idempotencyKey: 'k', result: 'proposed' });
        expect(audit.queryUnresolved()).toHaveLength(1);

        audit.record({ idempotencyKey: 'k', result: 'completed' });
        expect(audit.queryUnresolved()).toHaveLength(0);

        // 反过来：完成后又记一条 unknown（对账推翻），重新进待办
        audit.record({ idempotencyKey: 'k', result: 'unknown' });
        expect(audit.queryUnresolved()).toHaveLength(1);
    });

    test('queryUnresolved: 无幂等键的条目不进待办（没有 key 无法对账）', () => {
        audit.record({ action: 'edit', result: 'unknown' });
        expect(audit.queryUnknown()).toHaveLength(1);
        expect(audit.queryUnresolved()).toHaveLength(0);
    });
});
