const DEFAULT_MESSAGE = '请求太频繁，请稍后再试';
const CLEANUP_MIN_INTERVAL_MS = 1000;

// NODE_ENV=production 时忽略开关，强制开启限流
function isRateLimitEnabled() {
  if (process.env.NODE_ENV === 'production') return true;
  const raw = String(process.env.RATE_LIMIT_ENABLED || '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}

/**
 * 内存滑动窗口限流中间件。
 * 每个 key 保存窗口内的请求时间戳，超限返回 429 并带上 Retry-After / X-RateLimit-*。
 */
function createRateLimiter({ windowMs, max, key, message }) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('createRateLimiter 需要正的 windowMs');
  if (!Number.isInteger(max) || max <= 0) throw new Error('createRateLimiter 需要正整数的 max');
  if (typeof key !== 'function') throw new Error('createRateLimiter 需要 key 函数');

  const limitMessage = message || DEFAULT_MESSAGE;
  const hits = new Map();

  // 定期淘汰空 key，避免 Map 随时间无限增长；unref 保证不阻止进程退出
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [id, stamps] of hits) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) hits.delete(id);
    }
  }, Math.max(windowMs, CLEANUP_MIN_INTERVAL_MS));
  if (typeof timer.unref === 'function') timer.unref();

  return function rateLimiter(req, res, next) {
    if (!isRateLimitEnabled()) return next();

    const now = Date.now();
    const id = String(key(req) ?? '');
    let stamps = hits.get(id);
    if (!stamps) {
      stamps = [];
      hits.set(id, stamps);
    }

    const cutoff = now - windowMs;
    let expired = 0;
    while (expired < stamps.length && stamps[expired] <= cutoff) expired += 1;
    if (expired > 0) stamps.splice(0, expired);

    res.setHeader('X-RateLimit-Limit', String(max));

    if (stamps.length >= max) {
      const resetAt = stamps[0] + windowMs;
      const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: limitMessage } });
    }

    stamps.push(now);
    res.setHeader('X-RateLimit-Remaining', String(max - stamps.length));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((now + windowMs) / 1000)));
    return next();
  };
}

module.exports = { createRateLimiter, isRateLimitEnabled, DEFAULT_MESSAGE };
