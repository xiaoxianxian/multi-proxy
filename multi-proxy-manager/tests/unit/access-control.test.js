// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
const AC = require('../../../l2/access-control/access-control.js');

// G6 权限分档（l2/access-control/access-control.js）
// 三档直接复用 DBX MCP：read_only / safe_write / high_risk_write；默认最严（fail-safe）。
describe('access-control G6 权限分档 (l2/access-control/access-control.js)', () => {
  test('默认：未声明调用方 + 未知操作 → 拒绝（fail-safe 最严）', () => {
    const ac = AC.createAccessControl();
    const r = ac.guard('db.write', { caller: 'anonymous' });
    expect(r.allowed).toBe(false);
    expect(r.tier).toBe('read_only');
    expect(r.category).toBe('high_risk_write');
  });

  test('read_only 档：read 放行，safe_write / high_risk_write 拒绝', () => {
    const ac = AC.createAccessControl({ config: { callerTiers: { bob: 'read_only' } } });
    expect(ac.guard('chat.completions', { caller: 'bob' }).allowed).toBe(true);
    expect(ac.guard('thread.create', { caller: 'bob' }).allowed).toBe(false);
    expect(ac.guard('db.write', { caller: 'bob' }).allowed).toBe(false);
  });

  test('safe_write 档：read + safe_write 放行，high_risk_write 拒绝', () => {
    const ac = AC.createAccessControl({ config: { callerTiers: { claude: 'safe_write' } } });
    expect(ac.guard('chat.completions', { caller: 'claude' }).allowed).toBe(true);
    expect(ac.guard('thread.create', { caller: 'claude' }).allowed).toBe(true);
    expect(ac.guard('db.write', { caller: 'claude' }).allowed).toBe(false);
  });

  test('high_risk_write 档：三档全放行', () => {
    const ac = AC.createAccessControl({ config: { callerTiers: { admin: 'high_risk_write' } } });
    expect(ac.guard('chat.completions', { caller: 'admin' }).allowed).toBe(true);
    expect(ac.guard('thread.create', { caller: 'admin' }).allowed).toBe(true);
    expect(ac.guard('db.write', { caller: 'admin' }).allowed).toBe(true);
  });

  test('cc-switch 默认 read_only：过只读流量，不可写成本库', () => {
    const ac = AC.createAccessControl(); // 不传 callerTiers，用 DEFAULT_CALLER_TIERS
    expect(ac.guard('chat.completions', { caller: 'cc-switch' }).allowed).toBe(true);
    expect(ac.guard('savings.record', { caller: 'cc-switch' }).allowed).toBe(false);
  });

  test('env 覆盖：PROXY_ACCESS_CALLER_TIERS 与 PROXY_ACCESS_DEFAULT_TIER 生效', () => {
    process.env.PROXY_ACCESS_CALLER_TIERS = '{"x":"high_risk_write"}';
    process.env.PROXY_ACCESS_DEFAULT_TIER = 'safe_write';
    const ac = AC.createAccessControl();
    expect(ac.guard('db.write', { caller: 'x' }).allowed).toBe(true);   // env 提档
    expect(ac.guard('thread.create', { caller: 'anon' }).allowed).toBe(true); // 默认 safe_write
    delete process.env.PROXY_ACCESS_CALLER_TIERS;
    delete process.env.PROXY_ACCESS_DEFAULT_TIER;
  });

  test('门控关（disabled）→ guard 一律放行，接入热路径零行为变更', () => {
    process.env.PROXY_ACCESS_DISABLED = '1';
    const ac = AC.createAccessControl();
    expect(ac.guard('db.write', { caller: 'cc-switch' }).allowed).toBe(true);
    expect(ac.report().disabled).toBe(true);
    delete process.env.PROXY_ACCESS_DISABLED;
  });

  test('guardAll：批量预检，返回首个被拒项', () => {
    const ac = AC.createAccessControl({ config: { callerTiers: { claude: 'safe_write' } } });
    const blocked = ac.guardAll(['chat.completions', 'thread.create', 'db.write'], { caller: 'claude' });
    expect(blocked).not.toBeNull();
    expect(blocked.operation).toBe('db.write');
    const ok = ac.guardAll(['chat.completions', 'thread.create'], { caller: 'claude' });
    expect(ok).toBeNull();
  });
});
