'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyKey, isConfigured } = require('../../server/services/encryption');
const { TEST_ENCRYPTION_KEY_HEX } = require('../helpers/temp-db');

function withKey(key, fn) {
  const saved = process.env.ENCRYPTION_KEY;
  if (key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = key;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = saved;
  }
}

test('verifyKey：合法 32 字节密钥 encrypt->decrypt 自检通过并返回 true', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    assert.equal(verifyKey(), true);
    assert.equal(isConfigured(), true);
  });
});

test('verifyKey：base64 编码的 32 字节密钥同样通过', () => {
  withKey(Buffer.alloc(32, 9).toString('base64'), () => {
    assert.equal(verifyKey(), true);
  });
});

test('verifyKey：非法密钥抛错（按 ENCRYPTION_KEY 原文换值可绕过缓存）', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    assert.equal(verifyKey(), true);
  });
  withKey('too-short', () => {
    assert.throws(() => verifyKey(), /ENCRYPTION_KEY 无效/);
    assert.equal(isConfigured(), false);
  });
  // 换回合法值后缓存刷新，自检恢复
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    assert.equal(verifyKey(), true);
  });
});

test('verifyKey：缺少 ENCRYPTION_KEY 时抛"未配置"错误', () => {
  withKey(undefined, () => {
    assert.throws(() => verifyKey(), /ENCRYPTION_KEY 未配置/);
  });
});
