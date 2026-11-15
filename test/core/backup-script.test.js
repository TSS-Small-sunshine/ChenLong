'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createTempDir,
  removeDir,
  installTestDatabase,
} = require('../helpers/temp-db');
const {
  backupDatabase,
  backupFileName,
  resolveOutDir,
  parseArgs,
  connectionParts,
  describeTarget,
  timestamp,
  DEFAULT_OUT_DIR,
} = require('../../scripts/backup-db');

let temp = null;
let workDir = '';
let setupError = null;

before(async () => {
  workDir = createTempDir('chenlong-pg-backup-test-');
  try {
    temp = await installTestDatabase('chenlong_test_backup_');
    const initModule = require('../../server/database/init');
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await initModule.initDatabase();
    } finally {
      console.warn = originalWarn;
    }
  } catch (err) {
    setupError = err;
  }
});

after(async () => {
  if (temp) await temp.cleanup();
  removeDir(workDir);
});

function pgDumpAvailable() {
  const probe = spawnSync(process.env.PG_DUMP || 'pg_dump', ['--version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

function pgDumpMajorVersion() {
  const probe = spawnSync(process.env.PG_DUMP || 'pg_dump', ['--version'], { stdio: 'pipe', encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return null;
  const matched = String(probe.stdout || '').match(/(\d+)\./);
  return matched ? Number(matched[1]) : null;
}

async function serverMajorVersion() {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query("SELECT current_setting('server_version_num')::int AS version");
    return Math.floor(result.rows[0].version / 10000);
  } finally {
    await client.end().catch(() => {});
  }
}

function requireDatabase(t) {
  if (setupError) {
    t.skip('PostgreSQL 不可用，跳过实际备份测试：' + (setupError.message || setupError));
    return false;
  }
  return true;
}

test('backupFileName / timestamp / resolveOutDir 基础行为', () => {
  assert.equal(timestamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
  assert.equal(backupFileName(new Date(2026, 10, 15, 16, 8, 9)), 'chenlong-20261115-160809.sql');

  assert.equal(resolveOutDir(''), DEFAULT_OUT_DIR);
  const absolute = path.join(workDir, 'out-abs');
  assert.equal(resolveOutDir(absolute), path.normalize(absolute));
});

test('parseArgs：默认值、选项与非法参数', () => {
  assert.deepEqual(parseArgs([]), { outDir: null, databaseUrl: null, force: false, help: false });
  assert.deepEqual(parseArgs(['--out', 'dir', '--database-url', 'postgres://u@h/db', '--force']), {
    outDir: 'dir',
    databaseUrl: 'postgres://u@h/db',
    force: true,
    help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-f']).force, true);
  assert.throws(() => parseArgs(['--out']), /--out/);
  assert.throws(() => parseArgs(['--database-url']), /--database-url/);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
});

test('connectionParts / describeTarget：拆连接串为 PG* 环境变量', () => {
  const parts = connectionParts('postgres://user:p%40ss@db.example.com:6543/mydb?sslmode=require');
  assert.deepEqual(parts, {
    PGHOST: 'db.example.com',
    PGPORT: '6543',
    PGUSER: 'user',
    PGPASSWORD: 'p@ss',
    PGDATABASE: 'mydb',
    PGSSLMODE: 'require',
  });
  assert.equal(describeTarget(parts), 'user@db.example.com:6543/mydb');

  assert.deepEqual(connectionParts('postgresql://postgres:postgres@127.0.0.1:5432/postgres'), {
    PGHOST: '127.0.0.1',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGPASSWORD: 'postgres',
    PGDATABASE: 'postgres',
  });

  assert.equal(connectionParts(''), null);
  assert.equal(connectionParts('   '), null);
  assert.throws(() => connectionParts('not a url'), /DATABASE_URL 格式不正确/);
  assert.throws(() => connectionParts('mysql://u:p@h/db'), /必须是 postgres/);
});

test('backupDatabase：缺少 / 非法 DATABASE_URL 时立即抛错（不依赖 pg_dump）', async () => {
  const outDir = path.join(workDir, 'backup-errors');
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(backupDatabase({ outDir }), /缺少 DATABASE_URL/);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }

  await assert.rejects(
    backupDatabase({ outDir, databaseUrl: 'mysql://u:p@h/db' }),
    /必须是 postgres|格式不正确/
  );
});

test('backupDatabase：pg_dump 导出测试库，文件含 PostgreSQL dump 头，支持 --force 覆盖', async (t) => {
  if (!requireDatabase(t)) return;
  if (!pgDumpAvailable()) {
    t.skip('pg_dump 不可用（未安装 PostgreSQL 客户端），跳过实际备份测试');
    return;
  }
  const dumpMajor = pgDumpMajorVersion();
  const serverMajor = await serverMajorVersion();
  if (dumpMajor !== null && dumpMajor < serverMajor) {
    t.skip('pg_dump ' + dumpMajor + ' 低于 PostgreSQL server ' + serverMajor + '，跳过实际备份测试（容器内使用匹配版本的客户端）');
    return;
  }

  const outDir = path.join(workDir, 'backup-out');
  const now = new Date(2026, 0, 2, 3, 4, 5);
  const result = await backupDatabase({ outDir, now });

  assert.equal(path.basename(result.file), 'chenlong-20260102-030405.sql');
  assert.ok(result.size > 0, '备份文件大小应大于 0');
  assert.equal(result.size, fs.statSync(result.file).size);
  assert.match(result.target, new RegExp(temp.database), '备份目标应包含测试库名');
  const content = fs.readFileSync(result.file, 'utf8');
  assert.ok(content.includes('PostgreSQL database dump'), 'plain dump 文件头应含 PostgreSQL database dump');

  // 同名目标默认拒绝覆盖
  await assert.rejects(backupDatabase({ outDir, now }), /已存在/);

  // --force 覆盖后仍是有效 dump
  const forced = await backupDatabase({ outDir, now, force: true });
  assert.equal(forced.file, result.file);
  assert.ok(forced.size > 0);
  assert.ok(fs.readFileSync(forced.file, 'utf8').includes('PostgreSQL database dump'));
});
