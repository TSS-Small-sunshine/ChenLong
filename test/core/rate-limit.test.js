'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRateLimiter,
  isRateLimitEnabled,
  DEFAULT_MESSAGE,
} = require('../../server/services/rate-limit');

function withEnv(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  const restore = () => {
    for (const key of Object.keys(patch)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  try {
    const out = fn();
    if (out && typeof out.then === 'function') return out.finally(restore);
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function fakeRequest(ip = '198.51.100.7') {
  return { ip };
}

function fakeResponse() {
  const headers = {};
  const res = {
    statusCode: null,
    body: null,
    headers,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function hit(limiter, req = fakeRequest()) {
  const res = fakeResponse();
  let nextCalled = 0;
  limiter(req, res, () => {
    nextCalled += 1;
  });
  return { res, nextCalled };
}

test('前 max 次放行，第 max+1 次返回 429 与限流头', () => {
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '1' }, () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3, key: (req) => req.ip });

    for (let index = 1; index <= 3; index += 1) {
      const { res, nextCalled } = hit(limiter);
      assert.equal(nextCalled, 1, '第 ' + index + ' 次应放行');
      assert.equal(res.statusCode, null);
      assert.equal(res.headers['x-ratelimit-limit'], '3');
      assert.equal(res.headers['x-ratelimit-remaining'], String(3 - index));
      assert.match(res.headers['x-ratelimit-reset'], /^\d+$/);
    }

    const limited = hit(limiter);
    assert.equal(limited.nextCalled, 0);
    assert.equal(limited.res.statusCode, 429);
    assert.equal(limited.res.body.error.code, 'RATE_LIMITED');
    assert.equal(limited.res.body.error.message, DEFAULT_MESSAGE);
    assert.equal(limited.res.headers['x-ratelimit-limit'], '3');
    assert.equal(limited.res.headers['x-ratelimit-remaining'], '0');
    assert.match(limited.res.headers['x-ratelimit-reset'], /^\d+$/);
    const retryAfter = Number(limited.res.headers['retry-after']);
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1);
  });
});

test('不同 key 的计数互相独立', () => {
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '1' }, () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, key: (req) => req.ip });
    const first = hit(limiter, fakeRequest('203.0.113.9'));
    assert.equal(first.nextCalled, 1);
    const second = hit(limiter, fakeRequest('203.0.113.9'));
    assert.equal(second.res.statusCode, 429);

    const otherIp = hit(limiter, fakeRequest('203.0.113.10'));
    assert.equal(otherIp.nextCalled, 1, '另一个 IP 不应被前一个 IP 拖累');
  });
});

test('窗口过期后同一 key 重新放行（可控 Date.now）', () => {
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '1' }, () => {
    const realNow = Date.now;
    let now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      const limiter = createRateLimiter({ windowMs: 1_000, max: 2, key: (req) => req.ip });
      assert.equal(hit(limiter).nextCalled, 1);
      assert.equal(hit(limiter).nextCalled, 1);
      assert.equal(hit(limiter).res.statusCode, 429);

      now += 1_001; // 窗口完全滑出
      const afterWindow = hit(limiter);
      assert.equal(afterWindow.nextCalled, 1);
      assert.equal(afterWindow.res.headers['x-ratelimit-remaining'], '1');

      now += 500; // 旧的两次时间戳已过期，这次仍应放行
      assert.equal(hit(limiter).nextCalled, 1);
    } finally {
      Date.now = realNow;
    }
  });
});

test('NODE_ENV!=production 时 RATE_LIMIT_ENABLED=0 可关闭限流', () => {
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '0' }, () => {
    assert.equal(isRateLimitEnabled(), false);
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, key: (req) => req.ip });
    for (let index = 0; index < 5; index += 1) {
      assert.equal(hit(limiter).nextCalled, 1, '关闭后第 ' + (index + 1) + ' 次也应放行');
    }
  });
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: 'false' }, () => {
    assert.equal(isRateLimitEnabled(), false);
  });
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '1' }, () => {
    assert.equal(isRateLimitEnabled(), true);
  });
});

test('生产环境忽略 RATE_LIMIT_ENABLED=0，强制开启限流', () => {
  withEnv({ NODE_ENV: 'production', RATE_LIMIT_ENABLED: '0' }, () => {
    assert.equal(isRateLimitEnabled(), true);
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, key: (req) => req.ip });
    assert.equal(hit(limiter).nextCalled, 1);
    assert.equal(hit(limiter).res.statusCode, 429);
  });
});

test('createRateLimiter：非法配置抛错', () => {
  assert.throws(() => createRateLimiter({ windowMs: 0, max: 1, key: () => 'k' }), /windowMs/);
  assert.throws(() => createRateLimiter({ windowMs: -1, max: 1, key: () => 'k' }), /windowMs/);
  assert.throws(() => createRateLimiter({ windowMs: NaN, max: 1, key: () => 'k' }), /windowMs/);
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 0, key: () => 'k' }), /max/);
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 1.5, key: () => 'k' }), /max/);
  assert.throws(() => createRateLimiter({ windowMs: 1000, max: 1, key: null }), /key/);
});

test('自定义 message 会出现在 429 响应中', () => {
  withEnv({ NODE_ENV: 'development', RATE_LIMIT_ENABLED: '1' }, () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, key: () => 'k', message: '自定义限流文案' });
    hit(limiter);
    const limited = hit(limiter);
    assert.equal(limited.res.body.error.message, '自定义限流文案');
  });
});
