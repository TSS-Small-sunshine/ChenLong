'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isBlockedAddress,
  assertAllowedUpstream,
  isPrivateUpstreamAllowed,
  BLOCKED_CODE,
  BLOCKED_MESSAGE,
} = require('../../server/services/upstream-guard');

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

function assertBlockedError(err) {
  assert.equal(err.code, BLOCKED_CODE);
  assert.equal(err.message, BLOCKED_MESSAGE);
  return true;
}

test('isBlockedAddress：IPv4 内网 / 回环 / 元数据 / 保留段均拒绝', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '192.0.2.10',
    '198.51.100.10',
    '203.0.113.10',
  ];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, address + ' 应被拒绝');
  }
});

test('isBlockedAddress：公网 IPv4 放行', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '104.18.32.7']) {
    assert.equal(isBlockedAddress(address), false, address + ' 应放行');
  }
});

test('isBlockedAddress：IPv6 回环 / ULA / 链路本地拒绝，公网 IPv6 放行', () => {
  const blocked = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address), true, address + ' 应被拒绝');
  }
  for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(address), false, address + ' 应放行');
  }
});

test('isBlockedAddress：非 IP 文本与畸形 IP 一律拒绝', () => {
  for (const value of ['', 'localhost', 'not-an-ip', '256.1.1.1', '1.2.3', '[::1]', null, undefined, {}]) {
    assert.equal(isBlockedAddress(value), true, String(value) + ' 应被拒绝');
  }
  // 方括号包裹的 IPv6 字面量会被去除方括号后判定
  assert.equal(isBlockedAddress('[::1]'), true);
});

test('assertAllowedUpstream：内网 / 回环 / 元数据 / 数字主机名抛出 UPSTREAM_BLOCKED', async () => {
  await withEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_UPSTREAM: undefined }, async () => {
    const blockedUrls = [
      'http://127.0.0.1:8080/v1',
      'http://localhost:3000/v1',
      'http://localhost./v1',
      'http://[::1]/v1',
      'http://10.0.0.5/v1',
      'http://172.16.8.8/v1',
      'http://192.168.1.10/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://[fc00::1]/v1',
      'http://[fe80::1]/v1',
      'http://2130706433/v1',
      'http://0x7f000001/v1',
      'not-a-url',
    ];
    for (const url of blockedUrls) {
      await assert.rejects(assertAllowedUpstream(url), assertBlockedError, '应拒绝：' + url);
    }
  });
});

test('assertAllowedUpstream：公网 IP 字面量放行', async () => {
  await withEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_UPSTREAM: undefined }, async () => {
    await assert.doesNotReject(assertAllowedUpstream('http://8.8.8.8/v1'));
    await assert.doesNotReject(assertAllowedUpstream('https://93.184.216.34:8443/v1'));
    await assert.doesNotReject(assertAllowedUpstream('https://[2606:4700:4700::1111]/v1'));
  });
});

test('ALLOW_PRIVATE_UPSTREAM=1 时开发环境放行内网地址，测试后恢复', async () => {
  await withEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_UPSTREAM: '1' }, async () => {
    assert.equal(isPrivateUpstreamAllowed(), true);
    await assert.doesNotReject(assertAllowedUpstream('http://127.0.0.1:3100/v1'));
    await assert.doesNotReject(assertAllowedUpstream('http://localhost:3100/v1'));
    await assert.doesNotReject(assertAllowedUpstream('http://10.0.0.5/v1'));
  });
  // 恢复后重新拦截
  await withEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_UPSTREAM: undefined }, async () => {
    assert.equal(isPrivateUpstreamAllowed(), false);
    await assert.rejects(assertAllowedUpstream('http://127.0.0.1:3100/v1'), assertBlockedError);
  });
});

test('生产环境强制忽略 ALLOW_PRIVATE_UPSTREAM', async () => {
  await withEnv({ NODE_ENV: 'production', ALLOW_PRIVATE_UPSTREAM: '1' }, async () => {
    assert.equal(isPrivateUpstreamAllowed(), false);
    await assert.rejects(assertAllowedUpstream('http://127.0.0.1:3100/v1'), assertBlockedError);
  });
});

test('ALLOW_PRIVATE_UPSTREAM=0/false/空 时不放行', async () => {
  for (const value of ['0', 'false', '', 'yes-ish']) {
    await withEnv({ NODE_ENV: 'development', ALLOW_PRIVATE_UPSTREAM: value }, async () => {
      assert.equal(isPrivateUpstreamAllowed(), false);
      await assert.rejects(assertAllowedUpstream('http://127.0.0.1/v1'), assertBlockedError);
    });
  }
});
