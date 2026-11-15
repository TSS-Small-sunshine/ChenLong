'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');
const { createTempDir, removeDir } = require('../helpers/temp-db');
const {
  backupDatabase,
  backupFileName,
  resolveDbFile,
  resolveOutDir,
  parseArgs,
  DEFAULT_DB_FILE,
  DEFAULT_OUT_DIR,
  BACKUP_PREFIX,
} = require('../../scripts/backup-db');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const FIXED_TIME = new Date(2026, 0, 2, 3, 4, 5);

let workDir;
let sourceFile;
let writer;
let outSeq = 0;

function nextOutDir() {
  outSeq += 1;
  return path.join(workDir, 'backups-' + outSeq);
}

function readSourceRows() {
  return writer
    .prepare('SELECT name FROM items ORDER BY id')
    .all()
    .map((row) => row.name);
}

function openReadonly(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

before(() => {
  workDir = createTempDir('chenlong-backup-test-');
  sourceFile = path.join(workDir, 'chenlong.db');
  writer = new Database(sourceFile);
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = writer.prepare('INSERT INTO items (name) VALUES (?)');
  for (let index = 0; index < 5; index += 1) insert.run('item-' + index);
});

after(() => {
  try {
    writer.close();
  } catch {
    /* 已关闭 */
  }
  removeDir(workDir);
});

test('backupDatabase：WAL 中未 checkpoint 的数据也进入备份，quick_check=ok', async () => {
  const outDir = nextOutDir();
  // writer 保持打开，最新数据仍在 -wal 中，模拟运行中的服务
  const result = await backupDatabase({ dbFile: sourceFile, outDir, now: FIXED_TIME });

  assert.equal(result.sourceFile, sourceFile);
  assert.equal(path.basename(result.destinationFile), 'chenlong-20260102-030405.db');
  assert.equal(result.quickCheck, 'ok');
  assert.ok(result.destinationSize > 0);
  assert.equal(result.destinationSize, fs.statSync(result.destinationFile).size);

  const copy = openReadonly(result.destinationFile);
  try {
    assert.deepEqual(
      copy.prepare('SELECT name FROM items ORDER BY id').all().map((row) => row.name),
      ['item-0', 'item-1', 'item-2', 'item-3', 'item-4']
    );
  } finally {
    copy.close();
  }

  // 备份收敛为单文件，不残留 -wal/-shm
  assert.deepEqual(fs.readdirSync(outDir), ['chenlong-20260102-030405.db']);
  // 源库不受影响，可继续写入
  writer.prepare('INSERT INTO items (name) VALUES (?)').run('after-backup');
});

test('backupDatabase：同名目标默认拒绝覆盖，force 时覆盖且文件有效', async () => {
  const outDir = nextOutDir();
  const now = new Date(2026, 0, 3, 4, 5, 6);
  const first = await backupDatabase({ dbFile: sourceFile, outDir, now });
  await assert.rejects(backupDatabase({ dbFile: sourceFile, outDir, now }), /已存在/);

  // 先破坏目标文件，再强制覆盖
  fs.writeFileSync(first.destinationFile, 'not-a-sqlite-database');
  const second = await backupDatabase({ dbFile: sourceFile, outDir, now, force: true });
  assert.equal(second.quickCheck, 'ok');
  assert.equal(second.destinationFile, first.destinationFile);

  const copy = openReadonly(second.destinationFile);
  try {
    assert.deepEqual(
      copy.prepare('SELECT name FROM items ORDER BY id').all().map((row) => row.name),
      readSourceRows()
    );
  } finally {
    copy.close();
  }
});

test('backupDatabase：源库不存在或不是文件时抛错', async () => {
  await assert.rejects(
    backupDatabase({ dbFile: path.join(workDir, 'missing.db'), outDir: nextOutDir() }),
    /源数据库不存在/
  );
  const dirAsDb = nextOutDir();
  fs.mkdirSync(dirAsDb, { recursive: true });
  await assert.rejects(backupDatabase({ dbFile: dirAsDb, outDir: nextOutDir() }), /源数据库不存在|不是文件/);
});

test('backupFileName / resolveDbFile / resolveOutDir / parseArgs', () => {
  assert.equal(BACKUP_PREFIX, 'chenlong-');
  assert.equal(backupFileName(new Date(2026, 10, 15, 16, 8, 9)), 'chenlong-20261115-160809.db');

  assert.equal(resolveDbFile(''), DEFAULT_DB_FILE);
  assert.equal(resolveDbFile('   '), DEFAULT_DB_FILE);
  assert.equal(resolveDbFile('data/chenlong.db'), path.join(PROJECT_ROOT, 'data', 'chenlong.db'));
  const absolute = path.join(workDir, 'abs.db');
  assert.equal(resolveDbFile(absolute), absolute);

  assert.equal(resolveOutDir(''), DEFAULT_OUT_DIR);
  assert.equal(resolveOutDir(absolute), absolute);

  assert.deepEqual(parseArgs([]), { outDir: null, dbFile: null, force: false, help: false });
  assert.deepEqual(parseArgs(['--out', 'x', '--db', 'y', '--force']), {
    outDir: 'x',
    dbFile: 'y',
    force: true,
    help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--out']), /--out/);
  assert.throws(() => parseArgs(['--db']), /--db/);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
});
