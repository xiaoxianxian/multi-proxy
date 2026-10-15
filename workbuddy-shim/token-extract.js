// token-extract.js — 只读、透明的 WorkBuddy token 定位辅助（手动运行）
// Copyright © 2026 xiaoxian (Jason). Licensed under AGPL-3.0 (source).
//
// 它是「人肉取 token」的帮手，不是 shim 的一部分：
//   · shim 本身绝不读桌面端私有存储（server.js 红线 ①）；
//   · 本脚本是你**自己**在**自己**机器上手动跑的，用来定位存储文件、并给出最稳妥的
//     取 token 步骤。绝不静默破解磁盘加密 —— 那部分（AES-256-GCM unwrap）在不同版本的
//     桌面端里 at-rest 密钥派生会变，本会话没拿到可验证的 cred.ts 源码，所以不发不可验证的
//     解密代码。
//
// 用法：
//   node token-extract.js            # 列出 WorkBuddy 桌面端可能的存储位置 + 手动取 token 步骤
//   node token-extract.js --try-read <文件路径>   # 仅当该文件是明文 JSON 时，打印含 token 字样的键（值打码）
//
// 推荐取 token 方式（最稳、零风险）：
//   1. 打开 WorkBuddy 桌面端，登录态保持。
//   2. 任意位置按 Cmd+Shift+I 打开 DevTools → Network 面板。
//   3. 触发一次对话或刷新，找到任意发往 copilot.tencent.com 的请求。
//   4. 看 Request Headers 里的 `Authorization: Bearer xxxx` —— 那个 xxxx 就是 WORKBUDDY_ACCESS_TOKEN。
//   5. 把 xxxx 填进 shim 的 .env（WORKBUDDY_ACCESS_TOKEN=xxxx）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function mask(v) {
  const s = String(v);
  if (s.length <= 8) return '****';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// 桌面端可能的存储位置（macOS）。不同版本路径可能不同，这里只做"提示"不保证命中。
function candidateDirs() {
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Application Support', 'WorkBuddy'),
    path.join(home, 'Library', 'Application Support', 'CodeBuddy'),
    path.join(home, 'Library', 'Application Support', 'workbuddy'),
    path.join(home, '.config', 'WorkBuddy'),
    path.join(home, '.workbuddy'),
  ];
}

function locate() {
  const found = [];
  for (const dir of candidateDirs()) {
    if (!fs.existsSync(dir)) continue;
    // 找典型存储文件/目录
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const interesting = [];
    for (const e of entries) {
      const name = e.name.toLowerCase();
      if (name.includes('storage') || name.includes('local') || name.includes('cookie')
        || name.includes('session') || name.includes('auth') || name.includes('config')
        || name.includes('pref') || name.endsWith('.json') || name.endsWith('.ldb')
        || e.isDirectory()) {
        interesting.push(e.name);
      }
    }
    found.push({ dir, interesting });
  }
  return found;
}

function tryReadPlaintext(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (e) {
    return { ok: false, error: `读不到（可能加密或二进制）: ${e.message}` };
  }
  let json;
  try { json = JSON.parse(text); } catch {
    return { ok: false, error: '不是明文 JSON（大概率加密存储，本工具不解密）' };
  }
  const hits = [];
  const walk = (obj, prefix) => {
    if (typeof obj !== 'object' || obj === null) return;
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (/token|access|refresh|auth|session|cookie/i.test(k)) {
        hits.push({ key, value: typeof v === 'string' ? mask(v) : typeof v });
      }
      if (typeof v === 'object' && v !== null) walk(v, key);
    }
  };
  walk(json, '');
  return { ok: true, hits };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--try-read') {
    const p = args[1];
    if (!p) { console.error('用法: node token-extract.js --try-read <文件路径>'); process.exit(2); }
    console.log(`[token-extract] 尝试只读解析: ${p}`);
    const r = tryReadPlaintext(p);
    if (!r.ok) { console.log(`  结果: ${r.error}`); return; }
    if (r.hits.length === 0) { console.log('  未发现 token 类明文键（可能加密存储）'); return; }
    console.log('  发现以下键（值已打码）：');
    for (const h of r.hits) console.log(`   - ${h.key} = ${h.value}`);
    console.log('  复制对应值到 shim .env 的 WORKBUDDY_ACCESS_TOKEN（若是 access token）。');
    return;
  }

  console.log('[token-extract] WorkBuddy 桌面端可能的存储位置：');
  const found = locate();
  if (found.length === 0) {
    console.log('  没在常见位置找到 WorkBuddy/CodeBuddy 桌面端数据目录。');
  } else {
    for (const f of found) {
      console.log(`  • ${f.dir}`);
      for (const name of f.interesting.slice(0, 30)) console.log(`      - ${name}`);
    }
  }
  console.log('');
  console.log('[token-extract] 推荐取 token 方式（最稳、零风险）：');
  const steps = [
    '1. 打开 WorkBuddy 桌面端，保持登录态。',
    '2. Cmd+Shift+I 打开 DevTools → Network 面板。',
    '3. 触发一次对话/刷新，找到任意发往 copilot.tencent.com 的请求。',
    '4. 看 Request Headers 的 `Authorization: Bearer xxxx` —— xxxx 即 WORKBUDDY_ACCESS_TOKEN。',
    '5. 填进 shim/.env：WORKBUDDY_ACCESS_TOKEN=xxxx。',
    '   若账号有企业/组织，再补 WORKBUDDY_UID / WORKBUDDY_ENTERPRISE_ID / WORKBUDDY_DOMAIN（可选）。',
  ];
  for (const s of steps) console.log(`   ${s}`);
  console.log('');
  console.log('[token-extract] 如果某目录里有明文 JSON（如 config.json），可试：');
  console.log('   node token-extract.js --try-read /完整/路径/config.json');
  console.log('   （仅当它本就是明文 JSON 才有效；加密的 .ldb / 私有 partition 本工具不解密）');
}

main();
