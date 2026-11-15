'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');

// 测试固定密钥：32 字节（64 位 hex），绝不读真实 .env / 业务密钥
const TEST_ENCRYPTION_KEY_HEX = '11'.repeat(32);
const TEST_ENCRYPTION_KEY_HEX_ALT = '22'.repeat(32);
const TEST_SESSION_SECRET = 'chenlong-test-session-secret-please-change';

// CI 默认管理库连接串；本地/其他环境可用 DATABASE_URL 覆盖
const DEFAULT_ADMIN_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function createTempDir(prefix = 'chenlong-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  // Windows 上文件句柄释放可能有毫秒级延迟，删除时带重试
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function uniqueId() {
  return crypto.randomUUID();
}

function adminDatabaseUrl() {
  const configured = String(process.env.DATABASE_URL || '').trim();
  return configured || DEFAULT_ADMIN_DATABASE_URL;
}

function quoteIdentifier(name) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error('非法 PostgreSQL 标识符：' + name);
  }
  return '"' + name + '"';
}

/** 把连接串里的数据库名替换为指定库（保留 host/port/认证/查询参数） */
function databaseUrlWithName(baseUrl, database) {
  const parsed = new URL(baseUrl);
  parsed.pathname = '/' + database;
  return parsed.toString();
}

function makeDatabaseName(prefix = 'chenlong_test_') {
  const safePrefix = /^[a-z][a-z0-9_]*$/.test(prefix) ? prefix : 'chenlong_test_';
  // 每个测试文件独立库，避免并行时互相污染；长度限制 63
  return (safePrefix + crypto.randomBytes(6).toString('hex')).slice(0, 63);
}

async function connectAdmin(baseUrl) {
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  return client;
}

/**
 * 为当前测试文件创建独立 PostgreSQL 数据库。
 *
 * 1. 从 process.env.DATABASE_URL（缺省 CI 约定的 postgres 管理库）连管理库；
 * 2. CREATE DATABASE chenlong_test_<random>；
 * 3. 把 process.env.DATABASE_URL 指向新库，业务模块首次 getDb() 时就连接到测试库；
 * 4. cleanup(): 关闭业务连接池 + DROP DATABASE ... WITH (FORCE)，并恢复原 DATABASE_URL。
 *
 * 必须在 require 会访问数据库的业务模块之前 await 本函数。
 * @returns {Promise<{ database: string, url: string, cleanup: () => Promise<void> }>}
 */
async function installTestDatabase(prefix = 'chenlong_test_') {
  const adminUrl = adminDatabaseUrl();
  const previousUrl = process.env.DATABASE_URL;
  const database = makeDatabaseName(prefix);

  const admin = await connectAdmin(adminUrl);
  try {
    await admin.query('CREATE DATABASE ' + quoteIdentifier(database));
  } finally {
    await admin.end().catch(() => {});
  }

  const url = databaseUrlWithName(adminUrl, database);
  process.env.DATABASE_URL = url;

  let cleanedUp = false;
  return {
    database,
    url,
    async cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      // lazy require：本 helper 本身不加载 server 模块，避免连接池过早绑定旧 DATABASE_URL
      try {
        const { closeDb } = require('../../server/database/db');
        await closeDb();
      } catch (err) {
        console.error('[test-db] 关闭数据库连接池失败：', err && err.message ? err.message : err);
      }
      let client = null;
      try {
        client = await connectAdmin(adminUrl);
        await client.query('DROP DATABASE IF EXISTS ' + quoteIdentifier(database) + ' WITH (FORCE)');
      } catch (err) {
        console.error('[test-db] 删除测试数据库失败（' + database + '）：', err && err.message ? err.message : err);
      } finally {
        if (client) await client.end().catch(() => {});
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
      }
    },
  };
}

module.exports = {
  DEFAULT_ADMIN_DATABASE_URL,
  TEST_ENCRYPTION_KEY_HEX,
  TEST_ENCRYPTION_KEY_HEX_ALT,
  TEST_SESSION_SECRET,
  createTempDir,
  removeDir,
  uniqueId,
  installTestDatabase,
};
