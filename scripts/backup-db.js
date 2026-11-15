#!/usr/bin/env node
'use strict';

/**
 * 尘龙 ChenLong 数据库一致性备份脚本。
 *
 * 通过 better-sqlite3 的 db.backup()（SQLite Online Backup API）备份，
 * 会自动包含 WAL 中尚未 checkpoint 的数据，避免直接复制主库漏数据。
 * 备份完成后把目标库收敛为单文件（journal_mode=DELETE），并用只读连接做
 * PRAGMA quick_check 校验。
 *
 * 用法：node scripts/backup-db.js [--out <目录>] [--db <文件>] [--force]
 */

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB_FILE = path.join(PROJECT_ROOT, 'data', 'chenlong.db');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'data', 'backups');
const BACKUP_PREFIX = 'chenlong-';

const USAGE = [
  '用法：node scripts/backup-db.js [选项]',
  '',
  '一致性备份 SQLite 数据库（WAL 安全，使用 better-sqlite3 的 backup 接口）。',
  '',
  '选项：',
  '  --out <目录>   备份输出目录，默认 <项目>/data/backups',
  '  --db <文件>    源数据库路径（优先于 DB_PATH 环境变量）',
  '  --force        目标文件已存在时覆盖（默认报错退出）',
  '  -h, --help     显示本帮助',
  '',
  '环境变量：',
  '  DB_PATH        源数据库路径；相对路径按项目根目录解析，默认 data/chenlong.db',
  '',
  '退出码：0 成功；1 运行失败；2 参数错误',
].join('\n');

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 生成 YYYYMMDD-HHmmss 时间戳（本地时区，便于运维辨认） */
function timestamp(date = new Date()) {
  return (
    String(date.getFullYear()) +
    pad2(date.getMonth() + 1) +
    pad2(date.getDate()) +
    '-' +
    pad2(date.getHours()) +
    pad2(date.getMinutes()) +
    pad2(date.getSeconds())
  );
}

function backupFileName(date = new Date()) {
  return BACKUP_PREFIX + timestamp(date) + '.db';
}

function resolveDbFile(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_DB_FILE;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(PROJECT_ROOT, value);
}

function resolveOutDir(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_OUT_DIR;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(process.cwd(), value);
}

function parseArgs(argv) {
  const options = { outDir: null, dbFile: null, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out' || arg === '-o') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--out 需要一个目录参数');
      options.outDir = value;
      index += 1;
    } else if (arg === '--db') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--db 需要一个数据库文件参数');
      options.dbFile = value;
      index += 1;
    } else if (arg === '--force' || arg === '-f') {
      options.force = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error('未知参数：' + arg);
    }
  }
  return options;
}

function removeSidecars(file) {
  for (const suffix of ['-wal', '-shm']) {
    try {
      fs.rmSync(file + suffix, { force: true });
    } catch {
      /* 清理辅助文件失败不阻断备份 */
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * 执行一次一致性备份（不打印，供测试直接调用）。
 * @returns {Promise<{sourceFile:string,sourceSize:number,destinationFile:string,destinationSize:number,quickCheck:string}>}
 */
async function backupDatabase({ dbFile, outDir, force = false, now = new Date() } = {}) {
  if (typeof dbFile !== 'string' || !dbFile.trim()) throw new Error('未指定源数据库路径');
  const sourceFile = path.resolve(dbFile);
  if (!fs.existsSync(sourceFile)) throw new Error('源数据库不存在：' + sourceFile);
  const sourceStat = fs.statSync(sourceFile);
  if (!sourceStat.isFile()) throw new Error('源路径不是文件：' + sourceFile);

  const outputDir = path.resolve(outDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const destinationFile = path.join(outputDir, backupFileName(now));

  if (fs.existsSync(destinationFile)) {
    if (!force) throw new Error('目标文件已存在：' + destinationFile + '（如需覆盖请加 --force）');
    fs.rmSync(destinationFile, { force: true });
  }
  removeSidecars(destinationFile);

  let source = null;
  try {
    // 只读打开源库：备份是纯读操作，绝不改动真实数据（含 -wal 中未 checkpoint 的数据）
    source = new Database(sourceFile, { readonly: true, fileMustExist: true });
    await source.backup(destinationFile);
  } catch (err) {
    try {
      fs.rmSync(destinationFile, { force: true });
    } catch {
      /* 清理失败交给上层报错 */
    }
    removeSidecars(destinationFile);
    throw new Error('备份失败：' + (err && err.message ? err.message : String(err)));
  } finally {
    if (source) {
      try {
        source.close();
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }

  // 把备份收敛为单文件（备份库会继承 WAL 标记，缺少 -wal/-shm 时复制走会让人困惑）
  let quickCheck = '';
  try {
    const dest = new Database(destinationFile);
    try {
      dest.pragma('journal_mode = DELETE');
      quickCheck = String(dest.pragma('quick_check', { simple: true }));
    } finally {
      dest.close();
    }
  } catch (err) {
    removeSidecars(destinationFile);
    throw new Error('备份文件校验失败：' + (err && err.message ? err.message : String(err)));
  }
  removeSidecars(destinationFile);

  if (quickCheck !== 'ok') {
    try {
      fs.rmSync(destinationFile, { force: true });
    } catch {
      /* 忽略 */
    }
    throw new Error('备份文件 PRAGMA quick_check 未通过：' + quickCheck);
  }

  // 最终用只读连接再确认一次：备份文件脱离源库后仍可独立打开
  let readable = false;
  try {
    const check = new Database(destinationFile, { readonly: true, fileMustExist: true });
    try {
      readable = String(check.pragma('quick_check', { simple: true })) === 'ok';
    } finally {
      check.close();
    }
  } catch (err) {
    readable = false;
  }
  removeSidecars(destinationFile);
  if (!readable) throw new Error('备份文件只读校验失败：无法独立打开或 quick_check 非 ok');

  return {
    sourceFile,
    sourceSize: sourceStat.size,
    destinationFile,
    destinationSize: fs.statSync(destinationFile).size,
    quickCheck,
  };
}

function printResult(result) {
  console.log('[backup] 源数据库：' + result.sourceFile + '（' + formatBytes(result.sourceSize) + '）');
  console.log(
    '[backup] 备份文件：' + result.destinationFile + '（' + formatBytes(result.destinationSize) + '）'
  );
  console.log('[backup] 一致性校验：PRAGMA quick_check = ' + result.quickCheck);
  console.log('[backup] 完成。恢复时请先停止服务，再用备份文件替换 chenlong.db（并删除同目录 -wal/-shm）。');
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error('[backup] 参数错误：' + err.message);
    console.error(USAGE);
    return 2;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const dbFile = resolveDbFile(options.dbFile !== null ? options.dbFile : process.env.DB_PATH);
  const outDir = resolveOutDir(options.outDir);
  try {
    const result = await backupDatabase({ dbFile, outDir, force: options.force });
    printResult(result);
    return 0;
  } catch (err) {
    console.error('[backup] 失败：' + (err && err.message ? err.message : String(err)));
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('[backup] 未捕获错误：', err);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_DB_FILE,
  DEFAULT_OUT_DIR,
  BACKUP_PREFIX,
  timestamp,
  backupFileName,
  resolveDbFile,
  resolveOutDir,
  parseArgs,
  backupDatabase,
  printResult,
  main,
};
