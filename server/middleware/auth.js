const { getDb } = require('../database/db');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
}

function attachUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();

  let user;
  try {
    user = getDb()
      .prepare('SELECT id, username, nickname, avatar, role, status, created_at FROM users WHERE id = ?')
      .get(req.session.userId);
  } catch (err) {
    return next(err);
  }

  if (!user || user.status !== 'active') {
    return req.session.destroy((err) => next(err || undefined));
  }

  req.user = user;
  return next();
}

module.exports = { requireAuth, attachUser };
