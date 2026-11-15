const { assertAllowedUpstream } = require('./upstream-guard');

const REQUEST_TIMEOUT_MS = 10000;
const TIMEOUT_MESSAGE = '连接超时（10 秒）';
const CONNECT_FAILED_MESSAGE = '无法连接该地址，请检查 Base URL 与网络';
const REDIRECT_MESSAGE = '上游地址发生了重定向，出于安全考虑已拒绝，请直接填写最终地址';

// 上游发生重定向时 fetch 抛出的错误信息不统一，这里做兼容识别
function isRedirectError(err) {
  const texts = [err && err.message, err && err.cause && err.cause.message, err && err.code, err && err.cause && err.cause.code]
    .filter((item) => typeof item === 'string')
    .join(' ');
  return /redirect/i.test(texts);
}

function normalizeBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, message: '请输入 Base URL' };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: 'Base URL 格式不正确，请填写完整地址（含 http:// 或 https://）' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Base URL 仅支持 http:// 或 https://' };
  }
  return { ok: true, value: value.replace(/\/+$/, '') };
}

function modelUrls(base) {
  const trimmed = base.replace(/\/+$/, '');
  const urls = [`${trimmed}/models`];
  if (!/\/v1$/i.test(trimmed)) urls.push(`${trimmed}/v1/models`);
  return urls;
}

function httpErrorMessage(status) {
  if (status === 401 || status === 403) return '密钥无效或无权限';
  if (status === 404) return '接口地址不存在，请检查 Base URL';
  if (status === 429) return '上游限流，请稍后再试';
  if (status >= 500 && status < 600) return `上游服务异常（HTTP ${status}）`;
  return `上游返回错误（HTTP ${status}）`;
}

function extractModelIds(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload && payload.data) ? payload.data : [];
  const ids = new Set();
  for (const entry of list) {
    const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id) ids.add(id);
  }
  return [...ids];
}

async function requestModels(url, apiKey) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // SSRF 防护：不跟随重定向，避免公网地址 302 到内网/回环地址
      redirect: 'error',
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const redirected = isRedirectError(err);
    const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
    console.error('[provider-client] 请求上游失败：', { url, timeout, redirected, code });
    const message = timeout ? TIMEOUT_MESSAGE : redirected ? REDIRECT_MESSAGE : CONNECT_FAILED_MESSAGE;
    return { ok: false, status: 0, latencyMs: Date.now() - startedAt, message };
  }

  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    console.error('[provider-client] 上游返回非 2xx：', { url, status: response.status });
    return { ok: false, status: response.status, latencyMs, message: httpErrorMessage(response.status) };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.error('[provider-client] 上游响应不是合法 JSON：', { url, status: response.status });
    return { ok: false, status: response.status, latencyMs, message: '上游返回的内容不是合法 JSON' };
  }

  return { ok: true, status: response.status, latencyMs, models: extractModelIds(payload) };
}

async function fetchModels(baseUrl, apiKey) {
  const startedAt = Date.now();
  const base = normalizeBaseUrl(baseUrl);
  if (!base.ok) return { ok: false, models: [], latencyMs: 0, message: base.message };

  try {
    await assertAllowedUpstream(base.value);
  } catch (err) {
    if (err && err.code === 'UPSTREAM_BLOCKED') {
      console.warn('[provider-client] 上游地址被安全策略拒绝');
      return { ok: false, models: [], latencyMs: Date.now() - startedAt, message: err.message };
    }
    throw err;
  }

  const urls = modelUrls(base.value);
  let last = null;
  for (let index = 0; index < urls.length; index += 1) {
    last = await requestModels(urls[index], apiKey);
    if (last.ok) return { ok: true, models: last.models, latencyMs: Date.now() - startedAt, message: '' };
    if (last.status !== 404 || index === urls.length - 1) break;
  }

  return { ok: false, models: [], latencyMs: Date.now() - startedAt, message: last.message };
}

module.exports = { REQUEST_TIMEOUT_MS, normalizeBaseUrl, modelUrls, fetchModels };
