// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

/**
 * l2/egress-ledger.js 单元测试（node:test，零第三方依赖）。
 *
 * 覆盖：
 *   1. gateOpen：默认关；1/true/on 开；0/false/off 关（非侵入铁律）。
 *   2. byteSizeOf：string 按 UTF-8 真实字节；Buffer 按 length；对象给 approximated=true；
 *      拿不到 → { bytes: null }（不猜、不填 0）。
 *   3. extractOutbound：destHost 优先、回落 upstreamHost、都没有 → null；tokens 兼容
 *      tokens / totalTokens 两个字段名；bytes 缺失 → bytesFound=false。
 *   4. classify：oversize / unknown-host / ratio 三条判据各自独立生效。
 *   5. classify 诚实分支：tokens 缺失或为 0 → ratio=null 且 tokensMissing 照实标记，
 *      **不空手算比值**（这是本模块最容易被写错的一处）。
 *   6. summarize：bytesFound / bytesMissing 分开计数；perHost / perClient 聚合正确；
 *      anomalous 收集命中行。
 *   7. 工厂隔离 + 环形缓冲上限。
 *
 * 跑法：node --test l2/tests/egress-ledger.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const E = require('../egress-ledger.js');

test('1. gateOpen 默认关，显式值才开', () => {
    const saved = process.env[E.GATE_ENV];
    try {
        delete process.env[E.GATE_ENV];
        assert.strictEqual(E.gateOpen(), false, '未设置时必须关');
        for (const on of ['1', 'true', 'on']) {
            process.env[E.GATE_ENV] = on;
            assert.strictEqual(E.gateOpen(), true, `${on} 必须开`);
        }
        for (const off of ['0', 'false', 'off']) {
            process.env[E.GATE_ENV] = off;
            assert.strictEqual(E.gateOpen(), false, `${off} 必须关`);
        }
    } finally {
        if (saved === undefined) delete process.env[E.GATE_ENV];
        else process.env[E.GATE_ENV] = saved;
    }
});

test('2. byteSizeOf 真实字节，拿不到给 null', () => {
    assert.strictEqual(E.byteSizeOf({ body: 'abcd' }).bytes, 4);
    // 中文一个字符 3 字节：测的就是「按字节算而不是按字符数」
    assert.strictEqual(E.byteSizeOf({ body: '中文' }).bytes, 6);
    assert.strictEqual(E.byteSizeOf({ body: Buffer.from([1, 2, 3]) }).bytes, 3);
    assert.strictEqual(E.byteSizeOf({ bytes: 999 }).bytes, 999);

    const obj = E.byteSizeOf({ body: { a: 1 } });
    assert.strictEqual(obj.approximated, true, '对象必须标 approximated');
    assert.ok(obj.bytes > 0);

    assert.strictEqual(E.byteSizeOf({}).bytes, null, '没有 body/bytes 必须给 null');
    assert.strictEqual(E.byteSizeOf(null).bytes, null);
});

test('3. extractOutbound 的字段回落与缺失标记', () => {
    const byDest = E.extractOutbound({ destHost: 'api.example.com', tokens: 10 });
    assert.strictEqual(byDest.destHost, 'api.example.com');
    assert.strictEqual(byDest.tokens, 10);

    const byUpstream = E.extractOutbound({ upstreamHost: 'up.example.com' });
    assert.strictEqual(byUpstream.destHost, 'up.example.com', 'destHost 缺失应回落 upstreamHost');

    const none = E.extractOutbound({});
    assert.strictEqual(none.destHost, null);
    assert.strictEqual(none.bytesFound, false);
    assert.strictEqual(none.bytes, null, '拿不到字节必须 null，不是 0');

    const altToken = E.extractOutbound({ totalTokens: 7 });
    assert.strictEqual(altToken.tokens, 7, '应兼容 totalTokens 字段名');
});

test('4. classify 三条判据各自独立生效', () => {
    const known = ['api.openai.com', 'example.com'];

    const big = E.classify(
        { bytes: 60 * 1024 * 1024, destHost: 'api.openai.com', tokens: 100000 },
        { oversizeBytes: 50 * 1024 * 1024, knownHosts: known },
    );
    assert.ok(big.anomalies.includes('oversize'), '超 50MB 必须判 oversize');
    assert.ok(!big.anomalies.includes('unknown-host'), '已知 host 不应误报');

    const weird = E.classify(
        { bytes: 1024, destHost: 'bucket.aliyuncs.com', tokens: 100000 },
        { knownHosts: known },
    );
    assert.ok(weird.anomalies.includes('unknown-host'), '未知目的地必须判 unknown-host');

    // 推理 token 很小（100 tokens ≈ 400 字节当量）却出战 100MB → 比值失衡
    const lopsided = E.classify({ bytes: 100 * 1024 * 1024, tokens: 100 }, { knownHosts: null });
    assert.strictEqual(lopsided.expectedBytes, 400, 'expectedBytes = tokens × 4');
    assert.strictEqual(lopsided.ratio, lopsided.bytes / 400);
    assert.ok(lopsided.anomalies.includes('volume-token-ratio'));

    const normal = E.classify({ bytes: 2000, tokens: 500 }, { knownHosts: null });
    assert.deepStrictEqual(normal.anomalies, [], '正常量级不应误报');
});

test('5. classify 的诚实分支：分母拿不到时不算比值', () => {
    const noTokens = E.classify({ bytes: 1024 }, {});
    assert.strictEqual(noTokens.tokensMissing, true);
    assert.strictEqual(noTokens.ratio, null, '无 tokens 必须 null，不许拿 0 当分母');
    assert.ok(!noTokens.anomalies.includes('volume-token-ratio'));

    const zeroTokens = E.classify({ bytes: 1024, tokens: 0 }, {});
    assert.strictEqual(zeroTokens.ratio, null, 'tokens=0 同样不许算比值');

    const noBytes = E.classify({ tokens: 100 }, {});
    assert.strictEqual(noBytes.ratio, null, '无字节数也不许算比值');
});

test('6. summarize 分开记 bytesFound / bytesMissing 并聚合 host 与 client', () => {
    const rows = [
        { client: 'claude-code', destHost: 'api.openai.com', bytes: 1000, tokens: 250 },
        { client: 'claude-code', destHost: 'api.openai.com', bytes: 2000, tokens: 500 },
        { client: 'zcode', destHost: 'bucket.aliyuncs.com', bytes: null, tokens: 10 },
    ];
    const rep = E.summarize(rows, {});

    assert.strictEqual(rep.rowCount, 3);
    assert.strictEqual(rep.bytesFound, 2, '只有两条量到了字节');
    assert.strictEqual(rep.bytesMissing, 1, '缺字节的行必须单列，不许混进总量');
    assert.strictEqual(rep.totalBytes, 3000);

    assert.strictEqual(rep.perHost['api.openai.com'].count, 2);
    assert.strictEqual(rep.perHost['api.openai.com'].bytes, 3000);
    assert.strictEqual(rep.perHost['bucket.aliyuncs.com'].bytesMissing, 1);

    assert.strictEqual(rep.perClient['claude-code'].bytes, 3000);
    assert.strictEqual(rep.perClient['<unknown>'], undefined, '有 client 就不该落到 unknown');
});

test('7. 工厂实例互相隔离 + 环形缓冲遵守上限', () => {
    const a = E.createEgressLedger({ logCapacity: 3 });
    const b = E.createEgressLedger({ logCapacity: 3 });

    a.record({ destHost: 'h1', bytes: 1 });
    assert.strictEqual(a.size(), 1);
    assert.strictEqual(b.size(), 0, '两个工厂实例必须互不影响');

    for (let i = 0; i < 10; i++) a.record({ destHost: `h${i}`, bytes: i });
    assert.strictEqual(a.size(), 3, '容量上限应生效');

    const filtered = a.getRows({ destHost: 'h8' });
    assert.strictEqual(filtered.length, 1, '过滤应可用');
    assert.strictEqual(filtered[0].bytes, 8);
});
