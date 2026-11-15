'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after, beforeEach } = require('node:test');

const { installTestDatabase } = require('../helpers/temp-db');

// 数据库相关模块必须在 installTestDatabase() 之后再 require
let temp;
let db;
let store;

function unique(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function insertUser(username) {
  const info = await db
    .prepare(
      "INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, 'x', ?, 'user', 'active', ?) RETURNING id"
    )
    .run(username, username, new Date().toISOString());
  return Number(info.rows[0].id);
}

async function insertProvider() {
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      "INSERT INTO api_providers (name, base_url, api_key_encrypted, api_type, enabled, created_at, updated_at) VALUES (?, ?, 'v1:aa:bb:cc', 'openai-compatible', 1, ?, ?) RETURNING id"
    )
    .run(unique('provider'), 'https://upstream.example.com/v1', now, now);
  return Number(info.rows[0].id);
}

async function insertModel(providerId, modelId, options = {}) {
  const { displayName = null, enabled = 1, isDefault = 0 } = options;
  const now = new Date().toISOString();
  const info = await db
    .prepare(
      'INSERT INTO models (provider_id, model_id, display_name, enabled, is_default, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
    )
    .run(providerId, modelId, displayName, enabled, isDefault, 'available', now);
  return Number(info.rows[0].id);
}

async function insertConversation(userId, title, updatedAt = new Date().toISOString()) {
  const now = new Date().toISOString();
  const info = await db
    .prepare('INSERT INTO conversations (user_id, title, model_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?) RETURNING id')
    .run(userId, title, now, updatedAt);
  return Number(info.rows[0].id);
}

before(async () => {
  temp = await installTestDatabase('chenlong_test_chat_');
  const initModule = require('../../server/database/init');
  const dbModule = require('../../server/database/db');
  db = dbModule.getDb();
  store = require('../../server/services/chat-store');

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await initModule.initDatabase(); // 临时库建表 + 播种默认设置（无 ADMIN_* 时跳过管理员）
  } finally {
    console.warn = originalWarn;
  }
});

beforeEach(async () => {
  await db
    .prepare('TRUNCATE messages, conversations, models, api_providers, users RESTART IDENTITY CASCADE')
    .run();
});

after(async () => {
  if (temp) await temp.cleanup();
});

test('resolveModel：按内部 id 返回指定模型', async () => {
  const providerId = await insertProvider();
  const modelA = await insertModel(providerId, 'model-a', { displayName: '模型 A', enabled: 0 });
  const modelB = await insertModel(providerId, 'model-b', { displayName: '模型 B', isDefault: 1 });

  const result = await store.resolveModel(String(modelB));
  assert.equal(result.ok, true);
  assert.equal(Number(result.model.id), modelB);
  assert.equal(result.model.model_id, 'model-b');
  assert.equal(result.model.display_name, '模型 B');
  assert.equal(result.model.provider_name.startsWith('provider_'), true);
  assert.notEqual(Number(result.model.id), modelA);
});

test('resolveModel：禁用 / 不存在 / 畸形 id 返回 MODEL_NOT_AVAILABLE', async () => {
  const providerId = await insertProvider();
  const disabledId = await insertModel(providerId, 'model-disabled', { enabled: 0 });

  for (const raw of [String(disabledId), '999999', 'abc', '-1', '1.5', '12abc']) {
    const result = await store.resolveModel(raw);
    assert.equal(result.ok, false, '应拒绝：' + raw);
    assert.equal(result.code, 'MODEL_NOT_AVAILABLE');
    assert.equal(typeof result.message, 'string');
  }
});

test('resolveModel：未传 modelId 时取默认启用模型；无可用模型时报 NO_AVAILABLE_MODEL', async () => {
  assert.equal((await store.resolveModel()).code, 'NO_AVAILABLE_MODEL');

  const providerId = await insertProvider();
  await insertModel(providerId, 'plain-model', { enabled: 0 });
  assert.equal((await store.resolveModel(undefined)).code, 'NO_AVAILABLE_MODEL');

  await insertModel(providerId, 'normal-model', { displayName: '普通', enabled: 1 });
  const defaultId = await insertModel(providerId, 'default-model', { displayName: '默认', isDefault: 1 });

  for (const raw of [undefined, null, '', '0', 0, '   ']) {
    const result = await store.resolveModel(raw);
    assert.equal(result.ok, true, '空 id 应取默认模型：' + String(raw));
    assert.equal(Number(result.model.id), defaultId);
  }

  const models = await store.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].isDefault, true, '默认模型应排在前面');
  assert.equal(models[0].modelId, 'default-model');
});

