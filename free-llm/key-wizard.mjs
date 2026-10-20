#!/usr/bin/env node
// free-llm · key 录入向导（产品化）：领 key → 写 .env → 装进 18799 → 自检 → 状态报告
// 用法：
//   node key-wizard.mjs                       交互式：逐个提示粘贴（去哪个控制台领，链接都在向导里），回车跳过
//   OPENROUTER_FREE_KEY=.. GROQ_FREE_KEY=.. SILICONFLOW_FREE_KEY=.. node key-wizard.mjs
//                                              非交互：key 全走环境变量，不弹提问
// 安全：真实 key 只落在 ~/.multi-proxy-manager/.env（被 .gitignore），向导绝不打印完整 key。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

// 用 fileURLToPath 解码中文路径（new URL().pathname 会把「项目」百分号编码 → 路径不存在）
const HERE = fileURLToPath(new URL('.', import.meta.url));      // free-llm/ 目录
// 真实 key 统一落 ~/.multi-proxy-manager/.env（核心引擎 / install.sh / refresh-models.mjs 读同一份；被 gitignore）
const DATA_DIR = process.env.HOME + '/.multi-proxy-manager';
const ENV = DATA_DIR + '/.env';

const PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter·免费档', envVar: 'OPENROUTER_FREE_KEY',
    get: 'https://openrouter.ai/keys（注册后 Keys 页 "Create Key"）',
    note: '免费 key 直接调 :free 模型，$0，不充钱；有免费日额度上限，个别模型要验证邮箱' },
  { id: 'groq', name: 'Groq·免费档', envVar: 'GROQ_FREE_KEY',
    get: 'https://console.groq.com/keys（groq.com 注册后 "Create API Key"）',
    note: '免费速率限额、$0；部分地区未开放/会风控，以你本机（东京）实测为准' },
  { id: 'siliconflow', name: '硅基流动·免费档', envVar: 'SILICONFLOW_FREE_KEY',
    get: 'https://cloud.siliconflow.cn（注册领 key）',
    note: '本插件只用永久免费的 7B 档，$0、不扣赠金' },
  { id: 'vercel', name: 'Vercel AI Gateway·免费档', envVar: 'VERCEL_KEY',
    get: 'vercel.com 注册 → 取 AI Gateway / AI SDK key（api.vercel.ai/gateway）',
    note: '路由网关：填一个 key 就用背后整张模型清单；免费档 bytedance-exp-ling-3.1-free / deepseek-v4-flash-free 零费用' },
  { id: 'opencode', name: 'OpenCode Zen·免费档', envVar: 'OPENCODE_KEY',
    get: 'opencode.ai 注册 → 取账号 key（opencode.ai/zen/v1）',
    note: '路由网关：免费模型限时·零保留；按出口 IP 地域门槛，本机东京需实测' },
];

function loadEnvMap() {
  if (!existsSync(ENV)) return {};
  const m = {};
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const mm = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(line);
    if (mm) m[mm[1]] = mm[2].trim();
  }
  return m;
}
const mask = k => k ? (k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : '…') : '(无)';
const hasReal = v => !!v && !/^__/.test(v);

let envMap = loadEnvMap();
for (const p of PROVIDERS) {                       // 环境变量补齐 .env 里没有的
  if (!hasReal(envMap[p.envVar]) && hasReal(process.env[p.envVar])) envMap[p.envVar] = process.env[p.envVar];
}

const interactive = !!process.stdin.isTTY && process.argv.indexOf('--yes') === -1;
const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

console.log('== free-llm · key 录入向导 ==');
console.log('各家都是注册即免费、不充钱；填完即写 ~/.multi-proxy-manager/.env（绝不进 git）。中途没领到的直接回车跳过，日后再跑一次补上。\n');

for (const p of PROVIDERS) {
  const key = envMap[p.envVar];
  if (hasReal(key)) { console.log(`● ${p.name}：已就位 key ${mask(key)}`); continue; }
  if (!interactive) { console.log(`○ ${p.name}：非交互且无 key，跳过（保持占位）`); continue; }
  console.log(`→ ${p.name}\n   去哪领：${p.get}\n   ${p.note}\n`);
  const ans = (await rl.question('   粘贴 key（回车=跳过，保持占位）：')).trim();
  if (ans) { envMap[p.envVar] = ans; console.log(`   ✓ 已记录 ${p.envVar} = ${mask(ans)}`); }
  else console.log(`   · 已跳过 ${p.name}`);
}
if (rl) rl.close();

mkdirSync(process.env.HOME + '/.multi-proxy-manager', { recursive: true });
writeFileSync(ENV, [
   '# free-llm · 各家免费 key（本文件被 .gitignore，绝不进 git）',
   ...PROVIDERS.map(p => `${p.envVar}=${envMap[p.envVar] || ''}`),
   ''
].join('\n'));
console.log('\n✓ 已写入 ~/.multi-proxy-manager/.env');

console.log('\n== 安装/更新到 18799 ==');
spawnSync('bash', [HERE + 'install.sh'], { stdio: 'inherit' });

console.log('\n== 自检 ==');
spawnSync('node', [HERE + 'test/test-e2e.mjs'], { stdio: 'inherit' });

console.log('\n== 各家状态 ==');
for (const p of PROVIDERS) {
  const k = envMap[p.envVar];
  console.log((hasReal(k) ? '●' : '○') + ' ' + p.name + (hasReal(k) ? '（key 已就位，chat 可实测）' : '（占位·待填 key）'));
}
console.log('\n完成后，开 Hermes 聊天 / 调 /v1/chat/completions 即自动在各家间 429 兜底切换。');
