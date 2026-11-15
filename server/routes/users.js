const express = require('express');
const bcrypt = require('bcryptjs');

const { getDb } = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const { validateNickname } = require('../services/validation');

const router = express.Router();

const BCRYPT_COST = 10;
const ROLE_VALUES = ['user', 'admin'];
const STATUS_VALUES = ['active', 'disabled'];
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 32;

const SELECT_USER = `
  SELECT u.id, u.username, u.nickname, u.avatar, u.role, u.status, u.created_at,
         (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count
  FROM users u
`;

const SELECT_USER_DETAIL = `
  SELECT u.id, u.username, u.nickname, u.avatar, u.role, u.status, u.created_at,
         (SELECT COUNT(*) FROM conversations c WHERE c.user_id = u.id) AS conversation_count,
         (SELECT COUNT(*) FROM messages m JOIN conversations c2 ON c2.id = m.conversation_id WHERE c2.user_id = u.id) AS message_count
  FROM users u
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

function toItem(row) {
  const item = {
    id: row.id,
    username: row.username,
    nickname: row.nickname || '',
    avatar: row.avatar || '',
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    conversationCount: row.conversation_count,
  };
  if (row.message_count !== undefined) item.messageCount = row.message_count;
  return item;
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

function readEnumFilter(raw, allowed) {
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  const value = String(raw).trim();
  if (!value) return { ok: true, value: '' };
  return allowed.includes(value) ? { ok: true, value } : { ok: false };
}

function readBody(req) {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

router.use(requireAuth, requireAdmin);

router.get('/', (req, res, next) => {
  try {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const status = readEnumFilter(req.query.status, STATUS_VALUES);
    if (!status.ok) return fail(res, 400, 'VALIDATION_ERROR', '状态筛选只能是 active 或 disabled');
    const role = readEnumFilter(req.query.role, ROLE_VALUES);
    if (!role.ok) return fail(res, 400, 'VALIDATION_ERROR', '角色筛选只能是 user 或 admin');
    const paging = readPagination(req.query, PAGE_SIZE_DEFAULT);
    if (!paging.ok) return fail(res, 400, 'VALIDATION_ERROR', paging.message);

    const conditions = [];
    const params = [];
    if (keyword) {
      conditions.push("(u.username LIKE ? ESCAPE '\\' OR u.nickname LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(keyword)}%`;
      params.push(pattern, pattern);
    }
    if (status.value) {
      conditions.push('u.status = ?');
      params.push(status.value);
    }
    if (role.value) {
      conditions.push('u.role = ?');
      params.push(role.value);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const db = getDb();
    const total = db.prepare(`SELECT COUNT(*) AS total FROM users u ${where}`).get(...params).total;
    const rows = db
      .prepare(`${SELECT_USER} ${where} ORDER BY u.id ASC LIMIT ? OFFSET ?`)
      .all(...params, paging.pageSize, paging.offset);

    return res.json({ items: rows.map(toItem), total, page: paging.page, pageSize: paging.pageSize });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '用户不存在');
    const row = getDb().prepare(`${SELECT_USER_DETAIL} WHERE u.id = ?`).get(id);
    if (!row) return fail(res, 404, 'NOT_FOUND', '用户不存在');
    return res.json({ item: toItem(row) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '用户不存在');

    const db = getDb();
    const target = db.prepare('SELECT id, role, status FROM users WHERE id = ?').get(id);
    if (!target) return fail(res, 404, 'NOT_FOUND', '用户不存在');

    const body = readBody(req);
    const changes = {};

    if (body.nickname !== undefined) {
      const nickname = validateNickname(body.nickname);
      if (!nickname.ok) return fail(res, 400, 'VALIDATION_ERROR', nickname.message);
      changes.nickname = nickname.value;
    }

    if (body.role !== undefined) {
      if (target.id === req.user.id) return fail(res, 400, 'CANNOT_MODIFY_SELF', '不能修改自己的角色或状态');
      if (!ROLE_VALUES.includes(body.role)) return fail(res, 400, 'VALIDATION_ERROR', '角色只能是 user 或 admin');
      changes.role = body.role;
    }

    if (body.status !== undefined) {
      if (target.id === req.user.id) return fail(res, 400, 'CANNOT_MODIFY_SELF', '不能修改自己的角色或状态');
      if (!STATUS_VALUES.includes(body.status)) return fail(res, 400, 'VALIDATION_ERROR', '状态只能是 active 或 disabled');
      changes.status = body.status;
    }

    // 目标当前是启用中的管理员，且本次会降级或禁用 -> 必须仍存在其他启用管理员
    const nextRole = changes.role !== undefined ? changes.role : target.role;
    const nextStatus = changes.status !== undefined ? changes.status : target.status;
    const losesActiveAdmin =
      target.role === 'admin' && target.status === 'active' && (nextRole !== 'admin' || nextStatus !== 'active');
    if (losesActiveAdmin) {
      const others = db
        .prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND status = 'active' AND id <> ?")
        .get(target.id).total;
      if (others === 0) return fail(res, 400, 'LAST_ADMIN', '至少保留一个启用的管理员');
    }

    const keys = Object.keys(changes);
    if (keys.length > 0) {
      const assignments = keys.map((key) => `${key} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${assignments} WHERE id = ?`).run(
        ...keys.map((key) => changes[key]),
        target.id
      );
    }

    const row = db.prepare(`${SELECT_USER_DETAIL} WHERE u.id = ?`).get(target.id);
    return res.json({ item: toItem(row) });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/password', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '用户不存在');

    const db = getDb();
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) {
      return fail(res, 404, 'NOT_FOUND', '用户不存在');
    }

    const password = readBody(req).password;
    if (typeof password !== 'string' || !password) return fail(res, 400, 'VALIDATION_ERROR', '请输入密码');
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return fail(res, 400, 'VALIDATION_ERROR', `密码长度需为 ${PASSWORD_MIN}–${PASSWORD_MAX} 个字符`);
    }
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return fail(res, 400, 'VALIDATION_ERROR', '密码需同时包含字母和数字');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);

    // 重置密码后目标用户此前已登录的会话全部失效（旧会话不能继续使用新密码之外的凭据）
    try {
      const store = req.sessionStore;
      if (store && typeof store.destroyByUserId === 'function') {
        const selfReset = id === req.user.id && typeof store.destroyOthersByUserId === 'function';
        const removed = selfReset ? store.destroyOthersByUserId(id, req.sessionID) : store.destroyByUserId(id);
        console.log('[users] 已重置用户 ' + id + ' 的密码，失效其会话 ' + removed + ' 条');
      }
    } catch (err) {
      console.error('[users] 重置密码后清理目标用户会话失败：', err.message);
    }

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
