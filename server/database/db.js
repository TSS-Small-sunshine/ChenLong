const { Pool, types } = require('pg');

// int8（COUNT/BIGINT）默认返回 string，这里统一转 number，避免路由/会话层再做类型转换
types.setTypeParser(20, (value) => Number(value));

let pool = null;
let poolErrorHandlerBound = false;

function poolConfig() {
  const connectionString = String(process.env.DATABASE_URL || '').trim();
  const max = Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : 10;
  if (connectionString) return { connectionString, max };
  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'chenlong',
    max,
  };
}

function getPool() {
  if (pool) return pool;
  pool = new Pool(poolConfig());
  if (!poolErrorHandlerBound) {
    pool.on('error', (err) => {
      console.error('[db] PostgreSQL 连接池异常：', err.message);
    });
    poolErrorHandlerBound = true;
  }
  return pool;
}

// 项目内 SQL 统一用 ? 作为占位符，这里转换为 PostgreSQL 的 $1..$n
function toPgSql(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => '$' + (++index));
}

function normalizeParams(params) {
  const list = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return list.map((value) => (value === undefined ? null : value));
}

async function query(sql, params = []) {
  return getPool().query(toPgSql(sql), normalizeParams(params));
}

async function get(sql, ...params) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

async function all(sql, ...params) {
  const result = await query(sql, params);
  return result.rows;
}

async function run(sql, ...params) {
  const result = await query(sql, params);
  return { changes: result.rowCount, rowCount: result.rowCount, rows: result.rows };
}

// 兼容旧调用风格：db.prepare(sql).get/all/run 返回 Promise（替代 better-sqlite3 的同步 API）
function prepare(sql) {
  return {
    get: (...params) => get(sql, ...params),
    all: (...params) => all(sql, ...params),
    run: (...params) => run(sql, ...params),
  };
}

async function transaction(fn) {
  const client = await getPool().connect();
  const wrap = {
    query: (sql, params = []) => client.query(toPgSql(sql), normalizeParams(params)),
    get: async (sql, ...params) => {
      const result = await client.query(toPgSql(sql), normalizeParams(params));
      return result.rows[0] || null;
    },
    all: async (sql, ...params) => {
      const result = await client.query(toPgSql(sql), normalizeParams(params));
      return result.rows;
    },
    run: async (sql, ...params) => {
      const result = await client.query(toPgSql(sql), normalizeParams(params));
      return { changes: result.rowCount, rowCount: result.rowCount, rows: result.rows };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(wrap);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] 事务回滚失败：', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

async function closeDb() {
  if (!pool) return;
  const current = pool;
  pool = null;
  poolErrorHandlerBound = false;
  await current.end();
}

async function ping() {
  await getPool().query('SELECT 1 AS ok');
  return true;
}

async function databaseSizeBytes() {
  const row = await get('SELECT pg_database_size(current_database()) AS size');
  return Number(row ? row.size : 0);
}

const db = { prepare, query, get, all, run, transaction };

function getDb() {
  return db;
}

module.exports = {
  getPool,
  getDb,
  db,
  prepare,
  query,
  get,
  all,
  run,
  transaction,
  closeDb,
  ping,
  databaseSizeBytes,
  toPgSql,
  poolConfig,
};
