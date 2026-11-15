const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const express = require('express');
const session = require('express-session');

const { initDatabase } = require('./database/init');
const { getDb, closeDb } = require('./database/db');
const { attachUser } = require('./middleware/auth');
const { ensureCsrfToken, requireCsrf } = require('./middleware/csrf');
const { securityHeaders } = require('./middleware/security-headers');
const { createRateLimiter } = require('./services/rate-limit');
const SqliteSessionStore = require('./services/session-store');
const { resolveDevSecrets } = require('./services/dev-secrets');
const { verifyKey } = require('./services/encryption');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const VERSION = pkg.version;
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const RATE_LIMITED_MESSAGE = '请求太频繁，请稍后再试';

// 限流规则：windowMs / max（写死常量）
const RATE_LIMIT_GLOBAL = { windowMs: 60 * 1000, max: 300 };
const RATE_LIMIT_LOGIN = { windowMs: 5 * 60 * 1000, max: 10 };
const RATE_LIMIT_REGISTER = { windowMs: 10 * 60 * 1000, max: 5 };
const RATE_LIMIT_PASSWORD = { windowMs: 60 * 1000, max: 10 };
const RATE_LIMIT_CHAT = { windowMs: 60 * 1000, max: 20 };

function isTruthyEnv(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

const globalRateLimiter = createRateLimiter({
  ...RATE_LIMIT_GLOBAL,
  key: (req) => `ip:${req.ip}`,
  message: RATE_LIMITED_MESSAGE,
});
const loginRateLimiter = createRateLimiter({
  ...RATE_LIMIT_LOGIN,
  key: (req) => `ip:${req.ip}`,
  message: RATE_LIMITED_MESSAGE,
});
const registerRateLimiter = createRateLimiter({
  ...RATE_LIMIT_REGISTER,
  key: (req) => `ip:${req.ip}`,
  message: RATE_LIMITED_MESSAGE,
});
const passwordRateLimiter = createRateLimiter({
  ...RATE_LIMIT_PASSWORD,
  key: (req) => `user:${req.user.id}`,
  message: RATE_LIMITED_MESSAGE,
});
const chatRateLimiter = createRateLimiter({
  ...RATE_LIMIT_CHAT,
  key: (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`),
  message: RATE_LIMITED_MESSAGE,
});

// 静态资源不走本中间件；/api 下的 GET / HEAD / OPTIONS 也不计数
function countWritesOnly(limiter) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return limiter(req, res, next);
  };
}

function ensureSecrets() {
  const missing = [];
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (!process.env.ENCRYPTION_KEY) missing.push('ENCRYPTION_KEY');
  if (missing.length === 0) return;

  if (IS_PRODUCTION) {
    console.error(
      `[FATAL] 生产环境缺少必需环境变量：${missing.join('、')}。为避免会话伪造与 API Key 明文存储，服务已终止启动。`
    );
    process.exit(1);
  }

  let report;
  try {
    report = resolveDevSecrets();
  } catch (err) {
    console.error('[FATAL] 开发密钥处理失败：', err.message);
    process.exit(1);
  }

  const fromEnv = ['SESSION_SECRET', 'ENCRYPTION_KEY'].filter((name) => !missing.includes(name));

  console.warn('====================================================================');
  console.warn(`[WARN] 开发环境缺少环境变量：${missing.join('、')}`);
  if (fromEnv.length > 0) {
    console.warn(`[WARN] 使用 .env / 环境变量中的 ${fromEnv.join('、')}（优先于 ${report.file}）`);
  }
  if (report.created) {
    console.warn(`[WARN] 已生成开发密钥并保存到 ${report.file}（生产请改用 .env）`);
  } else {
    console.warn(`[WARN] 已复用 ${report.file} 中的开发密钥`);
  }
  console.warn('[WARN] 该文件是明文密钥，已被 .gitignore 忽略，请勿提交到版本库。');
  console.warn('[WARN] 需要固定配置时请参考 .env.example 使用 .env（其优先级高于该文件）。');
  console.warn('====================================================================');
}

ensureSecrets();

// 启动自检：密钥必须真的能加解密；否则等到首次保存/使用 API Key 才报错，会让人误以为服务正常
function assertEncryptionKey() {
  try {
    verifyKey();
    console.log('[key] ENCRYPTION_KEY 自检通过');
  } catch (err) {
    console.error('[FATAL] ENCRYPTION_KEY 不可用：' + err.message);
    console.error('[FATAL] 服务已终止启动。请配置正确的 32 字节密钥；更换密钥会导致已保存的上游 API Key 永久无法解密。');
    process.exit(1);
  }
}

assertEncryptionKey();

const app = express();

app.disable('x-powered-by');

if (isTruthyEnv(process.env.TRUST_PROXY)) app.set('trust proxy', 1);

app.use(securityHeaders);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use(
  session({
    name: 'chenlong.sid',
    secret: process.env.SESSION_SECRET,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE,
      secure: IS_PRODUCTION,
    },
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));

// /api 响应含用户、会话、设置等敏感 JSON，禁止浏览器与中间代理缓存（静态资源不受影响）
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (req, res) => {
  try {
    getDb().prepare('SELECT 1 AS ok').get();
  } catch (err) {
    console.error('[health] 数据库检查失败：', err.message);
    return res.status(503).json({
      status: 'degraded',
      uptime: process.uptime(),
      db: 'disconnected',
      version: VERSION,
    });
  }
  return res.json({ status: 'ok', uptime: process.uptime(), db: 'connected', version: VERSION });
});

app.use('/api', countWritesOnly(globalRateLimiter));
app.use('/api', attachUser);

// 公开端点：CSRF 令牌本身必须留在 CSRF 校验之外，否则首屏无法取到 token
app.get('/api/csrf-token', (req, res, next) => {
  try {
    return res.json({ token: ensureCsrfToken(req.session) });
  } catch (err) {
    return next(err);
  }
});

app.use('/api', requireCsrf);

app.use('/api/users', (req, res, next) => {
  if (req.method !== 'POST' || !/^\/\d+\/password\/?$/.test(req.path)) return next();
  if (!req.user) return next();
  return passwordRateLimiter(req, res, next);
});
app.use('/api/auth/login', loginRateLimiter);
app.use('/api/auth/register', registerRateLimiter);
app.use('/api/chat/completions', chatRateLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/providers', require('./routes/providers'));
app.use('/api/models', require('./routes/models'));
app.use('/api/user', require('./routes/profile'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/settings', require('./routes/settings'));

app.use('/api', (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `接口不存在：${req.method} ${req.originalUrl}` },
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[error]', err);
  const code = status >= 500 ? 'INTERNAL_ERROR' : err.type === 'entity.parse.failed' ? 'INVALID_JSON' : 'BAD_REQUEST';
  const message = IS_PRODUCTION && status >= 500 ? '服务器内部错误' : err.message || '请求处理失败';
  return res.status(status).json({ error: { code, message } });
});

function start() {
  try {
    const result = initDatabase();
    if (result.settingsInserted > 0) {
      console.log(`[db] 已写入默认设置 ${result.settingsInserted} 条`);
    }
  } catch (err) {
    console.error('[FATAL] 数据库初始化失败：', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`尘龙 ChenLong v${VERSION} 已启动：http://127.0.0.1:${PORT} (${NODE_ENV})`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] 端口 ${PORT} 已被占用，请先关闭占用进程或修改 PORT。`);
    } else {
      console.error('[FATAL] 服务启动失败：', err.message);
    }
    closeDb();
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在关闭服务...`);
    const finish = () => {
      closeDb();
      console.log('服务已安全关闭');
      process.exit(0);
    };
    server.close(finish);
    setTimeout(finish, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

module.exports = app;
module.exports.start = start;

if (require.main === module) start();
