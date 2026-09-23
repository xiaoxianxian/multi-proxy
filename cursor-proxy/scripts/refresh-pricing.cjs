// scripts/refresh-pricing.cjs — Q1 P2 · L0→L2 价缓存刷新（架构 §3.1，2026-09-22）
//
// 定位：刷新脚本（非热路径，§3.5.1 方案 C 允许它碰网络）。产出 L2 价缓存
//（pricing-cache.json）供路由引擎 / runtime 读，热路径零网络。
//
// 铁律（老板 2026-09-22 + ⑧ 架构评审）：
//   - 官方渠道（L0）用 seed 价，**绝不产假网络价**（§3.7 三级兜底 D3 绝不静默）。
//   - 汇率从 PROXY_FX_RATE env 取（非侵入、非网络）；缺失 → 7.2 缓存兜底（D2）。
//   - 网络渠道（openrouter 等）默认**关**（PROXY_REFRESH_NETWORK=on 才尝试）；
//     开但无 API key → 报告"需要 key"，**不产假价**（诚实边界，§3.9.1 同理）。
//   - 刷新失败不阻塞（try/catch，进程 exit 0），路由引擎仍用旧 cache（§3.7 不假死）。
//   - 不写 agent 文件、不注入全局 env、不碰热路径（AGENTS.md 非侵入铁律）。
//
// 单一源码说明：下方 OFFICIAL_PRICING / FX_SEED / CHANNELS 与
//   cursor-proxy/src/pricing/seed.ts 同源同一套值。二者一致性由
//   tests/unit/pricing-cache-drift.test.ts 的「三向同步锁」断言保护（routeEngine
//   内联价 ≡ seed.ts ≡ 本脚本），任何一边漂移测试即红——这是防 F1 复发（脱节）的机制。
//   （refresh 脚本是 CJS 运维进程，无法 import ESM 的 seed.ts，故内联同值；
//    若需改官方价，三处同步改 + 跑测试。）
//
// 用法（.cjs，因 cursor-proxy package.json "type":"module"）：
//   cd cursor-proxy
//   node scripts/refresh-pricing.cjs                       # 官方渠道刷新（默认，不拉网络）
//   node scripts/refresh-pricing.cjs --out /tmp/pc.json    # 指定缓存输出路径
//   PROXY_FX_RATE=7.2 node scripts/refresh-pricing.cjs      # 指定汇率（否则用缓存兜底 7.2）
//   PROXY_REFRESH_NETWORK=on node scripts/refresh-pricing.cjs  # 尝试网络渠道（需各 API key）
'use strict';
const path = require('path');
const fs = require('fs');

// ---- L0 官方价种子（与 src/pricing/seed.ts OFFICIAL_PRICING 同源，测试锁一致）----
const OFFICIAL_PRICING = {
  'deepseek-v4-pro': { input: 0.5, output: 3, cacheHit: 0.02, currency: 'CNY', source: 'official-deepseek', _userSet: false, updatedAt: '2025' },
  'deepseek-flash': { input: 0.2, output: 1.6, cacheHit: 0.02, currency: 'CNY', source: 'official-deepseek', _userSet: false, updatedAt: '2025' },
  'kimi-k2.6': { input: 6.5, output: 27, cacheHit: 0.02, currency: 'CNY', source: 'official-kimi', _userSet: false, updatedAt: '2026-09' },
  'kimi-k3': { input: 6.5, output: 27, cacheHit: 0.02, currency: 'CNY', source: 'official-kimi', _userSet: false, updatedAt: '2026-09' },
  'agnes-2.5-flash': { input: 0, output: 0, cacheHit: 0, currency: 'CNY', source: 'official-agnes', _userSet: false, updatedAt: '2026-09' },
  'qwen3.8:27b-mlx': { input: 0, output: 0, cacheHit: 0, currency: 'CNY', source: 'local-qwen', _userSet: false, updatedAt: '2026-09' },
  'gpt-5.6-codex': { input: 12.5, output: 37.5, currency: 'USD', source: 'official-openai', _userSet: false, subscriptionId: 'openai-pro' },
  'claude-opus-4.7': { input: 15, output: 75, currency: 'USD', source: 'official-anthropic', _userSet: false, subscriptionId: 'anthropic-pro' },
};
const FX_SEED = { base: 'CNY', rates: { USD: 7.2 }, source: 'seed-fallback', updatedAt: '2026-09-22' };
const CHANNELS = [
  { id: 'official-openai', provider: 'gpt-5.6-codex', reliability: 1.0, official: true },
  { id: 'official-anthropic', provider: 'claude-opus-4.7', reliability: 1.0, official: true },
  { id: 'official-deepseek', provider: 'deepseek', reliability: 1.0, official: true },
  { id: 'official-kimi', provider: 'kimi', reliability: 1.0, official: true },
  { id: 'official-agnes', provider: 'agnes', reliability: 1.0, official: true },
  { id: 'local-qwen', provider: 'qwen', reliability: 1.0, official: true },
  { id: 'openrouter', provider: 'aggregator', reliability: 0.8, official: false },
];

