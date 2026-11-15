'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after, beforeEach } = require('node:test');
const path = require('node:path');

const Database = require('better-sqlite3');
const SqliteSessionStore = require('../../server/services/session-store');
const { createTempDir, removeDir } = require('../helpers/temp-db');

const TTL_MS = 60 * 60 * 1000;
const tempDir = createTempDir('chenlong-session-revoke-');
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

function session(userId) {
  return {
    cookie: { expires: new Date(Date.now() + TTL_MS).toISOString() },
    userId,
    csrfToken: 'r'.repeat(64),
  };
}

async function seed() {
  await call('set', 'sid-a1', session(1));
  await call('set', 'sid-a2', session(1));
  await call('set', 'sid-b1', session(2));
  await call('set', 'sid-anon', { cookie: { expires: new Date(Date.now() + TTL_MS).toISOString() } });
}

before(() => {
  db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  store = new SqliteSessionStore({ db, ttlMs: TTL_MS });
  void store.db;
});

beforeEach(async () => {
  db.exec('DELETE FROM sessions');
  await seed();
});

after(() => {
  try {
    db.close();
  } catch {
    /* 已关闭 */
  }
  removeDir(tempDir);
});

test('destroyByUserId：删除该用户全部会话，保留其它用户与匿名会话', async () => {
  assert.equal(store.destroyByUserId(1), 2);
  assert.equal(await call('get', 'sid-a1'), null);
  assert.equal(await call('get', 'sid-a2'), null);
  assert.notEqual(await call('get', 'sid-b1'), null);
  assert.notEqual(await call('get', 'sid-anon'), null);
  assert.equal(await call('length'), 2);
});

test('destroyByUserId：接受字符串 userId（与库里数字类型等价）', async () => {
  assert.equal(store.destroyByUserId('2'), 1);
  assert.equal(await call('get', 'sid-b1'), null);
  assert.equal(await call('length'), 3);
});

test('destroyOthersByUserId：只删该用户其它会话，保留 keepSid', async () => {
  assert.equal(store.destroyOthersByUserId(1, 'sid-a1'), 1);
  assert.notEqual(await call('get', 'sid-a1'), null, 'keepSid 必须保留');
  assert.equal(await call('get', 'sid-a2'), null);
  assert.notEqual(await call('get', 'sid-b1'), null);
  assert.notEqual(await call('get', 'sid-anon'), null);
});

test('destroyOthersByUserId：keepSid 不存在时删除该用户全部会话', async () => {
  assert.equal(store.destroyOthersByUserId(1, 'sid-not-exists'), 2);
  assert.equal(await call('length'), 2);
});

test('没有匹配会话时返回 0 且不误删', async () => {
  assert.equal(store.destroyByUserId(999), 0);
  assert.equal(store.destroyOthersByUserId(999, 'sid-a1'), 0);
  assert.equal(await call('length'), 4);
});

test('会话行 JSON 损坏时跳过而不抛错（不影响其它会话的删除）', async () => {
  db.prepare('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)').run(
    'sid-broken',
    '{not-json',
    Date.now() + TTL_MS
  );
  assert.equal(store.destroyByUserId(1), 2, '损坏行应被跳过，正常会话照常删除');
  assert.equal(await call('length'), 3, 'b1 / anon / broken 三行保留');
  assert.notEqual(db.prepare("SELECT sid FROM sessions WHERE sid = 'sid-broken'").get(), undefined);
  // get 遇到损坏 JSON 会把错误交给回调（既有行为），不应导致进程崩溃
  await assert.rejects(call('get', 'sid-broken'), SyntaxError);
});
