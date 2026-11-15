const dns = require('node:dns').promises;
const net = require('node:net');

const BLOCKED_CODE = 'UPSTREAM_BLOCKED';
const BLOCKED_MESSAGE = '该地址指向内网或保留地址，已拒绝';

// 内网、云元数据、回环、保留与组播网段
const BLOCKED_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_V6 = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

function blockedError() {
  const err = new Error(BLOCKED_MESSAGE);
  err.code = BLOCKED_CODE;
  return err;
}

// 开发环境放行内网：生产强制忽略该开关
function isPrivateUpstreamAllowed() {
  if (process.env.NODE_ENV === 'production') return false;
  const raw = String(process.env.ALLOW_PRIVATE_UPSTREAM || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function parseIpv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

function inIpv4Range(value, base, bits) {
  const baseValue = parseIpv4(base);
  if (baseValue === null) return false;
  const size = 2 ** (32 - bits);
  return value >= baseValue && value < baseValue + size;
}

// 返回 { value: BigInt, v4Tail: number|null }，v4Tail 用于 ::ffff:1.2.3.4 这类内嵌 IPv4
function parseIpv6(text) {
  let raw = String(text).split('%')[0].toLowerCase();
  let v4Tail = null;

  const lastColon = raw.lastIndexOf(':');
  const tail = raw.slice(lastColon + 1);
  if (tail.includes('.')) {
    v4Tail = parseIpv4(tail);
    if (v4Tail === null) return null;
    raw = raw.slice(0, lastColon + 1) + '0:0';
  }

  const firstDouble = raw.indexOf('::');
  if (firstDouble !== -1 && raw.indexOf('::', firstDouble + 1) !== -1) return null;

  const head = firstDouble === -1 ? raw : raw.slice(0, firstDouble);
  const rest = firstDouble === -1 ? null : raw.slice(firstDouble + 2);
  const headParts = head ? head.split(':') : [];
  const restParts = rest ? rest.split(':') : [];

  let groups;
  if (rest === null) {
    groups = headParts;
    if (groups.length !== 8) return null;
  } else {
    if (headParts.length + restParts.length > 7) return null;
    const zeros = new Array(8 - headParts.length - restParts.length).fill('0');
    groups = [...headParts, ...zeros, ...restParts];
  }

  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return { value, v4Tail };
}

function isBlockedIpv4(value) {
  if (value === null) return true;
  return BLOCKED_V4.some(([base, bits]) => inIpv4Range(value, base, bits));
}

function isBlockedIpv6(parsed) {
  if (!parsed) return true;
  if (parsed.v4Tail !== null) return isBlockedIpv4(parsed.v4Tail);
  return BLOCKED_V6.some(([base, bits]) => {
    const baseParsed = parseIpv6(base);
    if (!baseParsed) return false;
    const shift = BigInt(128 - bits);
    return parsed.value >> shift === baseParsed.value >> shift;
  });
}

function isBlockedAddress(raw) {
  const address = String(raw || '').trim().replace(/^\[|\]$/g, '');
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(parseIpv4(address));
  if (family === 6) return isBlockedIpv6(parseIpv6(address));
  return true;
}

/**
 * 校验上游地址不属于内网 / 保留地址；不通过时抛出 code=UPSTREAM_BLOCKED 的错误。
 */
async function assertAllowedUpstream(baseUrl) {
  if (isPrivateUpstreamAllowed()) return true;

  let parsed;
  try {
    parsed = new URL(String(baseUrl));
  } catch {
    throw blockedError();
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw blockedError();

  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) throw blockedError();
    return true;
  }

  if (host === 'localhost' || host.endsWith('.localhost')) throw blockedError();
  // 纯数字 / 十六进制主机名等价于 IPv4 字面量，不同解析器可能直接换算成内网地址
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) throw blockedError();

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (err) {
    // 域名解析不了时真实请求同样会失败，交给上游错误路径处理，不按 SSRF 拦截
    console.warn('[upstream-guard] 域名解析失败：', host, err && err.code ? err.code : '');
    return true;
  }

  if (!Array.isArray(records) || records.length === 0) throw blockedError();
  for (const record of records) {
    if (isBlockedAddress(record.address)) throw blockedError();
  }
  return true;
}

module.exports = {
  assertAllowedUpstream,
  isBlockedAddress,
  isPrivateUpstreamAllowed,
  BLOCKED_CODE,
  BLOCKED_MESSAGE,
};
