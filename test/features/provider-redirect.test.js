'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { fetchModels } = require('../../server/services/provider-client');

const ENV_KEYS = ['NODE_ENV', 'ALLOW_PRIVATE_UPSTREAM'];

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

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: 'http://127.0.0.1:' + server.address().port });
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

test('fetchModels：上游 302 重定向被拒绝，message 含"重定向"', async () => {
  const saved = snapshotEnv();
  process.env.NODE_ENV = 'development';
  process.env.ALLOW_PRIVATE_UPSTREAM = '1';
  const started = await startServer((req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:1/models' });
    res.end();
  });
  try {
    const result = await fetchModels(started.baseUrl + '/v1', 'test-key');
    assert.equal(result.ok, false);
    assert.equal(result.models.length, 0);
    assert.match(result.message, /重定向/);
  } finally {
    await stopServer(started.server);
    restoreEnv(saved);
  }
});
