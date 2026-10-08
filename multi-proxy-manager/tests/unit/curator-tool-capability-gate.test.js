// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// jest test for Curator tool-capability-gate policy
// 放到 multi-proxy-manager 的 tests/unit 下，因为 manager 的 jest testMatch 只覆盖本目录；
// curator 没有独立 test runner，policy 测试统一归这里跑（与 session-store 同包）。
const mod = require('../../../packs/curator/policies/tool-capability-gate');
const { handler, params } = mod;

describe('tool-capability-gate (Curator onToolOutput)', () => {
    const ctx = (toolName, rawOutput) => ({ toolName, rawOutput });

    afterEach(() => {
        params.mode = 'pass';
        params.denyTools = '';
        params.allowTools = '';
    });

    test('default pass mode is passthrough', () => {
        const r = handler(ctx('edit', 'some output'));
        expect(r.rawOutput).toBe('some output');
        expect(r.blocked).toBeUndefined();
        expect(r.reason).toBe('off');
    });

    test('deny mode blocks listed tool', () => {
        params.mode = 'deny';
        params.denyTools = 'edit,delete';
        const r = handler(ctx('edit', 'some output'));
        expect(r.blocked).toBe(true);
        expect(r.rawOutput).toContain('未授权');
        expect(r.reason).toBe('blocked:deny');
    });

    test('deny mode allows non-listed tool', () => {
        params.mode = 'deny';
        params.denyTools = 'delete';
        const r = handler(ctx('edit', 'ok'));
        expect(r.blocked).toBeUndefined();
        expect(r.rawOutput).toBe('ok');
        expect(r.reason).toBe('allowed');
    });

    test('allow mode blocks non-listed tool', () => {
        params.mode = 'allow';
        params.allowTools = 'read,search';
        const r = handler(ctx('edit', 'some output'));
        expect(r.blocked).toBe(true);
        expect(r.reason).toBe('blocked:allow');
    });

    test('allow mode allows listed tool', () => {
        params.mode = 'allow';
        params.allowTools = 'edit,read';
        const r = handler(ctx('edit', 'some output'));
        expect(r.blocked).toBeUndefined();
        expect(r.rawOutput).toBe('some output');
    });

    test('no toolName does not block', () => {
        params.mode = 'deny';
        params.denyTools = 'edit';
        const r = handler(ctx('', 'x'));
        expect(r.blocked).toBeUndefined();
        expect(r.reason).toBe('no-tool-name');
    });

    test('malformed empty deny list does not block', () => {
        params.mode = 'deny';
        params.denyTools = '  ,  ';
        const r = handler(ctx('edit', 'x'));
        expect(r.blocked).toBeUndefined();
        expect(r.reason).toBe('allowed');
    });

    // 铁律④：env 未设时绝不能意外开启门控。env 在模块加载时读取，
    // 故用 resetModules + 重新 require 来验证「干净环境下的默认值」。
    test('env unset leaves gate off (non-invasive default)', () => {
        jest.resetModules();
        delete process.env.CURATOR_TOOL_GATE_MODE;
        delete process.env.CURATOR_TOOL_GATE_DENY;
        delete process.env.CURATOR_TOOL_GATE_ALLOW;
        const fresh = require('../../../packs/curator/policies/tool-capability-gate');
        expect(fresh.params.mode).toBe('pass');
        const r = fresh.handler({ toolName: 'edit', rawOutput: 'x' });
        expect(r.blocked).toBeUndefined();
        expect(r.reason).toBe('off');
    });

    test('env sets mode and deny list at module load', () => {
        jest.resetModules();
        process.env.CURATOR_TOOL_GATE_MODE = 'deny';
        process.env.CURATOR_TOOL_GATE_DENY = 'edit,delete';
        const fresh = require('../../../packs/curator/policies/tool-capability-gate');
        expect(fresh.params.mode).toBe('deny');
        const r = fresh.handler({ toolName: 'edit', rawOutput: 'x' });
        expect(r.blocked).toBe(true);
        delete process.env.CURATOR_TOOL_GATE_MODE;
        delete process.env.CURATOR_TOOL_GATE_DENY;
    });
});
