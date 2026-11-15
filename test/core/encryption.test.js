'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encrypt, decrypt, isConfigured } = require('../../server/services/encryption');
const {
  TEST_ENCRYPTION_KEY_HEX,
  TEST_ENCRYPTION_KEY_HEX_ALT,
} = require('../helpers/temp-db');

// 本模块按 ENCRYPTION_KEY 原文缓存 key，测试之间必须切换不同的 raw 值
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

function splitPayload(payload) {
  return payload.split(':');
}

test('encrypt/decrypt：中文、英文、空格外内容可往返', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    for (const plain of ['sk-test-1234567890', '中文密钥-测试', 'a b c', '{"nested":"json"}', 'x'.repeat(5000)]) {
      const payload = encrypt(plain);
      assert.equal(decrypt(payload), plain);
    }
  });
});

test('encrypt：v1:iv:tag:cipher 格式与字段长度正确', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    const parts = splitPayload(encrypt('hello'));
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'v1');
    assert.equal(Buffer.from(parts[1], 'base64').length, 12, 'IV 应为 12 字节');
    assert.equal(Buffer.from(parts[2], 'base64').length, 16, 'GCM 认证标签应为 16 字节');
    assert.ok(Buffer.from(parts[3], 'base64').length > 0);
  });
});

test('encrypt：随机 IV 使同一明文每次密文不同', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    const a = encrypt('same-plaintext');
    const b = encrypt('same-plaintext');
    assert.notEqual(a, b);
    assert.equal(decrypt(a), 'same-plaintext');
    assert.equal(decrypt(b), 'same-plaintext');
  });
});

test('decrypt：密文 / 认证标签 / IV 被篡改必须抛错', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    const original = encrypt('tamper-me');
    const parts = splitPayload(original);

    const tamperedCipher = [...parts];
    tamperedCipher[3] = tamperedCipher[3].startsWith('A') ? 'B' + tamperedCipher[3].slice(1) : 'A' + tamperedCipher[3].slice(1);
    assert.throws(() => decrypt(tamperedCipher.join(':')), Error, '篡改密文应失败');

    const tamperedTag = [...parts];
    tamperedTag[2] = tamperedTag[2].startsWith('A') ? 'B' + tamperedTag[2].slice(1) : 'A' + tamperedTag[2].slice(1);
    assert.throws(() => decrypt(tamperedTag.join(':')), Error, '篡改认证标签应失败');

    const tamperedIv = [...parts];
    tamperedIv[1] = tamperedIv[1].startsWith('A') ? 'B' + tamperedIv[1].slice(1) : 'A' + tamperedIv[1].slice(1);
    assert.throws(() => decrypt(tamperedIv.join(':')), Error, '篡改 IV 应失败');

    // 原密文仍可正常解密（篡改只发生在副本上）
    assert.equal(decrypt(original), 'tamper-me');
  });
});

test('decrypt：非法密文格式抛错', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    const bad = [
      'plain-text',
      'v1:only-three-parts:x',
      'v1:a:b:c:d',
      'v2:a:b:c',
      'v1:!!!:!!!:!!!',
    ];
    for (const payload of bad) {
      assert.throws(() => decrypt(payload), Error, '应拒绝：' + payload);
    }
    // IV/tag 长度不对时给出明确错误
    const shortIv = ['v1', Buffer.from('123').toString('base64'), Buffer.alloc(16).toString('base64'), 'AAAA'].join(':');
    assert.throws(() => decrypt(shortIv), /IV 或认证标签长度不正确/);
  });
});

test('encrypt/decrypt：非字符串与空字符串抛 TypeError', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    for (const bad of ['', null, undefined, 0, 123, {}, []]) {
      assert.throws(() => encrypt(bad), TypeError, 'encrypt 应拒绝：' + String(bad));
    }
    assert.throws(() => decrypt(null), TypeError);
    assert.throws(() => decrypt(undefined), TypeError);
    assert.throws(() => decrypt(123), TypeError);
  });
});

test('非法 ENCRYPTION_KEY：抛错且 isConfigured=false', () => {
  for (const badKey of ['too-short', 'zzzz', '1'.repeat(63), 'g'.repeat(64)]) {
    withKey(badKey, () => {
      assert.throws(() => encrypt('x'), /ENCRYPTION_KEY 无效/);
      assert.equal(isConfigured(), false);
    });
  }
});

test('缺少 ENCRYPTION_KEY：抛"未配置"错误且 isConfigured=false', () => {
  withKey(undefined, () => {
    assert.throws(() => encrypt('x'), /ENCRYPTION_KEY 未配置/);
    assert.equal(isConfigured(), false);
  });
  withKey('   ', () => {
    assert.throws(() => encrypt('x'), /ENCRYPTION_KEY 未配置/);
    assert.equal(isConfigured(), false);
  });
});

test('合法密钥 isConfigured=true，base64 形式的 32 字节密钥可用', () => {
  withKey(TEST_ENCRYPTION_KEY_HEX, () => {
    assert.equal(isConfigured(), true);
  });
  withKey(Buffer.alloc(32, 7).toString('base64'), () => {
    assert.equal(isConfigured(), true);
    assert.equal(decrypt(encrypt('base64-key')), 'base64-key');
  });
});

test('不同密钥无法解密其它密钥产生的密文（GCM 认证失败）', () => {
  const payload = withKey(TEST_ENCRYPTION_KEY_HEX, () => encrypt('cross-key-secret'));
  withKey(TEST_ENCRYPTION_KEY_HEX_ALT, () => {
    assert.throws(() => decrypt(payload), Error);
  });
});
