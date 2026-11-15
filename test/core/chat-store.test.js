'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after, beforeEach } = require('node:test');

const { installTempDatabase } = require('../helpers/temp-db');

// 关键：先设置 DB_PATH 指向临时库，再 require 会读取数据库的模块
const temp = installTempDatabase('chenlong-chat-store-');
const { initDatabase } = require('../../server/database/init');
const { getDb, closeDb } = require('../../server/database/db');
const store = require('../../server/services/chat-store');

let db;
let seq = 0;

function unique(prefix) {
  seq += 1;
  return prefix + '_' + String(seq).padStart(4, '0') + '_' + Math.random().toString(36).slice(2, 8);
}

function insertUser(username) {
  const info = db
    .prepare(
      "INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'x', ?, 'user', 'active', ?)"
    )
    .run(username, username, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function insertProvider() {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      "INSERT INTO api_providers (name, base_url, api_key_encrypted, api_type, enabled, created_at, updated_at) VALUES (?, ?, 'v1:aa:bb:cc', 'openai-compatible', 1, ?, ?)"
    )
    .run(unique('provider'), 'https://upstream.example.com/v1', now, now);
  return Number(info.lastInsertRowid);
}

function insertModel(providerId, modelId, options = {}) {
  const { displayName = null, enabled = 1, isDefault = 0 } = options;
  const now = new Date().toISOString();
  const info = db
    .prepare(
      'INSERT INTO models (provider_id, model_id, display_name, enabled, is_default, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(providerId, modelId, displayName, enabled, isDefault, 'available', now);
  return Number(info.lastInsertRowid);
}

function insertConversation(userId, title, updatedAt = new Date().toISOString()) {
  const now = new Date().toISOString();
  const info = db
    .prepare('INSERT INTO conversations (user_id, title, model_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)')
    .run(userId, title, now, updatedAt);
  return Number(info.lastInsertRowid);
}

before(() => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    initDatabase(); // 临时库建表 + 播种默认设置；无 ADMIN_* 时跳过管理员
  } finally {
    console.warn = originalWarn;
  }
  db = getDb();
});

beforeEach(() => {
  db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM models; DELETE FROM api_providers; DELETE FROM users;');
});

after(() => {
  closeDb();
  temp.cleanup();
});

test('resolveModel：按内部 id 返回指定模型', () => {
  const providerId = insertProvider();
  const modelA = insertModel(providerId, 'model-a', { displayName: '模型 A', enabled: 0 });
  const modelB = insertModel(providerId, 'model-b', { displayName: '模型 B', isDefault: 1 });

  const result = store.resolveModel(String(modelB));
  assert.equal(result.ok, true);
  assert.equal(result.model.id, modelB);
  assert.equal(result.model.model_id, 'model-b');
  assert.equal(result.model.display_name, '模型 B');
  assert.equal(result.model.provider_name.startsWith('provider_'), true);
  assert.notEqual(result.model.id, modelA);
});

test('resolveModel：禁用 / 不存在 / 畸形 id 返回 MODEL_NOT_AVAILABLE', () => {
  const providerId = insertProvider();
  const disabledId = insertModel(providerId, 'model-disabled', { enabled: 0 });

  for (const raw of [String(disabledId), '999999', 'abc', '-1', '1.5', '12abc']) {
    const result = store.resolveModel(raw);
    assert.equal(result.ok, false, '应拒绝：' + raw);
    assert.equal(result.code, 'MODEL_NOT_AVAILABLE');
    assert.equal(typeof result.message, 'string');
  }
});

test('resolveModel：未传 modelId 时取默认启用模型；无可用模型时报 NO_AVAILABLE_MODEL', () => {
  assert.equal(store.resolveModel().code, 'NO_AVAILABLE_MODEL');

  const providerId = insertProvider();
  insertModel(providerId, 'plain-model', { enabled: 0 });
  assert.equal(store.resolveModel(undefined).code, 'NO_AVAILABLE_MODEL');

  insertModel(providerId, 'normal-model', { displayName: '普通', enabled: 1 });
  const defaultId = insertModel(providerId, 'default-model', { displayName: '默认', isDefault: 1 });

  for (const raw of [undefined, null, '', '0', 0, '   ']) {
    const result = store.resolveModel(raw);
    assert.equal(result.ok, true, '空 id 应取默认模型：' + String(raw));
    assert.equal(result.model.id, defaultId);
  }
});

