const express = require('express');
const bcrypt = require('bcryptjs');

const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { validateNickname, validatePassword, toPublicUser } = require('../services/validation');

const router = express.Router();

const BCRYPT_COST = 10;

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

router.use(requireAuth);

router.patch('/profile', async (req, res, next) => {
  try {
    const nickname = validateNickname((req.body || {}).nickname);
    if (!nickname.ok) return fail(res, 400, 'VALIDATION_ERROR', nickname.message);

    const db = getDb();
    const info = await db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname.value, req.user.id);
    if (info.changes === 0) return fail(res, 401, 'UNAUTHORIZED', '请先登录');

    const user = await db
      .prepare('SELECT id, username, nickname, role, created_at FROM users WHERE id = ?')
      .get(req.user.id);
    return res.json({ user: toPublicUser(user) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/password', async (req, res, next) => {
  try {
    const body = req.body || {};
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = validatePassword(body.newPassword);

    if (!currentPassword) return fail(res, 400, 'VALIDATION_ERROR', '请输入当前密码');
    if (!newPassword.ok) return fail(res, 400, 'VALIDATION_ERROR', newPassword.message);

    const db = getDb();
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row) return fail(res, 401, 'UNAUTHORIZED', '请先登录');

    const matched = await bcrypt.compare(currentPassword, row.password_hash);
    if (!matched) return fail(res, 400, 'VALIDATION_ERROR', '当前密码不正确');

    const passwordHash = await bcrypt.hash(newPassword.value, BCRYPT_COST);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.user.id);

    // 改密后让其它设备上的旧会话失效，但保留当前会话（不让用户改完密码就把自己踢下线）
    let revokedSessions = 0;
    try {
      const store = req.sessionStore;
      if (store && typeof store.destroyOthersByUserId === 'function') {
        revokedSessions = await store.destroyOthersByUserId(req.user.id, req.sessionID);
        if (revokedSessions > 0) {
          console.log('[profile] 用户 ' + req.user.id + ' 改密后失效其它会话 ' + revokedSessions + ' 条');
        }
      }
    } catch (err) {
      console.error('[profile] 改密后清理其它会话失败：', err.message);
    }
    return res.json({ ok: true, revokedSessions });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
