'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCsrfToken,
  ensureCsrfToken,
  requireCsrf,
  tokensMatch,
  CSRF_HEADER,
  CSRF_FAILURE,
} = require('../../server/middleware/csrf');

function fakeRequest({ method = 'GET', session = {}, headers = {} } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    method,
    session,
    get(name) {
      return normalized[String(name).toLowerCase()];
    },
  };
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

test('tokensMatch：相同、不同、长度不同与非法输入', () => {
  const token = createCsrfToken();
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(tokensMatch(token, token), true);

  const other = createCsrfToken();
  assert.equal(tokensMatch(token, other), false);
  assert.equal(tokensMatch('a'.repeat(64), 'b'.repeat(64)), false);
  // 长度不同不能抛异常，直接返回 false
  assert.equal(tokensMatch('abc', 'abcd'), false);
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch('', token), false);
  assert.equal(tokensMatch(token, ''), false);
  assert.equal(tokensMatch(null, token), false);
  assert.equal(tokensMatch(token, undefined), false);
  assert.equal(tokensMatch(123, 123), false);
  assert.equal(tokensMatch(token, 123), false);
});

test('ensureCsrfToken：懒生成且幂等，多标签页共用同一 token', () => {
  const session = {};
  const first = ensureCsrfToken(session);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(session.csrfToken, first);
  assert.equal(ensureCsrfToken(session), first);
  assert.equal(ensureCsrfToken(session), first);

  // 已有 token 不会被覆盖
  const existing = { csrfToken: 'f'.repeat(64) };
  assert.equal(ensureCsrfToken(existing), 'f'.repeat(64));
  assert.equal(existing.csrfToken, 'f'.repeat(64));

  // 无 session 时返回空串，不抛异常
  assert.equal(ensureCsrfToken(null), '');
  assert.equal(ensureCsrfToken(undefined), '');
});

test('requireCsrf：GET / HEAD / OPTIONS 直接放行', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const req = fakeRequest({ method, session: {} });
    const res = fakeResponse();
    let nextCalled = 0;
    requireCsrf(req, res, () => {
      nextCalled += 1;
    });
    assert.equal(nextCalled, 1, method + ' 应放行');
    assert.equal(res.statusCode, null);
    assert.equal(res.body, null);
  }
});

test('requireCsrf：写方法缺 token 返回 403 CSRF_INVALID 信封', () => {
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const req = fakeRequest({ method, session: { csrfToken: createCsrfToken() } });
    const res = fakeResponse();
    let nextCalled = 0;
    requireCsrf(req, res, () => {
      nextCalled += 1;
    });
    assert.equal(nextCalled, 0, method + ' 缺 token 不应放行');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, CSRF_FAILURE);
    assert.equal(res.body.error.code, 'CSRF_INVALID');
  }
});

test('requireCsrf：token 缺失 / 错误 / 长度不同均 403', () => {
  const expected = createCsrfToken();
  const cases = [
    { session: {}, header: undefined },
    { session: { csrfToken: expected }, header: undefined },
    { session: { csrfToken: expected }, header: 'f'.repeat(64) },
    { session: { csrfToken: expected }, header: 'abc' },
    { session: undefined, header: expected },
    { session: { csrfToken: expected }, header: expected.slice(0, -1) },
  ];
  for (const item of cases) {
    const req = fakeRequest({
      method: 'POST',
      session: item.session,
      headers: item.header === undefined ? {} : { [CSRF_HEADER]: item.header },
    });
    const res = fakeResponse();
    let nextCalled = 0;
    requireCsrf(req, res, () => {
      nextCalled += 1;
    });
    assert.equal(nextCalled, 0);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, 'CSRF_INVALID');
  }
});

test('requireCsrf：session token 与请求头一致时放行', () => {
  const token = createCsrfToken();
  const req = fakeRequest({
    method: 'POST',
    session: { csrfToken: token },
    headers: { [CSRF_HEADER]: token },
  });
  const res = fakeResponse();
  let nextCalled = 0;
  requireCsrf(req, res, () => {
    nextCalled += 1;
  });
  assert.equal(nextCalled, 1);
  assert.equal(res.statusCode, null);

  // 头名大小写不敏感（req.get 由 Express 保证，这里模拟小写获取）
  assert.equal(CSRF_HEADER, 'x-csrf-token');
});
