const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_FILE = path.join(PROJECT_ROOT, 'data', 'chenlong.db');

let instance = null;

function resolveDatabaseFile() {
  const configured = (process.env.DB_PATH || '').trim();
  if (!configured) return DEFAULT_DB_FILE;
  return path.isAbsolute(configured) ? configured : path.resolve(PROJECT_ROOT, configured);
}

function getDb() {
  if (instance) return instance;
  const Database = require('better-sqlite3');
  const file = resolveDatabaseFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  instance = conn;
  return instance;
}

function closeDb() {
  if (!instance) return;
  const conn = instance;
  instance = null;
  conn.close();
}

module.exports = { getDb, closeDb, resolveDatabaseFile };
Object.defineProperty(module.exports, 'db', { enumerable: true, get: getDb });
