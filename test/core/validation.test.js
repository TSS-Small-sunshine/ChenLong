'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  USERNAME_PATTERN,
  PASSWORD_MIN,
  PASSWORD_MAX,
  NICKNAME_MIN,
  NICKNAME_MAX,
  validateUsername,
  validatePassword,
  validateNickname,
  toPublicUser,
} = require('../../server/services/validation');

test('validateUsername：合法用户名边界（3–24 位字母数字下划线）', () => {
  assert.equal(USERNAME_PATTERN.test('abc'), true);
  assert.equal(USERNAME_PATTERN.test('user_123'), true);
  assert.equal(USERNAME_PATTERN.test('A'.repeat(24)), true);

  const shortest = validateUsername('abc');
  assert.deepEqual(shortest, { ok: true, value: 'abc' });
  assert.deepEqual(validateUsername('A'.repeat(24)), { ok: true, value: 'A'.repeat(24) });
  // 前后空白会被 trim
  assert.deepEqual(validateUsername('  user_123  '), { ok: true, value: 'user_123' });
});

test('validateUsername：非法用户名', () => {
  for (const bad of ['ab', 'a'.repeat(25), '中文名', 'bad name', 'user-name', '', '   ', null, undefined, 123, {}]) {
    const result = validateUsername(bad);
    assert.equal(result.ok, false, `应拒绝：${String(bad)}`);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
  }
  assert.match(validateUsername('ab').message, /3–24/);
});

test('validatePassword：长度边界 6–64 且不做 trim', () => {
  assert.equal(PASSWORD_MIN, 6);
  assert.equal(PASSWORD_MAX, 64);

  assert.deepEqual(validatePassword('a'.repeat(6)), { ok: true, value: 'a'.repeat(6) });
  assert.deepEqual(validatePassword('a'.repeat(64)), { ok: true, value: 'a'.repeat(64) });
  assert.equal(validatePassword('a'.repeat(5)).ok, false);
  assert.equal(validatePassword('a'.repeat(65)).ok, false);
  assert.equal(validatePassword('a'.repeat(5)).message.includes('6–64'), true);
});

test('validatePassword：空值与非字符串', () => {
  for (const bad of ['', null, undefined, 123, 0, {}, []]) {
    const result = validatePassword(bad);
    assert.equal(result.ok, false, `应拒绝：${String(bad)}`);
  }
  assert.match(validatePassword('').message, /请输入密码/);
});

test('validateNickname：trim 后 1–20 个字符', () => {
  assert.equal(NICKNAME_MIN, 1);
  assert.equal(NICKNAME_MAX, 20);

  assert.deepEqual(validateNickname('尘龙'), { ok: true, value: '尘龙' });
  assert.deepEqual(validateNickname('  a  '), { ok: true, value: 'a' });
  assert.deepEqual(validateNickname('a'.repeat(20)), { ok: true, value: 'a'.repeat(20) });
  assert.equal(validateNickname('a'.repeat(21)).ok, false);
  assert.equal(validateNickname('a'.repeat(21)).message.includes('1–20'), true);
});

test('validateNickname：空值与非字符串', () => {
  for (const bad of ['', '   ', null, undefined, 123, {}, []]) {
    const result = validateNickname(bad);
    assert.equal(result.ok, false, `应拒绝：${String(bad)}`);
  }
  assert.match(validateNickname('').message, /请输入昵称/);
});

test('toPublicUser：只暴露公开字段，空数据返回 null', () => {
  const row = {
    id: 7,
    username: 'alice',
    nickname: '爱丽丝',
    role: 'admin',
    status: 'active',
    created_at: '2026-11-15T00:00:00.000Z',
    password_hash: 'secret-hash',
    avatar: '/a.png',
  };
  const user = toPublicUser(row);
  assert.deepEqual(user, {
    id: 7,
    username: 'alice',
    nickname: '爱丽丝',
    role: 'admin',
    created_at: '2026-11-15T00:00:00.000Z',
  });
  assert.equal(user.password_hash, undefined);
  assert.equal(user.status, undefined);
  assert.equal(toPublicUser(null), null);
  assert.equal(toPublicUser(undefined), null);
});
