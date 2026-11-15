'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after, beforeEach } = require('node:test');
const path = require('node:path');

const Database = require('better-sqlite3');
const SqliteSessionStore = require('../../server/services/session-store');
const { createTempDir, removeDir } = require('../helpers/temp-db');

const TTL_MS = 60 * 60 * 1000;
const tempDir = createTempDir('chenlong-session-store-');
const dbFile = path.join(tempDir, 'sessions.db');

let db;
let store;

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

function session(userId, expiresAt) {
  return {
    cookie: { expires: expiresAt || new Date(Date.now() + TTL_MS).toISOString() },
    userId,
    csrfToken: 't'.repeat(64),
  };
}

before(() => {
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  store = new SqliteSessionStore({ db, ttlMs: TTL_MS });
  // 触发惰性建表
  void store.db;
});

beforeEach(() => {
  db.exec('DELETE FROM sessions');
});

after(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  removeDir(tempDir);
});

test('set/get：会话写入后可读出，重复 set 覆盖旧值', async () => {
  const first = session(42);
  await call('set', 'sid-roundtrip', first);
  assert.deepEqual(await call('get', 'sid-roundtrip'), first);

  const updated = { ...session(42), nickname: '新昵称' };
  await call('set', 'sid-roundtrip', updated);
  assert.deepEqual(await call('get', 'sid-roundtrip'), updated);

  assert.equal(await call('get', 'sid-not-exists'), null);
});

test('set：session 没有 cookie.expires 时按 ttlMs 兜底', async () => {
  const startedAt = Date.now();
  await call('set', 'sid-ttl', { userId: 1 });
  const row = db.prepare('SELECT expire FROM sessions WHERE sid = ?').get('sid-ttl');
  assert.ok(row.expire >= startedAt + TTL_MS - 5_000);
  assert.ok(row.expire <= startedAt + TTL_MS + 5_000);
});

test('touch：延长已存在会话的过期时间；不存在时退化为 set', async () => {
  const expiresSoon = new Date(Date.now() + 60_000).toISOString();
  const expiresLater = new Date(Date.now() + 2 * TTL_MS).toISOString();
  await call('set', 'sid-touch', session(7, expiresSoon));
  await call('touch', 'sid-touch', session(7, expiresLater));

  const row = db.prepare('SELECT expire FROM sessions WHERE sid = ?').get('sid-touch');
  assert.equal(row.expire, new Date(expiresLater).getTime());
  // touch 只更新过期时间列，不重写 session JSON，因此 cookie.expires 仍是旧值
  assert.deepEqual(await call('get', 'sid-touch'), session(7, expiresSoon));

  // 记录不存在时 touch 退化为 set，写入完整 session
  await call('touch', 'sid-touch-missing', session(8, expiresLater));
  assert.deepEqual(await call('get', 'sid-touch-missing'), session(8, expiresLater));
});

test('destroy：删除后读不到', async () => {
  await call('set', 'sid-destroy', session(3));
  await call('destroy', 'sid-destroy');
  assert.equal(await call('get', 'sid-destroy'), null);
});

test('get：过期会话返回 null 并清理数据库行', async () => {
  await call('set', 'sid-expired', session(5));
  db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(Date.now() - 1_000, 'sid-expired');
  assert.equal(await call('get', 'sid-expired'), null);
  assert.equal(await call('length'), 0);
});

test('cleanup：只删除已过期会话，并返回删除条数', async () => {
  await call('set', 'sid-s1', session(1));
  await call('set', 'sid-s2', session(2));
  const now = Date.now();
  db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(now - 10, 'sid-s1');

  assert.equal(store.cleanup(now), 1);
  assert.equal(await call('length'), 1);
  assert.deepEqual(
    Object.keys(await call('all')),
    ['sid-s2']
  );
});

test('all / length / clear：批量读取与清空', async () => {
  await call('set', 'sid-a', session(1));
  await call('set', 'sid-b', session(2));
  assert.equal(await call('length'), 2);
  const all = await call('all');
  assert.deepEqual(Object.keys(all).sort(), ['sid-a', 'sid-b']);
  assert.equal(all['sid-a'].userId, 1);

  await call('clear');
  assert.equal(await call('length'), 0);
  assert.deepEqual(await call('all'), Object.create(null));
});

test('set/destroy 可省略回调且不抛错', () => {
  assert.doesNotThrow(() => store.set('sid-no-callback', session(9)));
  assert.doesNotThrow(() => store.destroy('sid-no-callback'));
});
