const express = require('express');

const { getDb } = require('../database/db');
const { requireAdmin } = require('../middleware/admin');
const { decrypt } = require('../services/encryption');
const { fetchModels } = require('../services/provider-client');

const router = express.Router();

const MODEL_ID_MAX = 100;
const DISPLAY_NAME_MAX = 100;
const STATUS_DISCOVERED = 'discovered';

router.use(requireAdmin);

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

const SELECT_MODEL = `
  SELECT m.id, m.provider_id, p.name AS provider_name, m.model_id, m.display_name, m.enabled, m.is_default,
         m.status, m.last_tested_at, m.created_at
  FROM models m
  JOIN api_providers p ON p.id = m.provider_id
`;

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toModel(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    modelId: row.model_id,
    displayName: row.display_name || '',
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    status: row.status,
    lastTestedAt: row.last_tested_at,
    createdAt: row.created_at,
  };
}

async function getModelRow(id) {
  return getDb().prepare(`${SELECT_MODEL} WHERE m.id = ?`).get(id);
}

function readModelId(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, message: '请输入模型 ID' };
  if (value.length > MODEL_ID_MAX) return { ok: false, message: `模型 ID 不能超过 ${MODEL_ID_MAX} 个字符` };
  return { ok: true, value };
}

function readDisplayName(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `显示名称不能超过 ${DISPLAY_NAME_MAX} 个字符` };
  }
  return { ok: true, value: value || null };
}

function readEnabled(raw, fallback) {
  if (raw === undefined || raw === null) return { ok: true, value: fallback };
  if (typeof raw !== 'boolean') return { ok: false, message: 'enabled 需为布尔值' };
  return { ok: true, value: raw };
}

function isUniqueViolation(err) {
  return Boolean(err) && err.code === '23505';
}

