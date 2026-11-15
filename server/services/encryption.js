const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 'v1';

let cache = { raw: null, key: null };

function parseKey(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === KEY_BYTES) key = decoded;
  }
  if (!key || key.length !== KEY_BYTES) {
    throw new Error(
      'ENCRYPTION_KEY 无效：需要 32 字节密钥（64 位 hex 或 base64 编码的 32 字节），' +
        '可用 node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" 生成'
    );
  }
  return key;
}

function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw.trim()) throw new Error('ENCRYPTION_KEY 未配置，无法加解密 API Key');
  if (cache.raw === raw) return cache.key;
  const key = parseKey(raw);
  cache = { raw, key };
  return key;
}

function isConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

function encrypt(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('encrypt 只接受非空字符串');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(payload) {
  if (typeof payload !== 'string') {
    throw new TypeError('decrypt 需要 v1:<iv>:<tag>:<cipher> 格式的字符串');
  }
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('密文格式无效：期望 v1:<iv-base64>:<tag-base64>:<cipher-base64>');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new Error('密文格式无效：IV 或认证标签长度不正确');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

const SELF_CHECK_SENTINEL = 'chenlong-encryption-key-self-check';

/**
 * 启动自检：能对固定哨兵值完成 encrypt -> decrypt 且结果一致，才算密钥可用。
 * 失败时抛错，由调用方决定是否终止启动（避免服务正常启动、首次使用 Key 才 500）。
 */
function verifyKey() {
  const probe = encrypt(SELF_CHECK_SENTINEL);
  if (decrypt(probe) !== SELF_CHECK_SENTINEL) {
    throw new Error('ENCRYPTION_KEY 自检失败：加密结果无法正确解密');
  }
  return true;
}

module.exports = { encrypt, decrypt, isConfigured, verifyKey };
