const express = require('express');

const { getDb, databaseSizeBytes } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const pkg = require('../../package.json');

const router = express.Router();

const PAGE_SIZE_DEFAULT = 20;
const MESSAGE_PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;
const RECENT_LIMIT = 5;

const SELECT_CONVERSATION = `
  SELECT c.id, c.title, c.user_id, u.username, u.nickname, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
         (SELECT COALESCE(NULLIF(TRIM(m2.display_name), ''), m2.model_id)
            FROM models m2 WHERE m2.id = c.model_id) AS model_name
  FROM conversations c
  JOIN users u ON u.id = c.user_id
`;

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function readPagination(query, defaultPageSize) {
  const rawPage = query.page;
  const rawPageSize = query.pageSize;
  const page = rawPage === undefined || rawPage === '' ? 1 : Number(rawPage);
  if (!Number.isInteger(page) || page < 1) return { ok: false, message: '页码需为大于 0 的整数' };
  const pageSize = rawPageSize === undefined || rawPageSize === '' ? defaultPageSize : Number(rawPageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
    return { ok: false, message: `每页条数需为 1-${PAGE_SIZE_MAX} 的整数` };
  }
  return { ok: true, page, pageSize, offset: (page - 1) * pageSize };
}

function toConversationItem(row) {
  return {
    id: row.id,
    title: row.title || '',
    userId: row.user_id,
    username: row.username,
    nickname: row.nickname || '',
    modelName: row.model_name || '',
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.use(requireAuth, requireAdmin);

router.get('/stats', async (req, res, next) => {
  try {
    const db = getDb();
    const counters = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM users) AS user_count,
           (SELECT COUNT(*) FROM conversations) AS conversation_count,
           (SELECT COUNT(*) FROM messages) AS message_count,
           (SELECT COUNT(*) FROM api_providers) AS provider_count`
      )
      .get();

    const recentProviders = (await db
      .prepare(
        `SELECT p.id, p.name, p.base_url, p.created_at,
                (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count
         FROM api_providers p
         ORDER BY p.id DESC
         LIMIT ?`
      )
      .all(RECENT_LIMIT)).map((row) => ({
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        modelCount: row.model_count,
        createdAt: row.created_at,
      }));

    // 最近活跃：按该模型最近一次会话活动时间倒序，未使用过的模型排在后面
    const recentModels = (await db
      .prepare(
        `SELECT * FROM (
           SELECT m.id AS id, m.model_id AS model_id, m.display_name AS display_name,
                  m.enabled AS enabled, p.name AS provider_name,
                  (SELECT MAX(c.updated_at) FROM conversations c WHERE c.model_id = m.id) AS last_used_at
           FROM models m
           JOIN api_providers p ON p.id = m.provider_id
         )
         ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, id DESC
         LIMIT ?`
      )
      .all(RECENT_LIMIT)).map((row) => ({
        id: row.id,
        modelId: row.model_id,
        displayName: row.display_name || '',
        providerName: row.provider_name,
        enabled: row.enabled === 1,
        lastUsedAt: row.last_used_at || null,
      }));

    return res.json({
      stats: {
        userCount: counters.user_count,
        conversationCount: counters.conversation_count,
        messageCount: counters.message_count,
        providerCount: counters.provider_count,
      },
      recentProviders,
      recentModels,
      system: {
        version: pkg.version,
        nodeVersion: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        dbSizeBytes: await databaseSizeBytes(),
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/conversations', async (req, res, next) => {
  try {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const paging = readPagination(req.query, PAGE_SIZE_DEFAULT);
    if (!paging.ok) return fail(res, 400, 'VALIDATION_ERROR', paging.message);

    const conditions = [];
    const params = [];
    if (keyword) {
      conditions.push(
        "(c.title LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')"
      );
      const pattern = `%${escapeLike(keyword)}%`;
      params.push(pattern, pattern, pattern);
    }
    const rawUserId = req.query.userId;
    if (rawUserId !== undefined && rawUserId !== null && String(rawUserId).trim() !== '') {
      const userId = parseId(String(rawUserId).trim());
      if (!userId) return fail(res, 400, 'VALIDATION_ERROR', '用户 ID 无效');
      conditions.push('c.user_id = ?');
      params.push(userId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const db = getDb();
    const total = (await db
      .prepare(`SELECT COUNT(*) AS total FROM conversations c JOIN users u ON u.id = c.user_id ${where}`)
      .get(...params)).total;
    const rows = await db
      .prepare(`${SELECT_CONVERSATION} ${where} ORDER BY c.updated_at DESC, c.id DESC LIMIT ? OFFSET ?`)
      .all(...params, paging.pageSize, paging.offset);

    return res.json({ items: rows.map(toConversationItem), total, page: paging.page, pageSize: paging.pageSize });
  } catch (err) {
    return next(err);
  }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '会话不存在');

    const paging = readPagination(req.query, MESSAGE_PAGE_SIZE_DEFAULT);
    if (!paging.ok) return fail(res, 400, 'VALIDATION_ERROR', paging.message);

    const db = getDb();
    const conversation = await db.prepare(`${SELECT_CONVERSATION} WHERE c.id = ?`).get(id);
    if (!conversation) return fail(res, 404, 'NOT_FOUND', '会话不存在');

    const items = (
      await db
        .prepare(
          'SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT ? OFFSET ?'
        )
        .all(id, paging.pageSize, paging.offset)
    ).map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.created_at }));

    const item = toConversationItem(conversation);
    return res.json({
      conversation: {
        id: item.id,
        title: item.title,
        userId: item.userId,
        username: item.username,
        nickname: item.nickname,
        messageCount: item.messageCount,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      },
      items,
      total: conversation.message_count,
      page: paging.page,
      pageSize: paging.pageSize,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
