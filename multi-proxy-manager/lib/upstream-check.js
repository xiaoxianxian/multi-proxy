// multi-proxy — Copyright © 2026 xiaoxian (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
// This file is part of the multi-proxy project.

'use strict';

// lib/upstream-check.js · 上游横向体检（2026-10-04 补，外部对照 75 号 §三-①）
//
// 抄的是 ThinkWatch-Lite 的「upstream check-up」判据（MIT / ThinkWatchProject/ThinkWatch-Lite，
// 2026-10-04 核证）—— 它比单纯看单个上游好坏多一双眼睛：**把同模型的上游横着比**。
// 判据三条：
//   1 model-name-lie   上游报回来的模型名 ≠ 请求/期望的那个（中转偷换模型）
//   2 input-deviation  同模型下 prompt 明显偏离同行（虚报输入烧钱 / 少报塞不下）
//   3 cache-low        同模型下 cache 读率明显低于同行（上游不认我们的 cache_control）
// 每条都带**样本量**才报（n < minSamples 不报 —— 一个样本不算偏离，报出来是噪声）。
//
// 落点：cost-track 的 applyTokens（唯一落账出口）⇒ 体检与账同源，
// 调价/改口径只改一处。🔴 读回历史账本时（_loading）**不许喂样本**，
// 否则每次重启都会把历史账全算一遍偏离（跟账本翻倍是同一个坑）。
//
// 门控：PROXY_UPSTREAM_CHECK=1/true/on 才记样本；关时纯内存，不落盘。

const WINDOW = 50;          // 每个上游保留的最近样本数
const DEFAULTS = { minSamples: 3, ratio: 3, cacheRatio: 0.5 };

function enabled() {
  const v = String(process.env.PROXY_UPSTREAM_CHECK ?? '').trim().toLowerCase();
  // v1 提级（T7，2026-10-06 维护者拍 A）：默认开；显式 0/false/off 关（可回滚）。
  // 体检纯内存、不打真实流量（落点 applyTokens 出口），默认开是观察态，无副作用放大。
  if (v === '0' || v === 'false' || v === 'off') return false;
  return true;
}

// _samples[model][upstream] = [{prompt, cacheHit, reported, ts}]
const _samples = {};

function bucket(model, upstream) {
  const m = _samples[model] || (_samples[model] = {});
  return m[upstream] || (m[upstream] = []);
}

function push(model, upstream, s) {
  const arr = bucket(model, upstream);
  arr.push(s);
  if (arr.length > WINDOW) arr.splice(0, arr.length - WINDOW);
}

/**
 * 喂一次样本（门控关 ⇒ 什么都不做，零开销）。
 * @param {{model:string, upstream:string, prompt:number, cacheHit?:number, reported?:string}} s
 *   model     = 期望/声明的模型（同模型分组用这个，别用 upstream）
 *   upstream  = 实际走的那个上游
 *   reported  = 上游报回来的模型名（判据 1 用；不传就跳过判据 1）
 */
function sample(s) {
  if (!enabled()) return;
  if (!s || typeof s.model !== 'string' || !s.model) return;
  if (typeof s.upstream !== 'string' || !s.upstream) return;
  if (typeof s.prompt !== 'number' || !isFinite(s.prompt) || s.prompt < 0) return;
  push(s.model, s.upstream, {
    prompt: s.prompt,
    cacheHit: typeof s.cacheHit === 'number' && isFinite(s.cacheHit) ? s.cacheHit : 0,
    reported: typeof s.reported === 'string' && s.reported ? s.reported : null,
    ts: Date.now(),
  });
}

function median(nums) {
  if (!nums.length) return null;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 横向体检。**纯函数**：不记状态，只读 _samples 出结论。
 * @returns {Array<{type:string, model:string, upstream:string, detail:string, peers:number, n:number}>}
 */
function anomalies(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!enabled()) return [];
  const out = [];

  for (const model of Object.keys(_samples)) {
    const byUp = _samples[model];
    for (const up of Object.keys(byUp)) {
      const arr = byUp[up];
      const n = arr.length;
      if (n < o.minSamples) continue;   // 样本不够不报 —— 报出来是噪声

      // 判据 1：模型名说谎（任一样本 reported ≠ model 就报）
      const lied = arr.filter((x) => x.reported && x.reported !== model);
      if (lied.length) {
        out.push({
          type: 'model-name-lie', model, upstream: up, n: n, peers: 0,
          detail: `reported ${lied.length}/${n} 次不等于期望模型（例：${lied[0].reported}）`,
        });
      }

      // 判据 2/3 需要同行基线（≥2 个上游才算「同行」）
      const ups = Object.keys(byUp).filter((u) => u !== up && byUp[u].length >= o.minSamples);
      if (ups.length === 0) continue;

      const peersPrompt = [].concat(...ups.map((u) => byUp[u].map((x) => x.prompt)));
      const medPrompt = median(peersPrompt);

      const myPrompt = median(arr.map((x) => x.prompt));
      if (medPrompt != null && myPrompt != null && myPrompt > 0) {
        const k = myPrompt / medPrompt;
        if (k >= o.ratio) {
          out.push({
            type: 'input-deviation-high', model, upstream: up, n: n, peers: ups.length,
            detail: `prompt 中位 ${myPrompt} ≈ 同行的 ${k.toFixed(1)}×（同行 ${medPrompt}，阈值 ${o.ratio}×）`,
          });
        } else if (k > 0 && k <= 1 / o.ratio) {
          out.push({
            type: 'input-deviation-low', model, upstream: up, n: n, peers: ups.length,
            detail: `prompt 中位 ${myPrompt} ≈ 同行的 1/${(1 / k).toFixed(1)}（同行 ${medPrompt}）`,
          });
        }
      }

      // 判据 3：cache 读率低（用占 prompt 的比例比绝对值，避开大请求天然高）
      const myRate = median(arr.map((x) => (x.prompt > 0 ? x.cacheHit / x.prompt : null)));
      const peerRates = [].concat(...ups.map((u) => byUp[u].map((x) => (x.prompt > 0 ? x.cacheHit / x.prompt : null))));
      const medRate = median(peerRates.filter((r) => r != null));
      // 🔴 myRate===0 是**最该报**的情形（上游根本不认 cache_control），
      // 别被「myRate>0」这种自作聪明的守卫挡掉 —— 那会让判据 3 在最该响的时候沉默。
      if (myRate != null && medRate != null && medRate > 0 && (myRate === 0 || myRate / medRate < o.cacheRatio)) {
        out.push({
          type: 'cache-low', model, upstream: up, n: n, peers: ups.length,
          detail: `cache 读率 ${(myRate * 100).toFixed(1)}% ≈ 同行的 ${(myRate / medRate * 100).toFixed(0)}%（同行 ${(medRate * 100).toFixed(1)}%）`,
        });
      }
    }
  }
  return out;
}

// 给测试用：清样本（生产不会调）
function _reset() { for (const k of Object.keys(_samples)) delete _samples[k]; }

module.exports = { enabled, sample, anomalies, _reset };
