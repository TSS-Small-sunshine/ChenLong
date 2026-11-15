#!/usr/bin/env node
'use strict';

/**
 * 尘龙 ChenLong · SQLite → PostgreSQL 一次性数据迁移脚本
 *
 * - 以只读方式打开旧 SQLite 文件（默认 data/chenlong.db），保留原文件不动；
 * - 将 users / api_providers / models / conversations / messages / settings 迁移到 PostgreSQL；
 * - 保留原始 id，并把自增序列设置为当前最大 id 之后；
 * - sessions 不迁移（登录会话可重新登录获得）；
 * - 默认拒绝向已有 users 数据的目标库写入，需加 --allow-existing。
 *
 * 用法：node scripts/migrate-sqlite-to-pg.js [--sqlite <path>] [--database-url <url>] [--dry-run] [--allow-existing]
 * 退出码：0 成功；1 运行失败；2 参数错误/安全检查未通过
 */

const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SQLITE = path.join(PROJECT_ROOT, 'data', 'chenlong.db');

const USAGE = [
  '用法：node scripts/migrate-sqlite-to-pg.js [选项]',
  '',
  '把旧 SQLite 数据库迁移到 PostgreSQL（一次性操作，建议先备份目标库）。',
  '',
  '选项：',
  '  --sqlite <文件>       旧 SQLite 文件路径（默认 <项目>/data/chenlong.db）',
  '  --database-url <url>  目标 PostgreSQL 连接串（优先于 DATABASE_URL）',
  '  --dry-run             只统计将迁移的行数，不写入',
  '  --allow-existing      允许向已有 users 数据的目标库写入（默认拒绝）',
  '  -h, --help            显示本帮助',
  '',
  '环境变量：',
  '  DATABASE_URL   目标 PostgreSQL 连接串',
  '  DB_PATH        旧 SQLite 路径（--sqlite 未指定时使用，其次默认 data/chenlong.db）',
].join('\n');

const TABLES = [
  {
    name: 'users',
    columns: ['id', 'username', 'password_hash', 'nickname', 'avatar', 'role', 'status', 'created_at'],
    conflict: 'id',
  },
  {
    name: 'api_providers',
    columns: ['id', 'name', 'base_url', 'api_key_encrypted', 'api_type', 'enabled', 'description', 'created_at', 'updated_at'],
    conflict: 'id',
  },
  {
    name: 'models',
    columns: ['id', 'provider_id', 'model_id', 'display_name', 'enabled', 'is_default', 'last_tested_at', 'status', 'created_at'],
    conflict: 'id',
  },
  {
    name: 'conversations',
    columns: ['id', 'user_id', 'title', 'model_id', 'created_at', 'updated_at'],
    conflict: 'id',
  },
  {
    name: 'messages',
    columns: ['id', 'conversation_id', 'role', 'content', 'created_at'],
    conflict: 'id',
  },
  {
    name: 'settings',
    columns: ['setting_key', 'setting_value', 'updated_at'],
    conflict: 'setting_key',
    hasIdentity: false,
  },
];

function parseArgs(argv) {
  const options = { sqlite: null, databaseUrl: null, dryRun: false, allowExisting: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--sqlite') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--sqlite 需要一个文件路径');
      options.sqlite = value;
      index += 1;
    } else if (arg === '--database-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--database-url 需要一个连接串');
      options.databaseUrl = value;
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--allow-existing') {
      options.allowExisting = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error('未知参数：' + arg);
    }
  }
  return options;
}

function resolveSqliteFile(raw) {
  const value = raw || process.env.DB_PATH || DEFAULT_SQLITE;
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

async function migrate({ sqliteFile, databaseUrl, dryRun = false, allowExisting = false, log = console.log } = {}) {
  if (!fs.existsSync(sqliteFile)) throw new Error('SQLite 文件不存在：' + sqliteFile);
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL（或 --database-url）');

  const Database = require('better-sqlite3');
  const { Client } = require('pg');

  const sqlite = new Database(sqliteFile, { readonly: true, fileMustExist: true });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const counts = {};
  try {
    const existing = await client.query('SELECT COUNT(*)::int AS total FROM users');
    if (existing.rows[0].total > 0 && !allowExisting) {
      throw Object.assign(new Error('目标数据库 users 表已有数据，拒绝迁移；确认要写入请加 --allow-existing'), { code: 'EXISTING_DATA' });
    }

    for (const table of TABLES) {
      const rows = sqlite.prepare('SELECT * FROM "' + table.name + '"').all();
      counts[table.name] = rows.length;
      if (dryRun || rows.length === 0) continue;

      if (table.name === 'settings') {
        for (const row of rows) {
          await client.query(
            'INSERT INTO settings (setting_key, setting_value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (setting_key) DO NOTHING',
            [row.setting_key, row.setting_value, row.updated_at]
          );
        }
        continue;
      }

      const columns = table.columns.join(', ');
      for (const row of rows) {
        const placeholders = table.columns.map((_, index) => '$' + (index + 1)).join(', ');
        const values = table.columns.map((column) => (row[column] === undefined ? null : row[column]));
        await client.query(
          'INSERT INTO ' + table.name + ' (' + columns + ') OVERRIDING SYSTEM VALUE VALUES (' + placeholders + ') ON CONFLICT DO NOTHING',
          values
        );
      }
      await client.query(
        'SELECT setval(pg_get_serial_sequence($1, \'id\'), COALESCE((SELECT MAX(id) FROM ' + table.name + '), 0) + 1, false)',
        [table.name]
      );
      log('[migrate] ' + table.name + '：' + rows.length + ' 行');
    }

    log('[migrate] 完成（' + (dryRun ? 'dry-run，未写入' : '已写入') + '）：' + JSON.stringify(counts));
    return { counts, dryRun };
  } finally {
    sqlite.close();
    await client.end().catch(() => {});
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[migrate] ' + err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  try {
    const sqliteFile = resolveSqliteFile(options.sqlite);
    const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('缺少 DATABASE_URL（或 --database-url）');
    console.log('[migrate] SQLite：' + sqliteFile);
    console.log('[migrate] PostgreSQL：' + databaseUrl.replace(/:(?:[^:@/]+)@/, ':***@'));
    await migrate({ sqliteFile, databaseUrl, dryRun: options.dryRun, allowExisting: options.allowExisting });
    process.exit(0);
  } catch (err) {
    console.error('[migrate] 失败：' + err.message);
    process.exit(err.code === 'EXISTING_DATA' ? 2 : 1);
  }
}

module.exports = { migrate, parseArgs, resolveSqliteFile, TABLES };

if (require.main === module) {
  main();
}
