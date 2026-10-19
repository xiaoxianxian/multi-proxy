// free-llm · 自检（E2E）：健康 + /v1/models 是否含 seed 的 free 模型 + 有 key 就真跑一次 chat
// 跑法：node free-llm/test/test-e2e.mjs
// 未填 key 也能跑（只测健康 + 列表）；chat/429 真跑需要 .env 里有对应 key。
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const HERE = new URL('..', import.meta.url).pathname;
const PORT = process.env.FREE_LL_PORT || '18799';
const BASE = `http://127.0.0.1:${PORT}`;
const seed = JSON.parse(readFileSync(new URL('../providers.seed.json', import.meta.url), 'utf8'));
const ids = seed.flatMap(p => p.models.map(m => m.id));

// 若 .env 有 key 就加载进 env（供 chat 真跑）
if (existsSync(HERE + '.env')) {
  for (const line of readFileSync(HERE + '.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

let failed = 0;
const ok = (c, msg) => { console.log((c ? '✓ ' : '✗ ') + msg); if (!c) failed++; };

async function j(path, o) {
  const r = await fetch(BASE + path, o);
  let body = null; try { body = await r.json(); } catch (_) {}
  return { status: r.status, body };
}

// 1) 健康
let h = await j('/health').catch(() => ({ status: 0 }));
ok(h.status === 200 && h.body?.status === 'healthy', `/health ${h.status} ${h.body?.status || '(18799 未起？跑 install.sh)'}`);

// 2) /v1/models 是否含 seed 的 free 模型 id（装了才有；没 install = 基线，不判失败）
const m = await j('/v1/models').catch(() => ({ status: 0, body: null }));
const listed = m.body?.data?.map(x => x.id) || [];
const missing = ids.filter(id => !listed.includes(id));
ok(missing.length === 0, `/v1/models 含全部 ${ids.length} 个 free 模型`);
if (missing.length) console.log('  · 缺失（未 install 或 18799 未起）:', missing.join(', '));

// 3) 有 key 才真跑一次 chat（证明 key 走管道通）——逐家
for (const p of seed) {
  const env = p.provider_id === 'openrouter' ? process.env.OPENROUTER_FREE_KEY
    : p.provider_id === 'groq' ? process.env.GROQ_FREE_KEY
    : process.env.SILICONFLOW_FREE_KEY;
  if (!env || /^__FILL_/.test(env)) { console.log(`  · ${p.name}：无 key，chat 跳过`); continue; }
  const c = await j('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${env}` },
    body: JSON.stringify({ model: p.models[0].id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 }),
  }).catch(e => ({ status: 0, body: { error: e.message } }));
  ok(c.status === 200 && c.body?.choices?.length, `${p.name} chat → ${c.status}${c.status === 200 ? ' ' + (c.body?.choices?.[0]?.message?.content || '').trim().slice(0, 20) : ' ' + JSON.stringify(c.body?.error || c.body).slice(0, 120)}`);
}

// 4) 429 切换（需要某家真的到免费上限才会触发；这里只做「能观测到 fallback」的说明）
console.log('⚠ 429 自动切换：逻辑在 generic-openai-proxy/failover.js（有界 5 跳），真触发要等某家免费额度用尽；手动验证=把某家 key 的免费额度跑空后观察切下一家。');

console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
process.exit(failed ? 1 : 0);
