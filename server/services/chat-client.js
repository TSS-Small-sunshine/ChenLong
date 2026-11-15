const { normalizeBaseUrl, REQUEST_TIMEOUT_MS } = require('./provider-client');
const { assertAllowedUpstream } = require('./upstream-guard');

const CONNECT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
const TIMEOUT_MESSAGE = '连接超时（10 秒）';
const CONNECT_FAILED_MESSAGE = '无法连接该地址，请检查 Base URL 与网络';
const BROKEN_MESSAGE = '上游连接中断，请稍后再试';
const EMPTY_MESSAGE = '上游未返回内容';
const REDIRECT_MESSAGE = '上游地址发生了重定向，出于安全考虑已拒绝，请直接填写最终地址';
const RAW_KEEP_MAX = 200 * 1024;
// 流空闲超时：建连成功后，上游超过该时长没有吐出任何数据即中断（可用环境变量覆盖，便于测试与调优）
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;
const IDLE_TIMEOUT_MESSAGE = '上游长时间没有返回数据，已中断';

function resolveIdleTimeoutMs() {
  const raw = Number(process.env.CHAT_STREAM_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_IDLE_TIMEOUT_MS;
}

function isRedirectError(err) {
  const texts = [err && err.message, err && err.cause && err.cause.message, err && err.code, err && err.cause && err.cause.code]
    .filter((item) => typeof item === 'string')
    .join(' ');
  return /redirect/i.test(texts);
}

function httpErrorMessage(status) {
  if (status === 401 || status === 403) return '密钥无效或无权限';
  if (status === 404) return '接口地址不存在，请检查 Base URL';
  if (status === 429) return '上游限流，请稍后再试';
  if (status >= 500 && status < 600) return `上游服务异常（HTTP ${status}）`;
  return `上游返回错误（HTTP ${status}）`;
}

function contentFromPayload(payload) {
  if (!payload || !Array.isArray(payload.choices) || payload.choices.length === 0) return '';
  const choice = payload.choices[0] || {};
  if (choice.delta && typeof choice.delta.content === 'string') return choice.delta.content;
  if (choice.message && typeof choice.message.content === 'string') return choice.message.content;
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

function errorFromPayload(payload) {
  const error = payload && payload.error;
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  if (Array.isArray(error.messages) && error.messages[0] && typeof error.messages[0].message === 'string') {
    return error.messages[0].message;
  }
  return '上游返回错误';
}

function tryParseJsonObject(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function createSseParser(onData) {
  let buffer = '';
  let stopped = false;

  function handleLine(rawLine) {
    if (stopped) return;
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      stopped = true;
      return;
    }
    if (onData(payload) === false) stopped = true;
  }

  return {
    push(text) {
      if (stopped) return;
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index >= 0 && !stopped) {
        handleLine(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    },
    flush() {
      if (stopped) return;
      const rest = buffer;
      buffer = '';
      if (rest.trim()) handleLine(rest);
    },
    get stopped() {
      return stopped;
    },
  };
}

async function streamChatCompletion({ baseUrl, apiKey, modelId, messages, signal, onDelta }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base.ok) return { ok: false, content: '', aborted: false, code: 'UPSTREAM_ERROR', message: base.message };

  try {
    await assertAllowedUpstream(base.value);
  } catch (err) {
    if (err && err.code === 'UPSTREAM_BLOCKED') {
      console.warn('[chat-client] 上游地址被安全策略拒绝');
      return { ok: false, content: '', aborted: false, code: 'UPSTREAM_ERROR', message: err.message };
    }
    throw err;
  }

  const url = `${base.value}/chat/completions`;
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const connectTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  if (typeof connectTimer.unref === 'function') connectTimer.unref();

  const abortedByCaller = () => Boolean(signal && signal.aborted);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages, stream: true }),
      signal: controller.signal,
      // SSRF 防护：不跟随重定向，避免公网地址 302 到内网/回环地址
      redirect: 'error',
    });
  } catch (err) {
    clearTimeout(connectTimer);
    if (abortedByCaller()) return { ok: false, content: '', aborted: true, code: 'ABORTED', message: '请求已中断' };
    const timeout = timedOut || (err && (err.name === 'TimeoutError' || err.name === 'AbortError'));
    const redirected = isRedirectError(err);
    const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
    console.error('[chat-client] 请求上游失败：', { url, timeout, redirected, code });
    const message = timeout ? TIMEOUT_MESSAGE : redirected ? REDIRECT_MESSAGE : CONNECT_FAILED_MESSAGE;
    return { ok: false, content: '', aborted: false, code: 'UPSTREAM_ERROR', message };
  }
  clearTimeout(connectTimer);

  if (!response.ok) {
    let detail = '';
    try {
      detail = String(await response.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    console.error('[chat-client] 上游返回非 2xx：', { url, status: response.status, detail });
    return { ok: false, content: '', aborted: false, code: 'UPSTREAM_ERROR', message: httpErrorMessage(response.status) };
  }

  let content = '';
  let upstreamError = '';
  let rawText = '';

  // 流空闲超时：建连成功后，上游长时间不吐字就主动中断，避免请求无限挂起
  const idleTimeoutMs = resolveIdleTimeoutMs();
  let idleTimer = null;
  let idleTimedOut = false;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const parser = createSseParser((payload) => {
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return undefined;
    }
    const failure = errorFromPayload(data);
    if (failure) {
      upstreamError = failure;
      return false;
    }
    const delta = contentFromPayload(data);
    if (delta) {
      content += delta;
      if (onDelta) onDelta(delta);
    }
    return undefined;
  });

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    // 开始等待上游首个数据块前就启动超时，每次收到数据后重置
    armIdleTimer();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (rawText.length < RAW_KEEP_MAX) rawText += text;
      parser.push(text);
      armIdleTimer();
      if (parser.stopped) {
        try {
          await reader.cancel();
        } catch {
          /* 已经结束的流无需再取消 */
        }
        break;
      }
    }
    parser.flush();
  } catch (err) {
    if (abortedByCaller()) return { ok: false, content, aborted: true, code: 'ABORTED', message: '请求已中断' };
    if (idleTimedOut) {
      console.error('[chat-client] 上游流空闲超时：', { url, idleTimeoutMs, received: content.length });
      return {
        ok: false,
        content,
        aborted: false,
        code: 'UPSTREAM_ERROR',
        message:
          IDLE_TIMEOUT_MESSAGE +
          '（' + (idleTimeoutMs >= 1000 ? Math.round(idleTimeoutMs / 1000) + ' 秒' : idleTimeoutMs + ' 毫秒') + '无数据）',
      };
    }
    console.error('[chat-client] 读取上游流失败：', err && err.message);
    return { ok: false, content, aborted: false, code: 'UPSTREAM_ERROR', message: BROKEN_MESSAGE };
  } finally {
    clearIdleTimer();
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }

  if (upstreamError) return { ok: false, content, aborted: false, code: 'UPSTREAM_ERROR', message: upstreamError };

  if (!content) {
    const payload = tryParseJsonObject(rawText);
    const whole = payload ? contentFromPayload(payload) : '';
    const failure = payload ? errorFromPayload(payload) : '';
    if (failure) return { ok: false, content: '', aborted: false, code: 'UPSTREAM_ERROR', message: failure };
    if (whole) {
      content = whole;
      if (onDelta) onDelta(whole);
    }
  }

  if (!content) return { ok: false, content: '', aborted: false, code: 'UPSTREAM_ERROR', message: EMPTY_MESSAGE };
  return { ok: true, content, aborted: false, code: '', message: '' };
}

module.exports = { CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, httpErrorMessage, createSseParser, streamChatCompletion };
