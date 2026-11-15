const express = require('express');

const { getDb } = require('../database/db');
const { requireAdmin } = require('../middleware/admin');
const { decrypt, encrypt } = require('../services/encryption');
const { MASKED_KEY, maskKey } = require('../services/key-mask');
const { fetchModels, normalizeBaseUrl } = require('../services/provider-client');
const { assertAllowedUpstream } = require('../services/upstream-guard');

const router = express.Router();

const DEFAULT_API_TYPE = 'openai-compatible';
const NAME_MAX = 50;
const API_TYPE_MAX = 50;
const DESCRIPTION_MAX = 200;
const API_KEY_MAX = 512;

router.use(requireAdmin);

function fail(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

const SELECT_PROVIDER = `
  SELECT p.id, p.name, p.base_url, p.api_key_encrypted, p.api_type, p.enabled, p.description, p.created_at, p.updated_at,
         (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id) AS model_count
  FROM api_providers p
`;

// 上游地址必须是非内网地址，否则按 400 拒绝且不落库
async function upstreamAllowed(baseUrl) {
  try {
    await assertAllowedUpstream(baseUrl);
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'UPSTREAM_BLOCKED') return { ok: false, message: err.message };
    throw err;
  }
}

function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function maskedKey(encrypted) {
  try {
    return maskKey(decrypt(encrypted));
  } catch (err) {
    console.error('[providers] API Key 解密失败：', err.message);
    return MASKED_KEY;
  }
}

function toProvider(row) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiType: row.api_type,
    enabled: row.enabled === 1,
    description: row.description || '',
    keyMasked: maskedKey(row.api_key_encrypted),
    modelCount: row.model_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getProviderRow(id) {
  return getDb().prepare(`${SELECT_PROVIDER} WHERE p.id = ?`).get(id);
}

function readName(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, message: '请输入 API 服务名称' };
  if (value.length > NAME_MAX) return { ok: false, message: `名称不能超过 ${NAME_MAX} 个字符` };
  return { ok: true, value };
}

function readApiType(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: DEFAULT_API_TYPE };
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, message: 'API 类型不能为空' };
  if (value.length > API_TYPE_MAX) return { ok: false, message: `API 类型不能超过 ${API_TYPE_MAX} 个字符` };
  return { ok: true, value };
}

function readDescription(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > DESCRIPTION_MAX) return { ok: false, message: `描述不能超过 ${DESCRIPTION_MAX} 个字符` };
  return { ok: true, value: value || null };
}

function readEnabled(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: true };
  if (typeof raw !== 'boolean') return { ok: false, message: 'enabled 需为布尔值' };
  return { ok: true, value: raw };
}

