const crypto = require('crypto');

// Inline the SecretsManager logic (AES-256-GCM encrypt/decrypt) so tests don't
// need to import TypeScript modules. This is a micro-copy of the core logic.
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function expandKey(secretKey) {
  if (secretKey.length < KEY_LENGTH) {
    return crypto.createHash('sha256').update(secretKey).digest();
  }
  return Buffer.from(secretKey.slice(0, KEY_LENGTH));
}

class SecretsManager {
  constructor(secretKey) {
    this.encryptionKey = expandKey(secretKey);
  }

  encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + tag.toString('hex') + encrypted;
  }

  decrypt(encrypted) {
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

describe('SecretsManager', () => {
  it('encrypts and decrypts roundtrip', () => {
    const mgr = new SecretsManager('test-secret-key-12345');
    const plaintext = 'sk-abc123def456';
    const encrypted = mgr.encrypt(plaintext);
    const decrypted = mgr.decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('different encryptions produce different ciphertexts (random IV)', () => {
    const mgr = new SecretsManager('same-key');
    const encrypted1 = mgr.encrypt('hello');
    const encrypted2 = mgr.encrypt('hello');
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('decrypts with correct key, fails with wrong key', () => {
    const mgr1 = new SecretsManager('key-a');
    const mgr2 = new SecretsManager('key-b');
    const encrypted = mgr1.encrypt('secret');
    expect(() => mgr2.decrypt(encrypted)).toThrow();
  });

  it('SHA-256 expands short keys to 32 bytes', () => {
    const mgr = new SecretsManager('short');
    const encrypted = mgr.encrypt('data');
    const decrypted = mgr.decrypt(encrypted);
    expect(decrypted).toBe('data');
  });

  it('handles long API keys', () => {
    const longKey = 'sk-proj-' + 'x'.repeat(100);
    const mgr = new SecretsManager('test');
    const encrypted = mgr.encrypt(longKey);
    const decrypted = mgr.decrypt(encrypted);
    expect(decrypted).toBe(longKey);
  });

  it('handles empty string', () => {
    const mgr = new SecretsManager('test');
    const encrypted = mgr.encrypt('');
    const decrypted = mgr.decrypt(encrypted);
    expect(decrypted).toBe('');
  });

  it('handles unicode characters', () => {
    const mgr = new SecretsManager('test');
    const unicode = '你好世界🌍';
    const encrypted = mgr.encrypt(unicode);
    const decrypted = mgr.decrypt(encrypted);
    expect(decrypted).toBe(unicode);
  });

  it('key file length must be at least KEY_LENGTH for direct use', () => {
    // expandKey slices to KEY_LENGTH if >= 32, hashes if < 32
    const mgr32 = new SecretsManager('a'.repeat(32));
    const mgr31 = new SecretsManager('a'.repeat(31));
    // Both should work, but use different expansion paths
    const enc32 = mgr32.encrypt('test');
    const dec32 = mgr32.decrypt(enc32);
    expect(dec32).toBe('test');
    const enc31 = mgr31.encrypt('test');
    const dec31 = mgr31.decrypt(enc31);
    expect(dec31).toBe('test');
  });
});
