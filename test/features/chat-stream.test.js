'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { streamChatCompletion } = require('../../server/services/chat-client');

const ENV_KEYS = ['NODE_ENV', 'ALLOW_PRIVATE_UPSTREAM', 'CHAT_STREAM_IDLE_TIMEOUT_MS'];

function snapshotEnv() {
  const saved = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

function allowLocalUpstream() {
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_PRIVATE_UPSTREAM = '1';
}

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, baseUrl: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    const timer = setTimeout(resolve, 1000);
    if (typeof timer.unref === 'function') timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function chatArgs(baseUrl, onDelta) {
  return {
    baseUrl,
    apiKey: 'test-key',
    modelId: 'test-model',
    messages: [{ role: 'user', content: '你好' }],
    onDelta,
  };
}

test('上游 302 重定向：拒绝跟随并返回含"重定向"的错误', async () => {
  const saved = snapshotEnv();
  allowLocalUpstream();
  const started = await startServer((req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:1/redirected' });
    res.end();
  });
  try {
    const result = await streamChatCompletion(chatArgs(started.baseUrl));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UPSTREAM_ERROR');
    assert.match(result.message, /重定向/);
  } finally {
    await stopServer(started.server);
    restoreEnv(saved);
  }
});

test('上游建立连接后静默：CHAT_STREAM_IDLE_TIMEOUT_MS 触发空闲超时', async () => {
  const saved = snapshotEnv();
  allowLocalUpstream();
  process.env.CHAT_STREAM_IDLE_TIMEOUT_MS = '250';
  const started = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    // 故意不写任何数据，保持连接打开
  });
  try {
    const begin = Date.now();
    const result = await streamChatCompletion(chatArgs(started.baseUrl));
    const elapsed = Date.now() - begin;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'UPSTREAM_ERROR');
    assert.match(result.message, /长时间没有返回数据/);
    assert.ok(elapsed >= 150, '不应早于空闲超时触发（实际 ' + elapsed + 'ms）');
    assert.ok(elapsed < 3000, '应远早于 10 秒建连超时（实际 ' + elapsed + 'ms）');
  } finally {
    await stopServer(started.server);
    restoreEnv(saved);
  }
});

test('正常 SSE 流：两帧增量 + [DONE] 拼接为完整内容', async () => {
  const saved = snapshotEnv();
  allowLocalUpstream();
  const frames = [
    'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const started = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(frames[0]);
    setTimeout(() => {
      try {
        res.write(frames[1]);
        res.write(frames[2]);
        res.end();
      } catch {
        /* 客户端可能已断开 */
      }
    }, 10).unref?.();
  });
  try {
    const deltas = [];
    const result = await streamChatCompletion(chatArgs(started.baseUrl, (delta) => deltas.push(delta)));
    assert.equal(result.ok, true, '应为成功：' + result.message);
    assert.equal(result.content, '你好');
    assert.deepEqual(deltas, ['你', '好']);
    assert.equal(result.aborted, false);
  } finally {
    await stopServer(started.server);
    restoreEnv(saved);
  }
});
