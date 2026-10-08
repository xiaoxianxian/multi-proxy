// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';
// cache-k-estimator 单测：k 自测的判据与边界
//
// 三件必须钉死的事：
//   1. 换挡样本能估出 k=0 / k=1 两端（公式对）
//   2. 没有断点后退（稳定样本）时不硬造数，返回 null（不编数纪律）
//   3. suggestMode 的判据 k* = d/(1−d) 在 DeepSeek(d=0.1) 下给出 mid、在 k 大时给 suffix

const fs = require('fs');
const os = require('os');
const path = require('path');
const KE = require('../../../tools/cache-k-estimator.js');

describe('cache-k-estimator', () => {
  test('kStar = d/(1−d)：DeepSeek d=0.1 得 0.1111，OpenAI 档 d=0.25 得 0.3333', () => {
    expect(KE.kStar(0.1)).toBeCloseTo(1 / 9, 5);
    expect(KE.kStar(0.25)).toBeCloseTo(1 / 3, 5);
  });

  test('suggestMode：k 小 → mid（多赚），k 大 → suffix（防后退）', () => {
    expect(KE.suggestMode(0, 0.1)).toBe('mid');
    expect(KE.suggestMode(0.1, 0.1)).toBe('mid');
    expect(KE.suggestMode(KE.kStar(0.1), 0.1)).toBe('suffix'); // 边界含等号
    expect(KE.suggestMode(KE.kStar(0.1) - 0.001, 0.1)).toBe('mid');
    expect(KE.suggestMode(1, 0.1)).toBe('suffix');
    expect(KE.suggestMode(NaN, 0.1)).toBe('mid'); // 未标定按最赚那档（53 号实测）
  });

  // 合成一组能手算的换挡样本：上轮全发(saved=0)，本轮裁掉退回段 5174 且新增正文 300。
  //   total: 31086 → 31086+300−5174 = 26212；miss(k=0): 238+300 = 538
  test('换挡样本 Δmiss=Δmsg ⇒ k=0（退回段仍按命中价）', () => {
    const prev = { prompt: 31086, hit: 30748, miss: 238, breakpoint: 5174, saved: 0 };
    const cur = { prompt: 26212, hit: 25674, miss: 538, breakpoint: 0, saved: 5174 };
    // Δregress=5174；Δmsg=Δtotal+Δsaved=(26212−31086)+5174=300；Δmiss=538−238=300 ⇒ residual=0
    const e = KE.observe(cur, prev);
    expect(e.samples).toBe(1);
    expect(e.residual).toBeCloseTo(0, 6);
    expect(e.k).toBe(0);
    expect(e.mode).toBe('mid');
    expect(e.reason).toBe('shape-switch');
  });

  test('换挡样本 Δmiss=Δmsg+Δregress ⇒ k=1（退回段整段按未命中价）', () => {
    const prev = { prompt: 31086, hit: 30848, miss: 238, breakpoint: 5174, saved: 0 };
    const cur = { prompt: 26212, hit: 20100, miss: 5712, breakpoint: 0, saved: 5174 };
    // Δmiss=5712−238=5474；Δmsg=300 ⇒ residual=5174=Δregress ⇒ k=1
    const e = KE.observe(cur, prev);
    expect(e.k).toBeCloseTo(1, 6);
    expect(e.mode).toBe('suffix');
  });

  test('稳定样本（Δregress=0）不估 k，只回 sanity 残差', () => {
    const prev = { prompt: 27704, hit: 27136, miss: 568, breakpoint: 900, saved: 5174 };
    const cur = { prompt: 27836, hit: 27648, miss: 588, breakpoint: 900, saved: 5174 };
    const e = KE.observe(cur, prev);
    expect(e.k).toBeNull();
    expect(e.reason).toBe('no-regress');
    expect(e.residual).toBeCloseTo((588 - 568) - (27836 - 27704), 6);
  });

  test('首样本 / 缺字段不估 k（宁可估不出，也不许拿 0 当真值）', () => {
    expect(KE.observe({ prompt: 100, miss: 10, breakpoint: 0, saved: 50 }, null).k).toBeNull();
    expect(KE.observe({ prompt: 100, miss: 10 }, { prompt: 90, miss: 9 }).k).toBeNull();
    expect(KE.observe({ prompt: 100, miss: 10, breakpoint: 0, saved: 50 }, { prompt: 90, miss: 9 }).k).toBeNull();
  });

  // 真流量踩到的坑：断点变了 ≠ 我们裁剪了。请求形状自己变（换 tools 集）也会让
  // breakpoint 变，那时若照算就会产出 k̂=1 这种荒谬样本，把 auto 推到 suffix。
  test('两边都没裁剪（saved=0）时，断点变小不算换挡样本', () => {
    const e = KE.observe(
      { prompt: 2019, miss: 2019, breakpoint: 1264, saved: 0 },
      { prompt: 2618, miss: 2618, breakpoint: 1764, saved: 0 },
    );
    expect(e.reason).toBe('no-regress');
    expect(e.k).toBeNull();
  });

  test('本轮真裁剪（saved>0）时，断点后退才算换挡样本', () => {
    const e = KE.observe(
      { prompt: 1101, miss: 333, hit: 768, breakpoint: 254, saved: 1010 },
      { prompt: 2019, miss: 2019, breakpoint: 1264, saved: 0 },
    );
    expect(e.reason).toBe('shape-switch');
    expect(e.k).toBe(0); // residual 负 → 钳到 0（与 55 号真机标定一致）
  });

  test('🔴 冷态轮不产样本：round ≤ 2 一律 cold-start（57 号流式命中延迟一轮）', () => {
    // 前两轮的 miss 差异里混着「上游首次建缓存」的一次性成本，做差会把 k̂ 往小里带
    // （⇒ auto 选 mid，偏激进）。实测：长前缀 646 tok 时 t1/t2 的 hit=0、t3 才 hit=512。
    const t1 = { prompt: 31092, miss: 244, breakpoint: 6095, saved: 0, round: 1 };
    const t2 = { prompt: 31092, miss: 244, breakpoint: 6095, saved: 0, round: 2 };
    const t3 = { prompt: 31092, miss: 244, breakpoint: 6095, saved: 0, round: 3 };
    expect(KE.observe(t2, t1).reason).toBe('cold-start');
    expect(KE.observe(t2, t1).k).toBeNull();
    // 第 3 轮起算，且必须真的能估出数（用 round=3/4 的换挡样本）
    const e = KE.observe({ prompt: 27710, miss: 190, breakpoint: 284, saved: 5174, round: 4 },
                         { prompt: 31092, miss: 244, breakpoint: 6095, saved: 0, round: 3 });
    expect(e.reason).toBe('shape-switch');
    expect(e.round).toBe(4);
    expect(e.k).toBe(0); // residual 负 → 钳 0，与 55 号真机标定一致
  });

  test('无 round 信息的调用不受冷态影响（合成样本 / 离线复现仍可估）', () => {
    const e = KE.observe(
      { prompt: 27710, miss: 190, breakpoint: 284, saved: 5174 },
      { prompt: 31092, miss: 244, breakpoint: 6095, saved: 0 },
    );
    expect(e.reason).toBe('shape-switch');
    expect(e.round).toBeNull();
  });

  test('上一轮裁过、本轮没裁（断点变回去）→ 不产生样本', () => {
    const e = KE.observe(
      { prompt: 2202, miss: 282, breakpoint: 1264, saved: 0 },
      { prompt: 1101, miss: 333, breakpoint: 254, saved: 1010 },
    );
    expect(e.reason).toBe('no-regress');
    expect(e.k).toBeNull();
  });

  test('write/read 往返：k 与 mode 落盘后能被 policy 读到', () => {
    const store = path.join(os.tmpdir(), 'mp-est-store', 'cache-estimate.json');
    fs.rmSync(path.dirname(store), { recursive: true, force: true });
    expect(KE.read(store)).toBeNull();
    KE.write({ k: 0.02, samples: 1, residual: -12, mode: 'mid', reason: 'shape-switch' }, store);
    const back = KE.read(store);
    expect(back.k).toBe(0.02);
    expect(back.mode).toBe('mid');
    expect(back.source).toBe('measured');
    expect(back.kStar).toBeCloseTo(1 / 9, 5);
    fs.rmSync(path.dirname(store), { recursive: true, force: true });
  });
});
