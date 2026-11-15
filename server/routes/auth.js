const express = require('express');
const bcrypt = require('bcryptjs');

const { getDb } = require('../database/db');
const {
  validateNickname,
  validateUsername,
  validatePassword,
  toPublicUser,
} = require('../services/validation');
const { isRegistrationAllowed } = require('../services/settings-store');
const { ensureCsrfToken } = require('../middleware/csrf');

const router = express.Router();

const BCRYPT_COST = 10;
const SESSION_COOKIE = 'chenlong.sid';
const INVALID_CREDENTIALS_MESSAGE = '用户名或密码错误';

let dummyHash = null;
async function burnPasswordCompare(password) {
  if (!dummyHash) dummyHash = await bcrypt.hash('chenlong-dummy-password', BCRYPT_COST);
  await bcrypt.compare(password, dummyHash);
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function startSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((regenerateErr) => {
      if (regenerateErr) return reject(regenerateErr);
      req.session.userId = userId;
      // 会话重建后旧 CSRF token 立即失效，必须在新 session 上重新生成
      const csrfToken = ensureCsrfToken(req.session);
      return req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve(csrfToken)));
    });
  });
}

router.post('/register', async (req, res, next) => {
  try {
    if (!(await isRegistrationAllowed())) return fail(res, 403, 'REGISTER_DISABLED', '管理员已关闭注册');

    const body = req.body || {};
    const nickname = validateNickname(body.nickname);
    if (!nickname.ok) return fail(res, 400, 'VALIDATION_ERROR', nickname.message);

    const username = validateUsername(body.username);
    if (!username.ok) return fail(res, 400, 'VALIDATION_ERROR', username.message);

    const password = validatePassword(body.password);
    if (!password.ok) return fail(res, 400, 'VALIDATION_ERROR', password.message);

    const db = getDb();
    const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(username.value);
    if (existing) {
      return fail(res, 409, 'USERNAME_TAKEN', '该用户名已被注册');
    }

    const passwordHash = await bcrypt.hash(password.value, BCRYPT_COST);
    let userId;
    try {
      const info = await db
        .prepare(
          "INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?) RETURNING id"
        )
        .run(username.value, passwordHash, nickname.value, new Date().toISOString());
      userId = Number(info.rows[0].id);
    } catch (err) {
      if (err && err.code === '23505') {
        return fail(res, 409, 'USERNAME_TAKEN', '该用户名已被注册');
      }
      throw err;
    }

    const user = await db
      .prepare('SELECT id, username, nickname, role, created_at FROM users WHERE id = ?')
      .get(userId);
    const csrfToken = await startSession(req, user.id);
    return res.status(201).json({ user: toPublicUser(user), csrfToken });
  } catch (err) {
    return next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return fail(res, 400, 'VALIDATION_ERROR', '请输入用户名和密码');

    const user = await getDb()
      .prepare('SELECT id, username, password_hash, nickname, role, status, created_at FROM users WHERE username = ?')
      .get(username);

    if (!user) {
      await burnPasswordCompare(password);
      return fail(res, 401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
    }

    const matched = await bcrypt.compare(password, user.password_hash);
    if (!matched) return fail(res, 401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
    if (user.status !== 'active') return fail(res, 403, 'ACCOUNT_DISABLED', '账号已被禁用，请联系管理员');

    const csrfToken = await startSession(req, user.id);
    return res.json({ user: toPublicUser(user), csrfToken });
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', (req, res, next) => {
  const finish = (err) => {
    if (err) return next(err);
    res.clearCookie(SESSION_COOKIE);
    return res.status(204).end();
  };
  if (!req.session) return finish();
  return req.session.destroy(finish);
});

router.get('/me', (req, res) => {
  if (!req.user) return fail(res, 401, 'UNAUTHORIZED', '请先登录');
  return res.json({ user: toPublicUser(req.user) });
});

module.exports = router;
