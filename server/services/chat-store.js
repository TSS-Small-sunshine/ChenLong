const { getDb } = require('../database/db');

const SYSTEM_PROMPT = '你是尘龙，一个温柔、简洁的中文 AI 助手。';
const HISTORY_LIMIT = 20;
const TITLE_DEFAULT = '新的对话';
const TITLE_MAX = 40;
const AUTO_TITLE_MAX = 20;
const MESSAGE_MAX = 4000;
const ROLE_USER = 'user';
const ROLE_ASSISTANT = 'assistant';

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isEmptyId(raw) {
  if (raw === undefined || raw === null || raw === 0 || raw === '0') return true;
  return typeof raw === 'string' && raw.trim() === '';
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => '\\' + match);
}

const SELECT_MODEL = `
  SELECT m.id, m.provider_id, m.model_id, m.display_name, m.enabled, m.is_default,
         p.name AS provider_name, p.base_url, p.api_key_encrypted
  FROM models m
  JOIN api_providers p ON p.id = m.provider_id
`;

const SELECT_CONVERSATION = `
  SELECT c.id, c.title, c.model_id, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM messages msg WHERE msg.conversation_id = c.id) AS message_count,
         m.display_name AS model_display_name, m.model_id AS model_model_id
  FROM conversations c
  LEFT JOIN models m ON m.id = c.model_id
`;

function toModelItem(row) {
  return {
    id: row.id,
    displayName: row.display_name || '',
    modelId: row.model_id,
    providerName: row.provider_name,
    isDefault: row.is_default === 1,
  };
}

function modelName(row) {
  const displayName = row.display_name ? String(row.display_name).trim() : '';
  return displayName || row.model_id;
}

function toConversation(row) {
  const displayName = row.model_display_name ? String(row.model_display_name).trim() : '';
  return {
    id: row.id,
    title: row.title || '',
    modelId: row.model_id === null || row.model_id === undefined ? null : row.model_id,
    modelName: displayName || row.model_model_id || '',
    messageCount: Number(row.message_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listModels() {
  const rows = await getDb()
    .prepare(`${SELECT_MODEL} WHERE m.enabled = 1 ORDER BY m.is_default DESC, m.id ASC`)
    .all();
  return rows.map(toModelItem);
}

async function resolveModel(rawModelId) {
  const db = getDb();
  if (!isEmptyId(rawModelId)) {
    const id = parseId(rawModelId);
    const row = id ? await db.prepare(`${SELECT_MODEL} WHERE m.id = ? AND m.enabled = 1`).get(id) : null;
    if (!row) return { ok: false, code: 'MODEL_NOT_AVAILABLE', message: '该模型不可用，请重新选择' };
    return { ok: true, model: row };
  }
  const row = await db
    .prepare(`${SELECT_MODEL} WHERE m.enabled = 1 ORDER BY m.is_default DESC, m.id ASC LIMIT 1`)
    .get();
  if (!row) {
    return {
      ok: false,
      code: 'NO_AVAILABLE_MODEL',
      message: '还没有可用模型，请先在后台启用并设置默认模型',
    };
  }
  return { ok: true, model: row };
}

async function listConversations(userId, keyword) {
  let where = 'WHERE c.user_id = ?';
  const params = [userId];
  const trimmed = typeof keyword === 'string' ? keyword.trim() : '';
  if (trimmed) {
    where += " AND c.title LIKE ? ESCAPE '\\'";
    params.push(`%${escapeLike(trimmed)}%`);
  }
  const rows = await getDb()
    .prepare(`${SELECT_CONVERSATION} ${where} ORDER BY c.updated_at DESC, c.id DESC`)
    .all(...params);
  return rows.map(toConversation);
}

async function findConversation(userId, id) {
  const row = await getDb()
    .prepare(`${SELECT_CONVERSATION} WHERE c.id = ? AND c.user_id = ?`)
    .get(id, userId);
  return row ? toConversation(row) : null;
}

async function createConversation(userId, { title, modelId }) {
  const db = getDb();
  const now = new Date().toISOString();
  const modelRow = isEmptyId(modelId)
    ? null
    : await db.prepare('SELECT id FROM models WHERE id = ? AND enabled = 1').get(parseId(modelId) || 0);
  const info = await db
    .prepare('INSERT INTO conversations (user_id, title, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .run(userId, title, modelRow ? modelRow.id : null, now, now);
  return findConversation(userId, Number(info.rows[0].id));
}

async function renameConversation(userId, id, title) {
  const info = await getDb()
    .prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?')
    .run(title, id, userId);
  if (info.changes === 0) return null;
  return findConversation(userId, id);
}

async function deleteConversation(userId, id) {
  const info = await getDb().prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

async function listMessages(conversationId) {
  const rows = await getDb()
    .prepare('SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC')
    .all(conversationId);
  return rows.map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at }));
}

async function appendMessage(conversationId, role, content) {
  const now = new Date().toISOString();
  const info = await getDb()
    .prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?) RETURNING id')
    .run(conversationId, role, content, now);
  return { id: Number(info.rows[0].id), createdAt: now };
}

async function conversationHistory(conversationId, limit = HISTORY_LIMIT) {
  const rows = await getDb()
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit);
  rows.reverse();
  return [{ role: 'system', content: SYSTEM_PROMPT }, ...rows.map((row) => ({ role: row.role, content: row.content }))];
}

async function touchConversation(conversationId, modelId) {
  await getDb()
    .prepare('UPDATE conversations SET updated_at = ?, model_id = ? WHERE id = ?')
    .run(new Date().toISOString(), modelId, conversationId);
}

function autoTitle(message) {
  const cleaned = String(message || '')
    .replace(/[\r\n]+/g, '')
    .trim();
  const title = Array.from(cleaned).slice(0, AUTO_TITLE_MAX).join('').trim();
  return title || TITLE_DEFAULT;
}

module.exports = {
  SYSTEM_PROMPT,
  HISTORY_LIMIT,
  TITLE_DEFAULT,
  TITLE_MAX,
  AUTO_TITLE_MAX,
  MESSAGE_MAX,
  ROLE_USER,
  ROLE_ASSISTANT,
  parseId,
  isEmptyId,
  modelName,
  listModels,
  resolveModel,
  listConversations,
  findConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  listMessages,
  appendMessage,
  conversationHistory,
  touchConversation,
  autoTitle,
};
