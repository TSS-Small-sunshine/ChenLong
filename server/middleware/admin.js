function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: '请先登录' } });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: '需要管理员权限' } });
  }
  return next();
}

module.exports = { requireAdmin };
