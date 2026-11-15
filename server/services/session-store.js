const session = require('express-session');

const { getDb } = require('../database/db');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
`;

function expiryOf(sess, ttlMs) {
  const expires = sess && sess.cookie ? sess.cookie.expires : null;
  if (expires) {
    const ms = new Date(expires).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now() + ttlMs;
}

class SqliteSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    this._db = options.db || null;
    this._schemaReady = false;
    this._timer = setInterval(() => {
      try {
        this.cleanup();
      } catch (err) {
        console.error('[session-store] 过期会话清理失败：', err.message);
      }
    }, CLEANUP_INTERVAL_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  get db() {
    if (!this._db) this._db = getDb();
    if (!this._schemaReady) {
      this._db.exec(SCHEMA_SQL);
      this._schemaReady = true;
    }
    return this._db;
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expire <= Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.sess));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      this.db
        .prepare(
          'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ' +
            'ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire'
        )
        .run(sid, JSON.stringify(sess), expiryOf(sess, this.ttlMs));
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid, sess, callback) {
    try {
      const info = this.db
        .prepare('UPDATE sessions SET expire = ? WHERE sid = ?')
        .run(expiryOf(sess, this.ttlMs), sid);
      if (info.changes === 0) return this.set(sid, sess, callback);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  // 遍历并删除满足条件的会话（同步实现，失败抛错）。keepSid 用于"保留当前会话"的场景。
  _destroyMatching(predicate, keepSid) {
    const rows = this.db.prepare('SELECT sid, sess FROM sessions').all();
    const del = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    let removed = 0;
    for (const row of rows) {
      if (keepSid && row.sid === keepSid) continue;
      let sess;
      try {
        sess = JSON.parse(row.sess);
      } catch {
        continue;
      }
      if (!sess || predicate(sess) !== true) continue;
      removed += del.run(row.sid).changes;
    }
    return removed;
  }

  /** 删除某个用户的全部登录会话，返回删除条数（用于管理员重置密码后强制下线）。 */
  destroyByUserId(userId) {
    const target = String(userId);
    return this._destroyMatching((sess) => String(sess.userId) === target, null);
  }

  /** 删除某个用户除 keepSid 外的其他会话，返回删除条数（用于本人改密后下线其它设备）。 */
  destroyOthersByUserId(userId, keepSid) {
    const target = String(userId);
    return this._destroyMatching((sess) => String(sess.userId) === target, keepSid);
  }

  all(callback) {
    try {
      const rows = this.db.prepare('SELECT sid, sess FROM sessions').all();
      const result = Object.create(null);
      for (const row of rows) result[row.sid] = JSON.parse(row.sess);
      callback(null, result);
    } catch (err) {
      callback(err);
    }
  }

  clear(callback) {
    try {
      this.db.prepare('DELETE FROM sessions').run();
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  length(callback) {
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS total FROM sessions').get();
      callback(null, row.total);
    } catch (err) {
      callback(err);
    }
  }

  cleanup(now = Date.now()) {
    return this.db.prepare('DELETE FROM sessions WHERE expire <= ?').run(now).changes;
  }
}

module.exports = SqliteSessionStore;
module.exports.SqliteSessionStore = SqliteSessionStore;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
