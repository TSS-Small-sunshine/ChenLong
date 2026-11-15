const { getDb } = require('../database/db');
const { SETTINGS_DEFAULTS } = require('../database/init');

// api 字段名 -> settings.setting_key；布尔字段在库内以 '1'/'0' 存储
const FIELDS = [
  { key: 'siteName', dbKey: 'site_name', boolean: false },
  { key: 'siteSubtitle', dbKey: 'site_subtitle', boolean: false },
  { key: 'allowRegister', dbKey: 'allow_register', boolean: true },
  { key: 'allowChat', dbKey: 'allow_chat', boolean: true },
  { key: 'announcement', dbKey: 'announcement', boolean: false },
  { key: 'logo', dbKey: 'logo', boolean: false },
];

const SITE_NAME_MAX = 40;
const SITE_SUBTITLE_MAX = 60;
const ANNOUNCEMENT_MAX = 200;
const LOGO_MAX = 200;
const LOGO_PATTERN = /^(\/|https?:\/\/)/i;

// database/init.js 未导出 SETTINGS_DEFAULTS 时用同值兜底，避免缺键时无默认值可用
const FALLBACK_DEFAULTS = {
  site_name: '尘龙 ChenLong',
  site_subtitle: 'Your Little AI Companion',
  allow_register: '1',
  allow_chat: '1',
  announcement: '',
  logo: '/assets/mascot/logo.png',
};

let defaults = null;

function getDefaults() {
  if (defaults) return defaults;
  const merged = { ...FALLBACK_DEFAULTS };
  if (Array.isArray(SETTINGS_DEFAULTS)) {
    for (const entry of SETTINGS_DEFAULTS) {
      if (Array.isArray(entry) && entry.length === 2) merged[entry[0]] = entry[1];
    }
  }
  defaults = merged;
  return defaults;
}

function toBoolean(raw) {
  return raw === '1' || raw === 1 || raw === true;
}

function toText(raw) {
  return raw === null || raw === undefined ? '' : String(raw);
}

// 每次读库（查询很小），缺键时回落到默认值，不抛 500
async function readSettings() {
  const rows = await getDb().prepare('SELECT setting_key, setting_value FROM settings').all();
  const stored = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
  const base = getDefaults();
  const items = {};
  for (const field of FIELDS) {
    const raw = stored.has(field.dbKey) ? stored.get(field.dbKey) : base[field.dbKey];
    items[field.key] = field.boolean ? toBoolean(raw) : toText(raw);
  }
  return items;
}

async function readSwitch(dbKey) {
  const row = await getDb().prepare('SELECT setting_value FROM settings WHERE setting_key = ?').get(dbKey);
  return toBoolean(row ? row.setting_value : getDefaults()[dbKey]);
}

function isRegistrationAllowed() {
  return readSwitch('allow_register');
}

function isChatAllowed() {
  return readSwitch('allow_chat');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : null;
}

function invalid(message) {
  return { ok: false, message };
}

// 只写入请求里出现的键；未知键忽略
async function updateSettings(body) {
  const patch = {};

  if (body.siteName !== undefined) {
    const value = normalizeText(body.siteName);
    if (value === null) return invalid('网站名称格式不正确');
    if (!value) return invalid('请输入网站名称');
    if (value.length > SITE_NAME_MAX) return invalid(`网站名称最多 ${SITE_NAME_MAX} 个字符`);
    patch.site_name = value;
  }

  if (body.siteSubtitle !== undefined) {
    const value = normalizeText(body.siteSubtitle);
    if (value === null) return invalid('网站副标题格式不正确');
    if (value.length > SITE_SUBTITLE_MAX) return invalid(`网站副标题最多 ${SITE_SUBTITLE_MAX} 个字符`);
    patch.site_subtitle = value;
  }

  if (body.announcement !== undefined) {
    const value = normalizeText(body.announcement);
    if (value === null) return invalid('公告格式不正确');
    if (value.length > ANNOUNCEMENT_MAX) return invalid(`公告最多 ${ANNOUNCEMENT_MAX} 个字符`);
    patch.announcement = value;
  }

  if (body.logo !== undefined) {
    const value = normalizeText(body.logo);
    if (value === null) return invalid('Logo 地址格式不正确');
    if (value.length > LOGO_MAX) return invalid(`Logo 地址最多 ${LOGO_MAX} 个字符`);
    if (value && !LOGO_PATTERN.test(value)) return invalid('Logo 地址需以 / 或 http(s):// 开头');
    patch.logo = value;
  }

  if (body.allowRegister !== undefined) {
    if (typeof body.allowRegister !== 'boolean') return invalid('allowRegister 需为布尔值');
    patch.allow_register = body.allowRegister ? '1' : '0';
  }

  if (body.allowChat !== undefined) {
    if (typeof body.allowChat !== 'boolean') return invalid('allowChat 需为布尔值');
    patch.allow_chat = body.allowChat ? '1' : '0';
  }

  const entries = Object.entries(patch);
  if (entries.length > 0) {
    const now = new Date().toISOString();
    await getDb().transaction(async (tx) => {
      for (const [key, value] of entries) {
        await tx.run(
          'INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT (setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at',
          key,
          value,
          now
        );
      }
    });
  }

  return { ok: true, items: await readSettings() };
}

module.exports = {
  FIELDS,
  readSettings,
  updateSettings,
  isRegistrationAllowed,
  isChatAllowed,
};
