const { getDb } = require('../database/db');

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
}

async function attachUser(req, res, next) {
  if (!req.session || !req.session.userId) return next();

  try {
    const user = await getDb()
      .prepare('SELECT id, username, nickname, avatar, role, status, created_at FROM users WHERE id = ?')
      .get(req.session.userId);

    if (!user || user.status !== 'active') {
      return req.session.destroy((err) => next(err || undefined));
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth, attachUser };