test('conversationHistory：system 提示 + 最近 N 条消息，按时间正序', () => {
  const userId = insertUser(unique('user'));
  const conversationId = insertConversation(userId, '历史测试');

  for (let index = 0; index < 25; index += 1) {
    store.appendMessage(conversationId, index % 2 === 0 ? 'user' : 'assistant', 'm' + index);
  }

  const history = store.conversationHistory(conversationId);
  assert.equal(history.length, store.HISTORY_LIMIT + 1);
  assert.deepEqual(history[0], { role: 'system', content: store.SYSTEM_PROMPT });
  assert.equal(history[1].content, 'm5');
  assert.equal(history[history.length - 1].content, 'm24');
  // 严格正序
  const contents = history.slice(1).map((item) => item.content);
  assert.deepEqual(contents, Array.from({ length: 20 }, (_, index) => 'm' + (index + 5)));

  const limited = store.conversationHistory(conversationId, 3);
  assert.equal(limited.length, 4);
  assert.deepEqual(limited.slice(1).map((item) => item.content), ['m22', 'm23', 'm24']);

  const empty = store.conversationHistory(insertConversation(userId, '空会话'));
  assert.deepEqual(empty, [{ role: 'system', content: store.SYSTEM_PROMPT }]);
});

test('autoTitle：去换行、按码位截断 20、空白回退默认标题', () => {
  assert.equal(store.AUTO_TITLE_MAX, 20);
  assert.equal(store.autoTitle('今天天气怎么样'), '今天天气怎么样');
  assert.equal(store.autoTitle('  前后空白  '), '前后空白');
  assert.equal(store.autoTitle('第一行\n第二行\r\n第三行'), '第一行第二行第三行');
  assert.equal(store.autoTitle('a'.repeat(20)), 'a'.repeat(20));
  assert.equal(store.autoTitle('a'.repeat(21)), 'a'.repeat(20));
  assert.equal(store.autoTitle('汉'.repeat(21)), '汉'.repeat(20));
  // 按 Unicode 码位截断，emoji 不会被截成半个代理对
  const emojiTitle = store.autoTitle('😀'.repeat(25));
  assert.equal(Array.from(emojiTitle).length, 20);

  for (const empty of ['', '   ', '\r\n\n', null, undefined]) {
    assert.equal(store.autoTitle(empty), store.TITLE_DEFAULT);
  }
});

test('listConversations：只返回本人、关键词 LIKE 转义 % 与 _、按 updated_at 倒序', () => {
  const alice = insertUser(unique('alice'));
  const bob = insertUser(unique('bob'));

  const older = insertConversation(alice, 'hello world', '2026-01-01T00:00:00.000Z');
  const percent = insertConversation(alice, '100% pure', '2026-01-02T00:00:00.000Z');
  const underscore = insertConversation(alice, 'a_b title', '2026-01-03T00:00:00.000Z');
  insertConversation(alice, '100X pure', '2026-01-04T00:00:00.000Z');
  insertConversation(alice, 'axb title', '2026-01-05T00:00:00.000Z');
  const bobConversation = insertConversation(bob, 'hello world', '2026-01-06T00:00:00.000Z');

  const all = store.listConversations(alice);
  assert.equal(all.length, 5);
  assert.equal(all.some((item) => item.id === bobConversation), false);
  // updated_at 倒序
  assert.deepEqual(
    all.map((item) => item.title),
    ['axb title', '100X pure', 'a_b title', '100% pure', 'hello world']
  );

  const byPercent = store.listConversations(alice, '%');
  assert.deepEqual(byPercent.map((item) => item.id), [percent]);

  const byUnderscore = store.listConversations(alice, '_');
  assert.deepEqual(byUnderscore.map((item) => item.id), [underscore]);

  // 关键词前后空白被 trim
  const hello = store.listConversations(alice, '  hello  ');
  assert.deepEqual(hello.map((item) => item.id), [older]);
  // SQLite LIKE 对 ASCII 大小写不敏感，这是既有行为
  assert.deepEqual(store.listConversations(alice, 'HELLO').map((item) => item.id), [older]);

  const emptyKeyword = store.listConversations(alice, '   ');
  assert.equal(emptyKeyword.length, 5);
  // 非字符串关键词按无关键词处理
  assert.equal(store.listConversations(alice, null).length, 5);
});

test('parseId / isEmptyId / modelName 边界', () => {
  assert.equal(store.parseId('12'), 12);
  assert.equal(store.parseId(12), 12);
  assert.equal(store.parseId('0'), null);
  assert.equal(store.parseId('-1'), null);
  assert.equal(store.parseId('abc'), null);
  assert.equal(store.parseId('1e3'), null);
  assert.equal(store.parseId(''), null);
  assert.equal(store.parseId(null), null);

  assert.equal(store.isEmptyId(undefined), true);
  assert.equal(store.isEmptyId(null), true);
  assert.equal(store.isEmptyId(0), true);
  assert.equal(store.isEmptyId('0'), true);
  assert.equal(store.isEmptyId(''), true);
  assert.equal(store.isEmptyId('   '), true);
  assert.equal(store.isEmptyId('7'), false);
  assert.equal(store.isEmptyId(7), false);

  assert.equal(store.modelName({ display_name: ' 显示名 ', model_id: 'raw-id' }), '显示名');
  assert.equal(store.modelName({ display_name: '   ', model_id: 'raw-id' }), 'raw-id');
  assert.equal(store.modelName({ display_name: null, model_id: 'raw-id' }), 'raw-id');
});