const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  // 仅认 --out <path>；其余忽略（脚本非热路径，参数简单）。
  const out = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : undefined;
  return { out };
}

// 网络渠道刷新钩子（默认关；开启但无 key → 不产假，只报告）。
// 诚实边界：当前不实现真拉取（待各 provider API key 接入），避免产假价（§3.7 D3 / §3.9.1）。
function fetchNetworkChannel(channel, key) {
  if (!key) return null; // 无 key → 不产假
  // 预留：接入 OpenRouter / OpenAI 等价格 API。当前不拉取（key 未配置）。
  return null;
}

function buildL2() {
  // L2 = 官方价（权威）+ channel 标注（§3.4 多渠道比价）。
  // 每条带 model/channel/currency/source/_userSet/updatedAt，供 P1 resolvePricing L2 层匹配。
  const byModel = {};
  for (const [model, p] of Object.entries(OFFICIAL_PRICING)) {
    const ch = CHANNELS.find((c) => c.source === p.source || c.provider === p.source.replace('official-', ''));
    if (!byModel[model]) byModel[model] = [];
    byModel[model].push({
      ...p,
      model,
      channel: ch ? ch.id : p.source,
      updatedAt: nowIso(),
    });
  }
  return byModel;
}

// 简单漂移 diff（refresh 脚本自包含版；routeEngine 侧用 src/routing/priceDrift.ts 的 detectDrift）。
// 比对旧 cache vs 新 L0，产单价/汇率变动 + modelAdded/Removed 报告。
function diffDrift(oldByModel, newByModel) {
  const items = [];
  const models = new Set([...Object.keys(oldByModel), ...Object.keys(newByModel)]);
  for (const model of models) {
    const old = oldByModel[model];
    const next = newByModel[model];
    if (!old) items.push({ model, added: true });
   else if (!next) items.push({ model, removed: true });
   else {
    // 比 official 渠道条目价
    const oldP = old.find((e) => e._userSet !== true) || old[0];
    const newP = next.find((e) => e._userSet !== true) || next[0];
    const inPct = oldP.input ? (newP.input - oldP.input) / oldP.input : 0;
    const outPct = oldP.output ? (newP.output - oldP.output) / oldP.output : 0;
    const changed = Math.abs(inPct) > 0.1 || Math.abs(outPct) > 0.1;
    if (changed) {
      items.push({
        model,
        input: `${oldP.input}→${newP.input}`,
        output: `${oldP.output}→${newP.output}`,
        inputPct: +inPct.toFixed(4),
        outPct: +outPct.toFixed(4),
      });
     }
    }
   }
  return items;
}

