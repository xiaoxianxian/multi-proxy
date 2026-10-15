#!/usr/bin/env node
'use strict';
// decrypt-token.js — 一键从本机 WorkBuddy 登录态解密 accessToken，写进 workbuddy-shim/.env
//
// 透明、手动运行；仅在本机、仅为你自己的账号服务。基于 dsh-workbuddy-connect (MIT) 公开的
// 解密配方（desktop-credential-protection.ts，已在 WorkBuddy 5.6.x 实测验证）。
//
// 用法：
//   node decrypt-token.js            # dry-run：仅解密并在屏幕打印成功/长度（不写文件）
//   node decrypt-token.js --write    # 把解密出的 token 写进本目录 .env 的 WORKBUDDY_ACCESS_TOKEN
//
// 原理（零网络、零外部依赖、不启动 GUI）：
//   1) ELECTRON_RUN_AS_NODE=1 跑 WorkBuddy 自己的 Electron 二进制，调其私有 binding
//      electron_browser_workbuddy_storage.loggerGet() 取得 {version:1, atRestSecretKey}
//   2) protectorKey = sha256(atRestSecretKey)
//   3) 读 ~/Library/.../workbuddy-desktop.info，解开 accessToken 字段的 {$wbEncrypted:1, envelope}
//      （AES-256-GCM；AAD 由 dsh 公开复刻的 buildAuthenticatedContextAad 构造）
//   4) 明文 accessToken 即 WORKBUDDY_ACCESS_TOKEN

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ELECTRON = '/Applications/WorkBuddy.app/Contents/MacOS/Electron';
const HELPER = 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';
const AUTH_FILE = path.join(
  process.env.HOME, 'Library', 'Application Support',
  'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'
);
const ENV_PATH = path.join(__dirname, '.env');

/** 取 at-rest 密钥：spawn WorkBuddy 自己的 Electron 二进制（ELECTRON_RUN_AS_NODE=1）。 */
function getAtRestSecretKey() {
  return new Promise((resolve, reject) => {
    const bin = process.env.WORKBUDDY_ELECTRON_BIN || DEFAULT_ELECTRON;
    execFile(bin, ['-e', HELPER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15000,
      maxBuffer: 1 << 20,
    }, (err, stdout) => {
      if (err) return reject(new Error('spawn Electron 失败: ' + err.message));
      let j;
      try { j = JSON.parse(stdout); } catch (e) { return reject(new Error('payload 解析失败: ' + stdout.slice(0, 80))); }
      if (j.version !== 1 || typeof j.atRestSecretKey !== 'string') {
        return reject(new Error('payload 格式不符 (version/atRestSecretKey)'));
      }
      resolve(j.atRestSecretKey);
    });
  });
}

function b64(v, len) {
  const d = Buffer.from(v, 'base64');
  if (d.length === 0) throw new Error('base64 为空');
  if (len && d.length !== len) throw new Error('base64 长度不符 (期望 ' + len + ' 实得 ' + d.length + ')');
  return d;
}

/** 从 dsh 公开实现转写：envelope 的 AAD 构造（WB-AAD\0 / WBEV1 / sym-v1 / suite / keyId）。 */
function buildAad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii');
  const lp = (v) => {
    const b = Buffer.from(v, 'utf8');
    const h = Buffer.allocUnsafe(4);
    h.writeUInt32BE(b.length);
    return Buffer.concat([h, b]);
  };
  const sb = Buffer.allocUnsafe(4);
  sb.writeUInt32BE(suite);
  return Buffer.concat([
    prefix, Buffer.from([1]),
    lp('WBEV1'), lp('sym-v1'), sb, lp(keyId),
    Buffer.from([2]), Buffer.from([0]), Buffer.from([0]),
  ]);
}

/** 解密 workbuddy-desktop.info 里的 accessToken 字段，返回明文。 */
function decryptAccessToken(secret) {
  const protectorKey = crypto.createHash('sha256').update(secret, 'utf8').digest();
  const doc = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const auth = (typeof doc.auth === 'object' && doc.auth !== null) ? doc.auth : doc;
  const wrapped = auth.accessToken;
  if (typeof wrapped !== 'object' || wrapped.$wbEncrypted !== 1 || typeof wrapped.envelope !== 'string') {
    throw new Error('accessToken 不是 5.6 加密包裹（可能是明文或未知格式）');
  }
  const inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'));
  if (inner.suite !== 1) throw new Error('不支持的 envelope suite: ' + inner.suite);
  const envelope = {
    suite: inner.suite,
    keyId: inner.keyId,
    nonce: b64(inner.nonce, 12),
    authTag: b64(inner.authTag, 16),
    ciphertext: b64(inner.ciphertext),
  };
  const decipher = crypto.createDecipheriv('aes-256-gcm', protectorKey, envelope.nonce, { authTagLength: 16 });
  decipher.setAAD(buildAad(envelope.keyId, envelope.suite));
  decipher.setAuthTag(envelope.authTag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString('utf8');
}

async function main() {
  const write = process.argv.includes('--write');
  let secret;
  try {
    secret = await getAtRestSecretKey();
  } catch (e) {
    console.error('[decrypt] 取 atRestSecretKey 失败:', e.message);
    process.exit(1);
  }
  let token;
  try {
    token = decryptAccessToken(secret);
  } catch (e) {
    console.error('[decrypt] 解密 accessToken 失败:', e.message);
    console.error('[decrypt] 多半是 WorkBuddy 升级改了加密方案；翻 dsh-workbuddy-connect 看最新配方。');
    process.exit(1);
  }
  console.log('[decrypt] 解密成功。accessToken 长度=' + token.length +
    '，前缀=' + token.slice(0, 4) + '****' + token.slice(-4));
  if (!write) {
    console.log('[decrypt] dry-run（未写文件）。确认无误后加 --write 写入 workbuddy-shim/.env');
    return;
  }
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  if (/^[ \t]*WORKBUDDY_ACCESS_TOKEN=.*$/m.test(env)) {
    env = env.replace(/^[ \t]*WORKBUDDY_ACCESS_TOKEN=.*$/m, 'WORKBUDDY_ACCESS_TOKEN=' + token);
  } else {
    env += '\nWORKBUDDY_ACCESS_TOKEN=' + token + '\n';
  }
  fs.writeFileSync(ENV_PATH, env);
  console.log('[decrypt] 已写入 ' + ENV_PATH);
}

main();
