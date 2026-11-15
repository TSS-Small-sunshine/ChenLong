'use strict';

/**
 * 应用层 HTTP 集成测试（PostgreSQL 版）。
 * - node:child_process 启动 server/app.js，使用测试专用 DATABASE_URL + 临时端口
 * - 覆盖：/api no-store、CSRF 拦截、注册、双会话、本人改密踢其它会话、管理员重置密码踢全部会话
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');

const {
  installTestDatabase,
  TEST_ENCRYPTION_KEY_HEX,
  TEST_SESSION_SECRET,
} = require('../helpers/temp-db');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'AdminPass123';
const USER_USERNAME = 'it_' + Date.now().toString(36).slice(-8);
const USER_NICKNAME = '集成测试用户';
const USER_PASSWORD = 'UserPass123';
const USER_PASSWORD_CHANGED = 'NewPass456';
const USER_PASSWORD_RESET = 'ResetPass789';

let temp = null;
let child = null;
let port = 0;
let baseUrl = '';
let serverLog = '';

// 跨测试共享的会话状态（同一文件内的顶层 test 按顺序执行）
let clientA = null;
let clientB = null;
let tokenA = '';
let userId = 0;

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const freePort = server.address().port;
      server.close(() => resolve(freePort));
    });
  });
}

function createClient() {
  const cookies = new Map();

  function rememberCookies(res) {
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = String(line).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookies.size > 0) {
      headers.cookie = [...cookies.entries()].map(([name, value]) => name + '=' + value).join('; ');
    }
    const res = await fetch(baseUrl + pathname, { ...options, headers });
    rememberCookies(res);
    return res;
  }

  async function json(method, pathname, token, body) {
    return request(pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-csrf-token': token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function csrf() {
    const res = await request('/api/csrf-token');
    assert.equal(res.status, 200, '获取 CSRF token 失败');
    const body = await res.json();
    assert.match(body.token, /^[0-9a-f]{64}$/);
    return body.token;
  }

  return { request, json, csrf };
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error('服务提前退出（code=' + child.exitCode + '）：\n' + serverLog);
    }
    try {
      const res = await fetch(baseUrl + '/api/health');
      if (res.status === 200) return;
    } catch {
      /* 尚未监听，继续等待 */
    }
    if (Date.now() > deadline) throw new Error('等待服务启动超时：\n' + serverLog);
    await wait(100);
  }
}

before(async () => {
  temp = await installTestDatabase('chenlong_test_app_');
  port = await findFreePort();
  baseUrl = 'http://127.0.0.1:' + port;

  child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'server', 'app.js')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: temp.url,
      NODE_ENV: 'development',
      ADMIN_USERNAME,
      ADMIN_PASSWORD,
      SESSION_SECRET: TEST_SESSION_SECRET,
      ENCRYPTION_KEY: TEST_ENCRYPTION_KEY_HEX,
      RATE_LIMIT_ENABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const collect = (chunk) => {
    serverLog += chunk.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), wait(3000)]);
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
  child = null;
  if (temp) await temp.cleanup();
});

test('/api 响应带 Cache-Control: no-store，静态页面不被强制 no-store', async () => {
  const client = createClient();

  const health = await client.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('cache-control'), 'no-store');

  const settings = await client.request('/api/settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.headers.get('cache-control'), 'no-store');
  const settingsBody = await settings.json();
  assert.equal(settingsBody.items.allowRegister, true);

  const page = await client.request('/chat.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  assert.notEqual(page.headers.get('cache-control'), 'no-store', '静态页不应被 /api 的 no-store 覆盖');
});

test('缺少 CSRF token 的写请求返回 403 CSRF_INVALID', async () => {
  const client = createClient();
  const res = await client.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'nobody', password: 'whatever' }),
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'CSRF_INVALID');
});

test('注册 → 双会话登录 → 本人改密只保留当前会话', async () => {
  clientA = createClient();
  tokenA = await clientA.csrf();

  const registerRes = await clientA.json('POST', '/api/auth/register', tokenA, {
    username: USER_USERNAME,
    nickname: USER_NICKNAME,
    password: USER_PASSWORD,
  });
  const registerBody = await registerRes.json();
  assert.equal(registerRes.status, 201, '注册失败：' + JSON.stringify(registerBody));
  assert.equal(registerBody.user.username, USER_USERNAME);
  assert.equal(registerBody.user.role, 'user');
  assert.equal(registerBody.user.password_hash, undefined);
  assert.match(registerBody.csrfToken, /^[0-9a-f]{64}$/);
  tokenA = registerBody.csrfToken;
  userId = registerBody.user.id;
  assert.ok(Number.isInteger(userId) && userId > 0);

  clientB = createClient();
  const tokenB = await clientB.csrf();
  const loginRes = await clientB.json('POST', '/api/auth/login', tokenB, {
    username: USER_USERNAME,
    password: USER_PASSWORD,
  });
  const loginBody = await loginRes.json();
  assert.equal(loginRes.status, 200, '第二个会话登录失败：' + JSON.stringify(loginBody));
  assert.equal(loginBody.user.id, userId);

  const meBefore = await clientB.request('/api/auth/me');
  assert.equal(meBefore.status, 200);

  const changeRes = await clientA.json('PATCH', '/api/user/password', tokenA, {
    currentPassword: USER_PASSWORD,
    newPassword: USER_PASSWORD_CHANGED,
  });
  const changeBody = await changeRes.json();
  assert.equal(changeRes.status, 200, '改密失败：' + JSON.stringify(changeBody));
  assert.equal(changeBody.ok, true);
  assert.ok(changeBody.revokedSessions >= 1, '应至少失效一个其它设备会话，实际 ' + changeBody.revokedSessions);

  const otherMe = await clientB.request('/api/auth/me');
  assert.equal(otherMe.status, 401, '其它设备会话应失效');

  const currentMe = await clientA.request('/api/auth/me');
  assert.equal(currentMe.status, 200, '改密者当前会话应保留');
  const currentUser = await currentMe.json();
  assert.equal(currentUser.user.id, userId);
});

test('管理员重置密码返回 204，且目标用户全部会话失效、新密码可登录', async () => {
  assert.ok(userId > 0, '依赖上一条测试注册的用户');

  const admin = createClient();
  const adminToken = await admin.csrf();
  const loginRes = await admin.json('POST', '/api/auth/login', adminToken, {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  const loginBody = await loginRes.json();
  assert.equal(loginRes.status, 200, '管理员登录失败：' + JSON.stringify(loginBody));
  const adminToken2 = loginBody.csrfToken;

  const resetRes = await admin.json('POST', '/api/users/' + userId + '/password', adminToken2, {
    password: USER_PASSWORD_RESET,
  });
  assert.equal(resetRes.status, 204, '管理员重置密码应返回 204');
  assert.equal(resetRes.headers.get('cache-control'), 'no-store');

  const afterMe = await clientA.request('/api/auth/me');
  assert.equal(afterMe.status, 401, '目标用户所有会话都应失效');

  const fresh = createClient();
  const freshToken = await fresh.csrf();
  const relogin = await fresh.json('POST', '/api/auth/login', freshToken, {
    username: USER_USERNAME,
    password: USER_PASSWORD_RESET,
  });
  assert.equal(relogin.status, 200, '新密码应可登录');
});