router.get('/', async (req, res, next) => {
  try {
    const where = [];
    const params = [];

    const providerId = parseId(req.query.providerId);
    if (providerId) {
      where.push('m.provider_id = ?');
      params.push(providerId);
    }

    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    if (keyword) {
      where.push("(m.display_name LIKE ? ESCAPE '\\' OR m.model_id LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(keyword)}%`;
      params.push(pattern, pattern);
    }

    if (req.query.status === 'enabled') where.push('m.enabled = 1');
    else if (req.query.status === 'disabled') where.push('m.enabled = 0');

    const sql = `${SELECT_MODEL}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY m.id DESC`;
    const items = (await getDb().prepare(sql).all(...params)).map(toModel);
    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    const row = await getModelRow(id);
    if (!row) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    return res.json({ item: toModel(row) });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const providerId = parseId(body.providerId);
    if (!providerId) return fail(res, 400, 'VALIDATION_ERROR', '请选择 API 服务');

    const db = getDb();
    if (!(await db.prepare('SELECT id FROM api_providers WHERE id = ?').get(providerId))) {
      return fail(res, 400, 'VALIDATION_ERROR', 'API 服务不存在');
    }

    const modelId = readModelId(body.modelId);
    if (!modelId.ok) return fail(res, 400, 'VALIDATION_ERROR', modelId.message);
    const displayName = readDisplayName(body.displayName);
    if (!displayName.ok) return fail(res, 400, 'VALIDATION_ERROR', displayName.message);
    const enabled = readEnabled(body.enabled, true);
    if (!enabled.ok) return fail(res, 400, 'VALIDATION_ERROR', enabled.message);
    const isDefault = readEnabled(body.isDefault, false);
    if (!isDefault.ok) return fail(res, 400, 'VALIDATION_ERROR', isDefault.message);
    if (isDefault.value && !enabled.value) {
      return fail(res, 400, 'VALIDATION_ERROR', '请先启用该模型再设为默认');
    }

    if (await db.prepare('SELECT id FROM models WHERE provider_id = ? AND model_id = ?').get(providerId, modelId.value)) {
      return fail(res, 409, 'MODEL_EXISTS', '该 API 下已存在同名模型');
    }

    const now = new Date().toISOString();
    const create = () => db.transaction(async (tx) => {
      if (isDefault.value) await tx.run('UPDATE models SET is_default = 0 WHERE is_default = 1');
      return tx.run(
        `INSERT INTO models (provider_id, model_id, display_name, enabled, is_default, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
        providerId,
        modelId.value,
        displayName.value,
        enabled.value ? 1 : 0,
        isDefault.value ? 1 : 0,
        STATUS_DISCOVERED,
        now
      );
    });

    let info;
    try {
      info = await create();
    } catch (err) {
      if (isUniqueViolation(err)) return fail(res, 409, 'MODEL_EXISTS', '该 API 下已存在同名模型');
      throw err;
    }

    const createdId = info.rows[0] ? info.rows[0].id : null;
    return res.status(201).json({ item: toModel(await getModelRow(createdId)) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    const existing = await getModelRow(id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', '模型不存在');

    const body = req.body || {};
    const updates = [];
    const params = [];

    if (body.modelId !== undefined) {
      const modelId = readModelId(body.modelId);
      if (!modelId.ok) return fail(res, 400, 'VALIDATION_ERROR', modelId.message);
      if (modelId.value !== existing.model_id) {
        const clash = await getDb()
          .prepare('SELECT id FROM models WHERE provider_id = ? AND model_id = ? AND id <> ?')
          .get(existing.provider_id, modelId.value, id);
        if (clash) return fail(res, 409, 'MODEL_EXISTS', '该 API 下已存在同名模型');
      }
      updates.push('model_id = ?');
      params.push(modelId.value);
    }
    if (body.displayName !== undefined) {
      const displayName = readDisplayName(body.displayName);
      if (!displayName.ok) return fail(res, 400, 'VALIDATION_ERROR', displayName.message);
      updates.push('display_name = ?');
      params.push(displayName.value);
    }
    if (body.enabled !== undefined) {
      const enabled = readEnabled(body.enabled, existing.enabled === 1);
      if (!enabled.ok) return fail(res, 400, 'VALIDATION_ERROR', enabled.message);
      updates.push('enabled = ?');
      params.push(enabled.value ? 1 : 0);
      if (!enabled.value) updates.push('is_default = 0');
    }

    if (updates.length > 0) {
      await getDb().prepare(`UPDATE models SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);
    }

    return res.json({ item: toModel(await getModelRow(id)) });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    const info = await getDb().prepare('DELETE FROM models WHERE id = ?').run(id);
    if (info.changes === 0) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/default', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    const existing = await getModelRow(id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    if (existing.enabled !== 1) return fail(res, 400, 'VALIDATION_ERROR', '请先启用该模型再设为默认');

    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.run('UPDATE models SET is_default = 0 WHERE is_default = 1');
      await tx.run('UPDATE models SET is_default = 1 WHERE id = ?', id);
    });

    return res.json({ item: toModel(await getModelRow(id)) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    const body = req.body || {};
    if (typeof body.enabled !== 'boolean') return fail(res, 400, 'VALIDATION_ERROR', 'enabled 需为布尔值');

    const db = getDb();
    const info = body.enabled
      ? await db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(id)
      : await db.prepare('UPDATE models SET enabled = 0, is_default = 0 WHERE id = ?').run(id);
    if (info.changes === 0) return fail(res, 404, 'NOT_FOUND', '模型不存在');

    return res.json({ item: toModel(await getModelRow(id)) });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/test', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '模型不存在');
    const row = await getModelRow(id);
    if (!row) return fail(res, 404, 'NOT_FOUND', '模型不存在');

    const db = getDb();
    const provider = await db.prepare('SELECT id, base_url, api_key_encrypted FROM api_providers WHERE id = ?').get(row.provider_id);
    if (!provider) return fail(res, 404, 'NOT_FOUND', '模型不存在');

    let apiKey;
    try {
      apiKey = decrypt(provider.api_key_encrypted);
    } catch (err) {
      console.error('[models] API Key 解密失败：', err.message);
      await db.prepare("UPDATE models SET last_tested_at = ?, status = 'unavailable' WHERE id = ?").run(
        new Date().toISOString(),
        id
      );
      return res.json({ ok: false, latencyMs: 0, message: 'API Key 解密失败，请重新保存该服务的密钥' });
    }

    const result = await fetchModels(provider.base_url, apiKey);
    const now = new Date().toISOString();

    if (!result.ok) {
      await db.prepare("UPDATE models SET last_tested_at = ?, status = 'unavailable' WHERE id = ?").run(now, id);
      return res.json({ ok: false, latencyMs: result.latencyMs, message: result.message });
    }

    const found = result.models.includes(row.model_id);
    await db.prepare('UPDATE models SET last_tested_at = ?, status = ? WHERE id = ?').run(
      now,
      found ? 'available' : 'unavailable',
      id
    );
    return res.json({
      ok: found,
      latencyMs: result.latencyMs,
      message: found ? '上游模型列表中存在该模型' : '上游未返回该模型',
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