function loadOld(outPath) {
  try {
    if (fs.existsSync(outPath)) return JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch { /* 旧 cache 损坏 → 当无旧，不阻塞（§3.7 不假死）*/ }
  return null;
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const outPath = out || path.join(__dirname, '..', 'data', 'pricing-cache.json');

  // 1) 汇率（非侵入：从 PROXY_FX_RATE env 取；缺失 → 7.2 缓存兜底，D2 绝不混算）
  const envFx = Number(process.env.PROXY_FX_RATE);
  const fxRate = (isFinite(envFx) && envFx > 0) ? envFx : FX_SEED.rates.USD;
  const fxSource = isFinite(envFx) && envFx > 0 ? 'env-PROXY_FX_RATE' : 'seed-fallback(7.2)';

  // 2) L2 价（官方 seed 权威；network 渠道默认关，不产假）
  const l2 = buildL2();

  // 3) network 渠道（默认关）
  const networkOn = ['on', 'true', '1', 'enable', 'enabled'].includes(
    String(process.env.PROXY_REFRESH_NETWORK ?? '').trim().toLowerCase());
  const netReport = [];
  if (networkOn) {
    for (const ch of CHANNELS.filter((c) => !c.official)) {
      const key = process.env[`API_KEY_${ch.id.toUpperCase().replace(/[^A-Z0-9]/g, '')}`];
      const price = fetchNetworkChannel(ch, key);
      if (price) netReport.push({ channel: ch.id, price });
      else netReport.push({ channel: ch.id, skipped: key ? 'hook-not-wired' : 'no-api-key' });
     }
   }

  // 4) 漂移检测（旧 cache vs 新）
  const oldCache = loadOld(outPath);
  const oldByModel = oldCache ? oldCache.l2 : {};
  const drift = diffDrift(oldByModel, l2);
  const driftReport = {
    fxDelta: oldCache?.fx ? (fxRate - oldCache.fx) / oldCache.fx : 0,
    priceDrift: drift,
    netReport,
    timestamp: nowIso(),
    notifyEnabled: ['on', 'true', '1'].includes(String(process.env.PROXY_PRICE_DRIFT_NOTIFY ?? '').trim().toLowerCase()),
    // 人类可读（§3.10 可读性：不甩乱码，说清下一步）
    humanReadable: [
      fxRate,
      (fxSource),
      drift.length ? `${drift.length} 个模型价变动（见 priceDrift）` : '无单价变动',
   ],
  };

  // 5) 写 L2 缓存（失败不阻塞）
  const payload = {
    fx: fxRate,
    fxSource,
    l2,
    channels: CHANNELS,
    networkReport: netReport,
    drift: driftReport,
    generatedAt: nowIso(),
   ttl: '24h（路由引擎读 cache，热路径零网络；本脚本 24h 一跑）',
   };

  let writeOk = true;
  let writeErr = null;
  try {
   if (!out || out.startsWith('.')) { ensureDirs(outPath); }
   fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
   } catch (e) {
    writeOk = false;
    writeErr = (e && e.message) || String(e);
    }

  // 6) 结果 + exit 0（失败不阻塞路由，§3.7 绝不假死）
  console.log(`[refresh-pricing] L2=${Object.keys(l2).length} 模型, fx=${fxRate}(${fxSource}), 网络=${networkOn ? '开' : '关(不产假)'}`);
  if (drift.length) console.log(`[refresh-pricing] 漂移 ${drift.length}: ${drift.map((d) => d.model + (d.input || (d.added ? ' 新增' : d.removed ? ' 移除' : ''))).join(', ')}`);
  if (netReport.length) console.log(`[refresh-pricing] 网络渠道: ${netReport.map((n) => n.channel + '(' + (n.price ? 'ok' : n.skipped) + ')').join(', ')}`);
  console.log(writeOk ? `[refresh-pricing] L2 缓存已写: ${outPath}` : `[refresh-pricing] L2 缓存写入失败（不阻塞路由）: ${writeErr}`);
  return 0;
}

function ensureDirs(p) {
  const dir = path.dirname(p);
   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

if (require.main === module) {
  try {
    process.exit(main());
   } catch (e) {
   console.error(`[refresh-pricing] 未预期异常（不阻塞路由）: ${(e && e.stack) || e}`);
    process.exit(0); // 失败不阻塞
    }
  }

module.exports = { OFFICIAL_PRICING, FX_SEED, CHANNELS, buildL2, diffDrift, main, parseArgs };
