'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSseParser,
  httpErrorMessage,
} = require('../../server/services/chat-client');

test('createSseParser：跨 chunk 的 data 行会拼接后再回调', () => {
  const payloads = [];
  const parser = createSseParser((payload) => {
    payloads.push(payload);
  });
  assert.equal(parser.stopped, false);

  parser.push('event: message\ndata: {"choices":[{"delta":{"content":"你"}}]}\n\n');
  parser.push('data: {"cho');
  parser.push('ices":[{"delta":{"content":"好"}}]}\n\n');

  assert.deepEqual(payloads, [
    '{"choices":[{"delta":{"content":"你"}}]}',
    '{"choices":[{"delta":{"content":"好"}}]}',
  ]);
  const deltas = payloads.map((payload) => JSON.parse(payload).choices[0].delta.content);
  assert.deepEqual(deltas, ['你', '好']);
});

test('createSseParser：只处理 data: 行，忽略注释 / 事件名 / id / 空行', () => {
  const payloads = [];
  const parser = createSseParser((payload) => {
    payloads.push(payload);
  });
  parser.push(': keep-alive\n\n');
  parser.push('event: message\nid: 42\nretry: 1000\n\n');
  parser.push('data: {"ok":true}\r\n\r\n');
  parser.push('data:\n\ndata:   \n\n');

  assert.deepEqual(payloads, ['{"ok":true}']);
});

test('createSseParser：收到 [DONE] 后停止，后续数据不再回调', () => {
  const payloads = [];
  const parser = createSseParser((payload) => {
    payloads.push(payload);
  });
  parser.push('data: {"first":1}\n\ndata: [DONE]\n\ndata: {"second":2}\n\n');
  assert.deepEqual(payloads, ['{"first":1}']);
  assert.equal(parser.stopped, true);

  parser.push('data: {"third":3}\n\n');
  parser.flush();
  assert.deepEqual(payloads, ['{"first":1}']);
});

test('createSseParser：flush 处理没有结尾换行的最后一行', () => {
  const payloads = [];
  const parser = createSseParser((payload) => {
    payloads.push(payload);
  });
  parser.push('data: {"tail":true}');
  assert.deepEqual(payloads, []);
  parser.flush();
  assert.deepEqual(payloads, ['{"tail":true}']);
  // flush 后状态正常，可继续追加（真实场景通常在流结束时才 flush）
  assert.equal(parser.stopped, false);
});

test('createSseParser：onData 返回 false 立即停止（错误帧场景）', () => {
  const payloads = [];
  const parser = createSseParser((payload) => {
    payloads.push(payload);
    return false;
  });
  parser.push('data: {"error":{"message":"boom"}}\n\ndata: {"ignored":true}\n\n');
  assert.deepEqual(payloads, ['{"error":{"message":"boom"}}']);
  assert.equal(parser.stopped, true);
});

test('createSseParser：JSON 解析回调可安全忽略非法 JSON 并继续处理', () => {
  const contents = [];
  const parser = createSseParser((payload) => {
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      return undefined;
    }
    const delta = data.choices && data.choices[0] && data.choices[0].delta;
    if (delta && typeof delta.content === 'string') contents.push(delta.content);
    return undefined;
  });
  parser.push('data: not-json\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
  parser.push('data: {broken\n\n');
  parser.push('data: {"choices":[{"delta":{"content":"!"}}]}\n\n');
  assert.deepEqual(contents, ['ok', '!']);
});

test('httpErrorMessage：常见上游状态码映射', () => {
  assert.equal(httpErrorMessage(401), '密钥无效或无权限');
  assert.equal(httpErrorMessage(403), '密钥无效或无权限');
  assert.equal(httpErrorMessage(404), '接口地址不存在，请检查 Base URL');
  assert.equal(httpErrorMessage(429), '上游限流，请稍后再试');
  assert.equal(httpErrorMessage(500), '上游服务异常（HTTP 500）');
  assert.equal(httpErrorMessage(503), '上游服务异常（HTTP 503）');
  assert.equal(httpErrorMessage(400), '上游返回错误（HTTP 400）');
});
