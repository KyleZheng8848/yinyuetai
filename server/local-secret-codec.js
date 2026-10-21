'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'yyt-local-v1:';

function keyFor(runtimeDir) {
  const keyPath = path.join(runtimeDir, '.credential-key');
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  try {
    const saved = fs.readFileSync(keyPath);
    if (saved.length !== 32) throw new Error('本机凭据密钥长度无效');
    try { fs.chmodSync(keyPath, 0o600); } catch (_) {}
    return saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const created = crypto.randomBytes(32);
    try {
      fs.writeFileSync(keyPath, created, { mode: 0o600, flag: 'wx' });
      return created;
    } catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError;
      return fs.readFileSync(keyPath);
    }
  }
}

function createLocalSecretCodec(runtimeDir) {
  const key = keyFor(path.resolve(runtimeDir));
  return {
    storage: 'local-aes-256-gcm',
    encrypt(value) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
    },
    decrypt(value) {
      const source = String(value || '');
      if (!source.startsWith(PREFIX)) {
        const error = new Error('旧版钥匙串凭据需要重新输入');
        error.code = 'LEGACY_SECRET';
        throw error;
      }
      const payload = Buffer.from(source.slice(PREFIX.length), 'base64');
      if (payload.length < 29) throw new Error('本机加密凭据损坏');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
      decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

module.exports = { createLocalSecretCodec, PREFIX };
