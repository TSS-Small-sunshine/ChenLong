const crypto = require('crypto');

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_FAILURE = { error: { code: 'CSRF_INVALID', message: '页面已过期，请刷新后重试' } };

function createCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// session 里没有 token 才生成，保证多标签页共用同一个 token
function ensureCsrfToken(session) {
  if (!session) return '';
  if (typeof session.csrfToken !== 'string' || session.csrfToken.length === 0) {
    session.csrfToken = createCsrfToken();
  }
  return session.csrfToken;
}

function tokensMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = req.session && req.session.csrfToken;
  const provided = req.get(CSRF_HEADER);
  if (!tokensMatch(expected, provided)) return res.status(403).json(CSRF_FAILURE);
  return next();
}

module.exports = { createCsrfToken, ensureCsrfToken, requireCsrf, tokensMatch, CSRF_HEADER, CSRF_FAILURE };
