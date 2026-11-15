const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SECRETS_FILE = path.join(DATA_DIR, '.dev-secrets.json');
const SECRETS_DISPLAY_PATH = 'data/.dev-secrets.json';
const HEX_KEY_PATTERN = /^[0-9a-f]{64}$/;

const FIELDS = [
  { field: 'sessionSecret', env: 'SESSION_SECRET' },
  { field: 'encryptionKey', env: 'ENCRYPTION_KEY' },
];

// 极少数文件系统不支持硬链接（进而无法做原子排他创建），此时退化为 rename。
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EINVAL', 'EXDEV', 'ENOSYS']);

function corruptFileError(detail) {
  return new Error(
    `${SECRETS_DISPLAY_PATH} ${detail}。为避免覆盖其中仍在使用的密钥（那会让已加密的 API Key 永久无法解密），本次启动已终止：` +
      '请手工修复该文件；确认不再需要其中密钥后，可删除它再启动（删除后既有会话与已加密的 API Key 都会失效）。'
  );
}

function generateSecrets() {
  return {
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    encryptionKey: crypto.randomBytes(32).toString('hex'),
  };
}

function readSecrets() {
  let text;
  try {
    text = fs.readFileSync(SECRETS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`无法读取 ${SECRETS_DISPLAY_PATH}：${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw corruptFileError(`不是合法的 JSON（${err.message}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corruptFileError('的内容不是 JSON 对象');
  }

  const secrets = {};
  for (const { field } of FIELDS) {
    const value = typeof parsed[field] === 'string' ? parsed[field].trim() : '';
    if (!HEX_KEY_PATTERN.test(value)) {
      throw corruptFileError(`中的 ${field} 无效（需要 64 位十六进制字符串，即 32 字节密钥）`);
    }
    secrets[field] = value;
  }
  return secrets;
}

// 先写临时文件并 fsync，再用硬链接做原子且排他的落盘：并发启动时只有一个进程能创建成功，
// 其余进程读到的是它写下的完整文件，不会被半截内容或互相覆盖影响。
function writeSecretsExclusive(secrets) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = path.join(
    DATA_DIR,
    `.dev-secrets.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );

  const fd = fs.openSync(tmpPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(secrets, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    try {
      fs.linkSync(tmpPath, SECRETS_FILE);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (!LINK_UNSUPPORTED.has(err.code)) throw err;
      fs.renameSync(tmpPath, SECRETS_FILE);
      return true;
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

/**
 * 解析开发模式密钥。优先级：process.env > data/.dev-secrets.json > 首次生成。
 * 只补齐缺失的环境变量，已由 .env / 环境变量提供的值原样保留。
 */
function resolveDevSecrets() {
  const existing = readSecrets();
  let secrets = existing;
  let created = false;

  if (!secrets) {
    const candidate = generateSecrets();
    created = writeSecretsExclusive(candidate);
    if (created) {
      secrets = candidate;
    } else {
      secrets = readSecrets();
      if (!secrets) throw new Error(`${SECRETS_DISPLAY_PATH} 在启动过程中被删除，请重新启动服务`);
    }
  }

  const applied = [];
  for (const { field, env } of FIELDS) {
    if (typeof process.env[env] === 'string' && process.env[env].trim()) continue;
    process.env[env] = secrets[field];
    applied.push(env);
  }

  return { created, reused: !created, applied, file: SECRETS_DISPLAY_PATH };
}

module.exports = { resolveDevSecrets, SECRETS_FILE, SECRETS_DISPLAY_PATH };
