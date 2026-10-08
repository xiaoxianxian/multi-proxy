// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const RH = require('../../../l2/run-history/run-history.js');

const tmpFile = () => path.join(os.tmpdir(), `run-history-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);

describe('G5 run-history', () => {
    test('门控关时 append 直接 no-op', () => {
        const f = tmpFile();
        const rh = RH.createRunHistory({ enabled: false, logFile: f });
        expect(rh.append({ type: 'x' })).toEqual({ written: false, reason: 'gate-closed' });
        expect(fs.existsSync(f)).toBe(false);
        fs.existsSync(f) && fs.unlinkSync(f);
    });

    test('门控开时落盘 + query 读回', () => {
        const f = tmpFile();
        const rh = RH.createRunHistory({ enabled: true, logFile: f });
        rh.append({ type: 'cost-record', level: 'ok', cumulative: 0.096 });
        rh.append({ type: 'block', cumulative: 0.21 });
        expect(fs.existsSync(f)).toBe(true);
        const all = rh.query();
        expect(all).toHaveLength(2);
        expect(all[0].type).toBe('cost-record');
        fs.unlinkSync(f);
    });

    test('query 按 type 过滤', () => {
        const f = tmpFile();
        const rh = RH.createRunHistory({ enabled: true, logFile: f });
        rh.append({ type: 'a' });
        rh.append({ type: 'b' });
        rh.append({ type: 'a' });
        expect(rh.query({ type: 'a' })).toHaveLength(2);
        expect(rh.query({ type: 'b' })).toHaveLength(1);
        fs.unlinkSync(f);
    });

    test('跨实例（重启）读回同一文件', () => {
        const f = tmpFile();
        const rh1 = RH.createRunHistory({ enabled: true, logFile: f });
        rh1.append({ type: 'x', v: 1 });
        const rh2 = RH.createRunHistory({ enabled: true, logFile: f }); // 模拟重启
        const rows = rh2.query();
        expect(rows).toHaveLength(1);
        expect(rows[0].v).toBe(1);
        fs.unlinkSync(f);
    });

    test('query limit 取末尾 N 条', () => {
        const f = tmpFile();
        const rh = RH.createRunHistory({ enabled: true, logFile: f });
        for (let i = 0; i < 5; i++) rh.append({ type: 't', i });
        expect(rh.query({ limit: 2 })).toHaveLength(2);
        fs.unlinkSync(f);
    });

    test('文件不存在时 query 返回空数组', () => {
        const rh = RH.createRunHistory({ enabled: true, logFile: tmpFile() });
        expect(rh.query()).toEqual([]);
    });
});
