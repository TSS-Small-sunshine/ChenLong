const session = require('express-session');

const { getDb } = require('../database/db');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expire BIGINT NOT NULL
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

function parseSession(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * express-session 的 PostgreSQL 存储实现。
 * 对外保持回调风格（express-session Store 约定），内部全部使用 pg 异步查询。
 */
class PgSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
    this._db = options.db || null;
    this._schemaReady = null;
    this._timer = setInterval(() => {
      this.cleanup().catch((err) => {
        console.error('[session-store] 过期会话清理失败：', err.message);
      });
    }, CLEANUP_INTERVAL_MS);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  get db() {
    return this._db || getDb();
  }

  // 首次使用时确保 sessions 表存在（幂等），并发调用只执行一次
  _ensureSchema() {
    if (!this._schemaReady) {
      this._schemaReady = this.db.query(SCHEMA_SQL).catch((err) => {
        this._schemaReady = null;
        throw err;
      });
    }
    return this._schemaReady;
  }

  get(sid, callback) {
    this._ensureSchema()
      .then(() => this.db.get('SELECT sess, expire FROM sessions WHERE sid = ?', sid))
      .then((row) => {
        if (!row) return callback(null, null);
        if (Number(row.expire) <= Date.now()) {
          return this.db
            .run('DELETE FROM sessions WHERE sid = ?', sid)
            .then(() => callback(null, null), (err) => callback(err));
        }
        return callback(null, parseSession(row.sess));
      })
      .catch((err) => callback(err));
  }

  set(sid, sess, callback) {
    this._ensureSchema()
      .then(() =>
        this.db.run(
          'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ' +
            'ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire',
          sid,
          JSON.stringify(sess),
          expiryOf(sess, this.ttlMs)
        )
      )
      .then(() => callback && callback(null), (err) => callback && callback(err));
  }

  touch(sid, sess, callback) {
    this._ensureSchema()
      .then(() => this.db.run('UPDATE sessions SET expire = ? WHERE sid = ?', expiryOf(sess, this.ttlMs), sid))
      .then((result) => {
        if (result.changes === 0) return this.set(sid, sess, callback);
        if (callback) callback(null);
        return undefined;
      })
      .catch((err) => callback && callback(err));
  }

  destroy(sid, callback) {
    this._ensureSchema()
      .then(() => this.db.run('DELETE FROM sessions WHERE sid = ?', sid))
      .then(() => callback && callback(null), (err) => callback && callback(err));
  }

  all(callback) {
    this._ensureSchema()
      .then(() => this.db.all('SELECT sid, sess FROM sessions'))
      .then((rows) => {
        const result = Object.create(null);
        for (const row of rows) {
          const parsed = parseSession(row.sess);
          if (parsed) result[row.sid] = parsed;
        }
        callback(null, result);
      })
      .catch((err) => callback(err));
  }

  clear(callback) {
    this._ensureSchema()
      .then(() => this.db.run('DELETE FROM sessions'))
      .then(() => callback && callback(null), (err) => callback && callback(err));
  }

  length(callback) {
    this._ensureSchema()
      .then(() => this.db.get('SELECT COUNT(*) AS total FROM sessions'))
      .then((row) => callback(null, Number(row.total)), (err) => callback(err));
  }

  /** 删除过期会话，返回删除条数（Promise） */
  async cleanup(now = Date.now()) {
    await this._ensureSchema();
    const result = await this.db.run('DELETE FROM sessions WHERE expire <= ?', now);
    return result.changes;
  }

  // 遍历并删除满足条件的会话；keepSid 用于"保留当前会话"的场景
  async _destroyMatching(predicate, keepSid) {
    await this._ensureSchema();
    const rows = await this.db.all('SELECT sid, sess FROM sessions');
    let removed = 0;
    for (const row of rows) {
      if (keepSid && row.sid === keepSid) continue;
      const sess = parseSession(row.sess);
      if (!sess || predicate(sess) !== true) continue;
      const result = await this.db.run('DELETE FROM sessions WHERE sid = ?', row.sid);
      removed += result.changes;
    }
    return removed;
  }

  /** 删除某个用户的全部登录会话，返回删除条数（管理员重置密码后强制下线） */
  destroyByUserId(userId) {
    const target = String(userId);
    return this._destroyMatching((sess) => String(sess.userId) === target, null);
  }

  /** 删除某个用户除 keepSid 外的其他会话，返回删除条数（本人改密后下线其它设备） */
  destroyOthersByUserId(userId, keepSid) {
    const target = String(userId);
    return this._destroyMatching((sess) => String(sess.userId) === target, keepSid);
  }
}

module.exports = PgSessionStore;
module.exports.PgSessionStore = PgSessionStore;
module.exports.DEFAULT_TTL_MS = DEFAULT_TTL_MS;
