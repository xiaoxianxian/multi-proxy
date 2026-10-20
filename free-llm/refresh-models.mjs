#!/usr/bin/env node
// free-llm · refresh-models.mjs — 动态刷新各家 provider 的模型清单（add-only）
// 对应老板②「接各家路由厂商的全量模型列表、吃里面的免费」的「动态」半边：
//   对每个 provider，GET {base_url}/models（OpenAI 兼容），把上游里、models 里还没有的 model id
//   补进 models（只增不删、不写死、不把上游 key 写进缓存/日志，与 multi-proxy model-sync 同纪律）。
//   - 列表公开免鉴权的（OpenRouter / Vercel / OpenCode 的 /models）：现在就能刷，不用 key。
//   - 需 key 的（Groq / SiliconFlow / OpenCode 调用）：从 .env 或 live 里已有的 key 读取（仅内存，不落盘不打印）。
//   - 拉取失败（401/403/超时/无 key）：跳过该家、保留旧清单，绝不报错中断。
// 用法：
//   node refresh-models.mjs            # 刷新 live providers.json 里全部带 base_url 的 provider
//   node refresh-models.mjs openrouter # 只刷指定（按 id 或 provider_id 匹配）
import fs from 'node:fs';

const LIVE = process.env.HOME + '/.multi-proxy-manager/providers.json';

// 极简 .env 读取（不依赖 dotenv；真实 .env 被 .gitignore，不进 git）
function loadEnv() {
  const out = {};
  // 唯一 key 主源：~/.multi-proxy-manager/.env（install.sh 也从这读；真实 .env 被 .gitignore，不进 git）
  const files = [process.env.HOME + '/.multi-proxy-manager/.env'];
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (m && !line.trimStart().startsWith('#')) out[m[1]] = m[2];
      }
    } catch {}
  }
  for (const [k, v] of Object.entries(process.env)) if (!(k in out) || v === '') out[k] = v;
  return out;
}
const ENV = loadEnv();

const KEY_ENV = {
  openrouter: 'OPENROUTER_FREE_KEY', groq: 'GROQ_FREE_KEY', siliconflow: 'SILICONFLOW_FREE_KEY',
  vercel: 'VERCEL_KEY', opencode: 'OPENCODE_KEY',
};
function keyFor(p) {
  const pid = p.provider_id || (p.id || '').replace(/^free-llm-/, '');
  const ek = KEY_ENV[pid] ? (ENV[KEY_ENV[pid]] || '') : '';
  if (ek && !/^__FILL_/.test(ek) && ek.length >= 8) return ek;          // .env 里有真 key
  const lk = p.api_key || '';
  if (lk && !/^__FILL_/.test(lk) && lk.length >= 8) return lk;          // live 里已有真 key（只用内存）
  return '';                                                            // 无 key：公开列表照常刷，需 key 的上游会 401 被跳过
}

const FREE_RE = /(^|[-:/.])(:free|-free|free$)|(^free[-.]|free[-.]free)/i;
const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
const want = process.argv.slice(2);
let changed = 0;

for (const p of live) {
  if (!p.base_url || !/^https?:/.test(p.base_url)) continue;
  if (want.length && !want.some((w) => p.id === w || p.provider_id === w)) continue;
  const key = keyFor(p);
  const url = p.base_url.replace(/\/+$/, '') + '/models';
  let ids;
  try {
    const r = await fetch(url, { headers: key ? { Authorization: 'Bearer ' + key } : {}, signal: AbortSignal.timeout(20000) });
    if (!r.ok) {
      console.log(`  · ${p.id}: 上游 HTTP ${r.status}（${key ? 'key 无效/无权限' : '免鉴权也失败'}）→ 跳过，保留旧清单`);
      continue;
    }
    const j = await r.json();
    ids = j?.data?.map((m) => m.id) || j?.models?.map((m) => m.id) || (Array.isArray(j) ? j.map((m) => m.id || m.model) : []);
  } catch (e) {
    console.log(`  · ${p.id}: 拉取失败（${e.message}）→ 保留旧清单`);
    continue;
  }
  const have = new Set((p.models || []).map((m) => m.id));
  let add = 0;
  for (const id of ids) {
    if (!id || have.has(id)) continue;
    p.models = p.models || [];
    p.models.push({ id, name: id, type: 'cloud', pricing: { input: 0, output: 0 }, is_free: FREE_RE.test(id) });
    have.add(id); add++;
  }
  if (add > 0) {
    p._modelsSyncedAt = new Date().toISOString().slice(0, 16);
    changed += add;
    console.log(`  + ${p.id}: 新增 ${add} 个上游模型（现共 ${p.models.length}）`);
  } else {
    console.log(`  = ${p.id}: 清单已与上游一致（${p.models?.length || 0} 个）`);
  }
}

if (changed > 0) {
  // 原子写：先写同目录 .tmp，再 rename 原子替换——避免与正在读文件的 18799 撞上半截 JSON（无人值守更安全）
  const tmp = LIVE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(live, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, LIVE);
  console.log(`完成：共补入 ${changed} 个模型，已原子写回 live providers.json（权限 0600，key 未落盘/未打印）`);
} else {
  console.log('完成：无新增（各清单已与上游一致，或目标均跳过）');
}