function readApiKey(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'API Key 需为字符串' };
  const value = raw.trim();
  if (value.length > API_KEY_MAX) return { ok: false, message: `API Key 不能超过 ${API_KEY_MAX} 个字符` };
  return { ok: true, value };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await getDb().prepare(`${SELECT_PROVIDER} ORDER BY p.id DESC`).all();
    return res.json({ items: rows.map(toProvider) });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    const row = await getProviderRow(id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    return res.json({ item: toProvider(row) });
  } catch (err) {
    return next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = readName(body.name);
    if (!name.ok) return fail(res, 400, 'VALIDATION_ERROR', name.message);
    const baseUrl = normalizeBaseUrl(body.baseUrl);
    if (!baseUrl.ok) return fail(res, 400, 'VALIDATION_ERROR', baseUrl.message);
    const upstream = await upstreamAllowed(baseUrl.value);
    if (!upstream.ok) return fail(res, 400, 'UPSTREAM_BLOCKED', upstream.message);
    const apiKey = readApiKey(body.apiKey);
    if (!apiKey.ok) return fail(res, 400, 'VALIDATION_ERROR', apiKey.message);
    if (!apiKey.value) return fail(res, 400, 'VALIDATION_ERROR', '请输入 API Key');
    const apiType = readApiType(body.apiType);
    if (!apiType.ok) return fail(res, 400, 'VALIDATION_ERROR', apiType.message);
    const description = readDescription(body.description);
    if (!description.ok) return fail(res, 400, 'VALIDATION_ERROR', description.message);
    const enabled = readEnabled(body.enabled);
    if (!enabled.ok) return fail(res, 400, 'VALIDATION_ERROR', enabled.message);

    const now = new Date().toISOString();
    const info = await getDb()
      .prepare(
        `INSERT INTO api_providers (name, base_url, api_key_encrypted, api_type, enabled, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .run(
        name.value,
        baseUrl.value,
        encrypt(apiKey.value),
        apiType.value,
        enabled.value ? 1 : 0,
        description.value,
        now,
        now
      );

    const createdId = info.rows[0] ? info.rows[0].id : null;
    return res.status(201).json({ item: toProvider(await getProviderRow(createdId)) });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    const existing = await getDb().prepare('SELECT id FROM api_providers WHERE id = ?').get(id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');

    const body = req.body || {};
    const updates = [];
    const params = [];

    if (body.name !== undefined) {
      const name = readName(body.name);
      if (!name.ok) return fail(res, 400, 'VALIDATION_ERROR', name.message);
      updates.push('name = ?');
      params.push(name.value);
    }
    if (body.baseUrl !== undefined) {
      const baseUrl = normalizeBaseUrl(body.baseUrl);
      if (!baseUrl.ok) return fail(res, 400, 'VALIDATION_ERROR', baseUrl.message);
      const upstream = await upstreamAllowed(baseUrl.value);
      if (!upstream.ok) return fail(res, 400, 'UPSTREAM_BLOCKED', upstream.message);
      updates.push('base_url = ?');
      params.push(baseUrl.value);
    }
    if (body.apiKey !== undefined) {
      const apiKey = readApiKey(body.apiKey);
      if (!apiKey.ok) return fail(res, 400, 'VALIDATION_ERROR', apiKey.message);
      if (apiKey.value) {
        updates.push('api_key_encrypted = ?');
        params.push(encrypt(apiKey.value));
      }
    }
    if (body.apiType !== undefined) {
      const apiType = readApiType(body.apiType);
      if (!apiType.ok) return fail(res, 400, 'VALIDATION_ERROR', apiType.message);
      updates.push('api_type = ?');
      params.push(apiType.value);
    }
    if (body.description !== undefined) {
      const description = readDescription(body.description);
      if (!description.ok) return fail(res, 400, 'VALIDATION_ERROR', description.message);
      updates.push('description = ?');
      params.push(description.value);
    }
    if (body.enabled !== undefined) {
      const enabled = readEnabled(body.enabled);
      if (!enabled.ok) return fail(res, 400, 'VALIDATION_ERROR', enabled.message);
      updates.push('enabled = ?');
      params.push(enabled.value ? 1 : 0);
    }

    updates.push('updated_at = ?');
    params.push(new Date().toISOString());
    await getDb().prepare(`UPDATE api_providers SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);

    return res.json({ item: toProvider(await getProviderRow(id)) });
  } catch (err) {
    return next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    const info = await getDb().prepare('DELETE FROM api_providers WHERE id = ?').run(id);
    if (info.changes === 0) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/status', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    const body = req.body || {};
    if (typeof body.enabled !== 'boolean') return fail(res, 400, 'VALIDATION_ERROR', 'enabled 需为布尔值');

    const info = await getDb()
      .prepare('UPDATE api_providers SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(body.enabled ? 1 : 0, new Date().toISOString(), id);
    if (info.changes === 0) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');

    return res.json({ item: toProvider(await getProviderRow(id)) });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/test', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    const row = await getDb().prepare('SELECT id, base_url, api_key_encrypted FROM api_providers WHERE id = ?').get(id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');

    let apiKey;
    try {
      apiKey = decrypt(row.api_key_encrypted);
    } catch (err) {
      console.error('[providers] API Key 解密失败：', err.message);
      return res.json({
        ok: false,
        latencyMs: 0,
        modelCount: 0,
        message: 'API Key 解密失败，请重新保存该服务的密钥',
      });
    }

    const result = await fetchModels(row.base_url, apiKey);
    return res.json({
      ok: result.ok,
      latencyMs: result.latencyMs,
      modelCount: result.models.length,
      message: result.ok ? `连接成功，上游返回 ${result.models.length} 个模型` : result.message,
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/refresh-models', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');
    const row = await getDb().prepare('SELECT id, base_url, api_key_encrypted FROM api_providers WHERE id = ?').get(id);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'API 服务不存在');

    let apiKey;
    try {
      apiKey = decrypt(row.api_key_encrypted);
    } catch (err) {
      console.error('[providers] API Key 解密失败：', err.message);
      return fail(res, 502, 'UPSTREAM_ERROR', 'API Key 解密失败，请重新保存该服务的密钥');
    }

    const result = await fetchModels(row.base_url, apiKey);
    if (!result.ok) return fail(res, 502, 'UPSTREAM_ERROR', result.message);

    const db = getDb();
    const insertSql = `INSERT INTO models (provider_id, model_id, display_name, enabled, is_default, status, created_at)
       VALUES (?, ?, NULL, 0, 0, 'discovered', ?)
       ON CONFLICT (provider_id, model_id) DO NOTHING`;
    const now = new Date().toISOString();
    const added = await db.transaction(async (tx) => {
      let count = 0;
      for (const modelId of result.models) {
        const info = await tx.run(insertSql, id, modelId, now);
        count += info.changes;
      }
      return count;
    });

    const totalRow = await db.prepare('SELECT COUNT(*) AS total FROM models WHERE provider_id = ?').get(id);
    const total = totalRow.total;
    return res.json({ ok: true, added, total, message: `新增 ${added} 个模型，当前共 ${total} 个` });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
