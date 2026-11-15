const path = require('path');

const { getDb, closeDb } = require('./db');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT,
  avatar TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  api_type TEXT NOT NULL DEFAULT 'openai-compatible',
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES api_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_tested_at TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at TEXT NOT NULL,
  UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);
CREATE INDEX IF NOT EXISTS idx_api_providers_enabled ON api_providers(enabled);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`;

const SETTINGS_DEFAULTS = [
  ['site_name', '尘龙 ChenLong'],
  ['site_subtitle', 'Your Little AI Companion'],
  ['allow_register', '1'],
  ['allow_chat', '1'],
  ['announcement', ''],
  ['logo', '/assets/mascot/logo.png'],
];

function seedSettings(db) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)'
  );
  const now = new Date().toISOString();
  let inserted = 0;
  for (const [key, value] of SETTINGS_DEFAULTS) {
    inserted += stmt.run(key, value, now).changes;
  }
  return inserted;
}

function seedAdmin(db) {
  const adminCount = db.prepare("SELECT COUNT(*) AS total FROM users WHERE role = 'admin'").get().total;
  if (adminCount > 0) return false;

  const username = (process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';

  if (!username || !password) {
    console.warn(
      '[WARN] 未同时配置 ADMIN_USERNAME 与 ADMIN_PASSWORD，已跳过初始管理员创建；' +
        '如需管理员请在 .env 中补齐后重新运行 npm run init-db。'
    );
    return false;
  }

  const bcrypt = require('bcryptjs');
  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, nickname, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, passwordHash, username, 'admin', 'active', new Date().toISOString());

  console.log(`已创建初始管理员 ${username}，请登录后立即修改密码`);
  return true;
}

function initDatabase() {
  const db = getDb();
  db.exec(SCHEMA_SQL);
  const settingsInserted = seedSettings(db);
  const adminCreated = seedAdmin(db);
  return { settingsInserted, adminCreated };
}

module.exports = { initDatabase };

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
  try {
    const result = initDatabase();
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    console.log(`数据库初始化完成：${tables.length} 张表 [${tables.join(', ')}]，新增设置项 ${result.settingsInserted} 条`);
    closeDb();
  } catch (err) {
    console.error('[ERROR] 数据库初始化失败：', err.message);
    process.exitCode = 1;
  }
}
