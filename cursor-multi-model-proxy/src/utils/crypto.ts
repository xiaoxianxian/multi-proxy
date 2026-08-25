import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_FILE = '.encryption-key';

// P0-6: 密钥文件锚定到模块位置（<项目根>/.encryption-key），与 data/proxy.db
// 同级。此前用 process.cwd() —— 从其它目录启动（或 Docker WORKDIR 不同）时
// 会找不到/另生成一份密钥，导致已有 API Key 无法解密。
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let cachedKey: Buffer | null = null;

/**
 * Load encryption key with priority:
 * 1. ENCRYPTION_KEY environment variable
 * 2. .encryption-key file (auto-generated if missing)
 */
export function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  // Priority 1: environment variable
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey.length > 0) {
    cachedKey = expandKey(envKey);
    return cachedKey;
  }

  // Priority 2: key file
  const keyPath = path.join(PROJECT_ROOT, KEY_FILE);
  try {
    if (fs.existsSync(keyPath)) {
      const keyStr = fs.readFileSync(keyPath, 'utf8').trim();
      cachedKey = expandKey(keyStr);
      return cachedKey;
    }
  } catch {
    // fall through to generate
  }

  // Generate new key
  const randomKey = crypto.randomBytes(KEY_LENGTH);
  try {
    fs.writeFileSync(keyPath, randomKey.toString('hex'), { mode: 0o600 });
    console.log(`[Crypto] Generated new encryption key at ${keyPath}`);
  } catch (e: any) {
    console.error(`[Crypto] Failed to write key file: ${e.message}`);
    throw new Error('Cannot create encryption key file. Set ENCRYPTION_KEY environment variable.');
  }
  cachedKey = randomKey;
  return cachedKey;
}

function expandKey(secretKey: string): Buffer {
  const salt = Buffer.from('cursor-multi-model-proxy-salt', 'utf8');
  return crypto.pbkdf2Sync(secretKey, salt, 100000, KEY_LENGTH, 'sha256');
}

export class SecretsManager {
  private encryptionKey: Buffer;

  constructor(secretKey?: string) {
    if (secretKey) {
      this.encryptionKey = expandKey(secretKey);
    } else {
      this.encryptionKey = getEncryptionKey();
    }
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    // 格式: iv + tag + encrypted
    return iv.toString('hex') + tag.toString('hex') + encrypted;
  }

  decrypt(encrypted: string): string {
    const iv = Buffer.from(encrypted.slice(0, IV_LENGTH * 2), 'hex');
    const tag = Buffer.from(encrypted.slice(IV_LENGTH * 2, IV_LENGTH * 2 + TAG_LENGTH * 2), 'hex');
    const ciphertext = encrypted.slice((IV_LENGTH + TAG_LENGTH) * 2);
    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