test('conversationHistory：system 提示 + 最近 N 条消息，按时间正序', async () => {
  const userId = await insertUser(unique('user'));
  const conversationId = await insertConversation(userId, '历史测试');

  for (let index = 0; index < 25; index += 1) {
    await store.appendMessage(conversationId, index % 2 === 0 ? 'user' : 'assistant', 'm' + index);
  }

  const history = await store.conversationHistory(conversationId);
  assert.equal(history.length, store.HISTORY_LIMIT + 1);
  assert.deepEqual(history[0], { role: 'system', content: store.SYSTEM_PROMPT });
  assert.equal(history[1].content, 'm5');
  assert.equal(history[history.length - 1].content, 'm24');
  const contents = history.slice(1).map((item) => item.content);
  assert.deepEqual(contents, Array.from({ length: 20 }, (_, index) => 'm' + (index + 5)));

  const limited = await store.conversationHistory(conversationId, 3);
  assert.equal(limited.length, 4);
  assert.deepEqual(limited.slice(1).map((item) => item.content), ['m22', 'm23', 'm24']);

  const empty = await store.conversationHistory(await insertConversation(userId, '空会话'));
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
  const emojiTitle = store.autoTitle('😀'.repeat(25));
  assert.equal(Array.from(emojiTitle).length, 20);

  for (const empty of ['', '   ', '\r\n\n', null, undefined]) {
    assert.equal(store.autoTitle(empty), store.TITLE_DEFAULT);
  }
});

test('listConversations：只返回本人、关键词 LIKE 转义 % 与 _、按 updated_at 倒序', async () => {
  const alice = await insertUser(unique('alice'));
  const bob = await insertUser(unique('bob'));

  const older = await insertConversation(alice, 'hello world', '2026-01-01T00:00:00.000Z');
  const percent = await insertConversation(alice, '100% pure', '2026-01-02T00:00:00.000Z');
  const underscore = await insertConversation(alice, 'a_b title', '2026-01-03T00:00:00.000Z');
  await insertConversation(alice, '100X pure', '2026-01-04T00:00:00.000Z');
  await insertConversation(alice, 'axb title', '2026-01-05T00:00:00.000Z');
  const bobConversation = await insertConversation(bob, 'hello world', '2026-01-06T00:00:00.000Z');

  const all = await store.listConversations(alice);
  assert.equal(all.length, 5);
  assert.equal(all.some((item) => Number(item.id) === bobConversation), false);
  assert.deepEqual(
    all.map((item) => item.title),
    ['axb title', '100X pure', 'a_b title', '100% pure', 'hello world']
  );
  assert.equal(Number(all[0].messageCount), 0);

  const byPercent = await store.listConversations(alice, '%');
  assert.deepEqual(byPercent.map((item) => Number(item.id)), [percent]);

  const byUnderscore = await store.listConversations(alice, '_');
  assert.deepEqual(byUnderscore.map((item) => Number(item.id)), [underscore]);

  const hello = await store.listConversations(alice, '  hello  ');
  assert.deepEqual(hello.map((item) => Number(item.id)), [older]);
  // PostgreSQL LIKE 大小写敏感（与 SQLite 不同）
  assert.equal((await store.listConversations(alice, 'HELLO')).length, 0);

  const emptyKeyword = await store.listConversations(alice, '   ');
  assert.equal(emptyKeyword.length, 5);
  assert.equal((await store.listConversations(alice, null)).length, 5);
});

test('会话 CRUD：create / listMessages / rename / delete 均为异步', async () => {
  const userId = await insertUser(unique('crud'));

  const created = await store.createConversation(userId, { title: 'CRUD 会话' });
  assert.equal(created.title, 'CRUD 会话');
  assert.equal(Number(created.messageCount), 0);

  const appended = await store.appendMessage(created.id, 'user', '你好');
  assert.ok(Number.isInteger(appended.id) && appended.id > 0);
  assert.equal(typeof appended.createdAt, 'string');

  const messages = await store.listMessages(created.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '你好');

  const renamed = await store.renameConversation(userId, created.id, '改名后');
  assert.equal(renamed.title, '改名后');
  const found = await store.findConversation(userId, created.id);
  assert.equal(Number(found.id), Number(created.id));

  assert.equal(await store.deleteConversation(userId, created.id), true);
  assert.equal(await store.findConversation(userId, created.id), null);
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
