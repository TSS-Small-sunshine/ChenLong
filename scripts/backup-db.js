#!/usr/bin/env node
'use strict';

/**
 * 尘龙 ChenLong · PostgreSQL 一致性备份脚本
 *
 * 使用 pg_dump（plain SQL 格式）导出当前数据库，默认输出到 data/backups/。
 * 密码不通过命令行参数传递：脚本会把 DATABASE_URL 拆成 PG* 环境变量后交给子进程。
 *
 * 用法：node scripts/backup-db.js [--out <目录>] [--database-url <url>] [--force]
 * 退出码：0 成功；1 运行失败；2 参数错误
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUT_DIR = path.join(PROJECT_ROOT, 'data', 'backups');
const BACKUP_PREFIX = 'chenlong-';

const USAGE = [
  '用法：node scripts/backup-db.js [选项]',
  '',
  '使用 pg_dump 对 PostgreSQL 数据库做一致性备份（默认 plain SQL 格式）。',
  '',
  '选项：',
  '  --out <目录>          备份输出目录，默认 <项目>/data/backups',
  '  --database-url <url>  源数据库连接串（优先于 DATABASE_URL 环境变量）',
  '  --force               目标文件已存在时覆盖（默认报错退出）',
  '  -h, --help            显示本帮助',
  '',
  '环境变量：',
  '  DATABASE_URL     postgres://user:pass@host:port/database',
  '  PG_DUMP          pg_dump 可执行文件路径（默认 PATH 中的 pg_dump）',
  '',
  '提示：缺少 pg_dump 时请安装 PostgreSQL 客户端（如 postgresql-client），或在容器内执行。',
].join('\n');

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 生成 YYYYMMDD-HHmmss 时间戳（本地时区） */
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
  return BACKUP_PREFIX + timestamp(date) + '.sql';
}

function resolveOutDir(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_OUT_DIR;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(process.cwd(), value);
}

function parseArgs(argv) {
  const options = { outDir: null, databaseUrl: null, force: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out' || arg === '-o') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--out 需要一个目录参数');
      options.outDir = value;
      index += 1;
    } else if (arg === '--database-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--database-url 需要一个连接串参数');
      options.databaseUrl = value;
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

function connectionParts(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL 格式不正确');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL 必须是 postgres:// 或 postgresql://');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const env = {
    PGHOST: parsed.hostname || '127.0.0.1',
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(parsed.password || ''),
    PGDATABASE: database || 'postgres',
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

function describeTarget(env) {
  return (env.PGUSER || '') + '@' + (env.PGHOST || '') + ':' + (env.PGPORT || '') + '/' + (env.PGDATABASE || '');
}

function findPgDump() {
  return process.env.PG_DUMP || 'pg_dump';
}

function runPgDump(file, pgEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(findPgDump(), ['--format=plain', '--no-owner', '--no-privileges', '--file', file], {
      env: Object.assign({}, process.env, pgEnv),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      reject(
        new Error(
          '无法执行 pg_dump（' +
            (err.code || err.message) +
            '）：请安装 PostgreSQL 客户端（如 postgresql-client），或在包含 pg_dump 的容器内运行。'
        )
      );
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      return reject(new Error('pg_dump 失败（exit ' + code + '）：' + stderr.trim().slice(0, 500)));
    });
  });
}

/**
 * 执行一次备份（不打印，供测试直接调用）。
 * @returns {Promise<{file:string,size:number,target:string}>}
 */
async function backupDatabase({ outDir, databaseUrl, force = false, now = new Date() } = {}) {
  const url = databaseUrl || process.env.DATABASE_URL;
  const pgEnv = connectionParts(url);
  if (!pgEnv) throw new Error('缺少 DATABASE_URL（或 --database-url）');

  const dir = outDir ? resolveOutDir(outDir) : DEFAULT_OUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, backupFileName(now));
  if (!force && fs.existsSync(file)) throw new Error('目标备份已存在：' + file + '，加 --force 覆盖');

  await runPgDump(file, pgEnv);

  const stat = fs.statSync(file);
  if (!stat.size) throw new Error('pg_dump 输出为空：' + file);
  const head = fs.readFileSync(file, { encoding: 'utf8' }).slice(0, 4000);
  if (head.indexOf('PostgreSQL database dump') === -1) {
    throw new Error('备份文件校验失败：文件头不是 PostgreSQL dump');
  }
  return { file, size: stat.size, target: describeTarget(pgEnv) };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('[backup] ' + err.message);
    console.error(USAGE);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  try {
    const databaseUrl = options.databaseUrl || process.env.DATABASE_URL;
    const pgEnv = connectionParts(databaseUrl);
    if (!pgEnv) throw new Error('缺少 DATABASE_URL（或 --database-url）');
    console.log('[backup] 源数据库：' + describeTarget(pgEnv));
    const result = await backupDatabase({
      outDir: options.outDir,
      databaseUrl,
      force: options.force,
    });
    console.log('[backup] 备份文件：' + result.file + '（' + result.size + ' B）');
    console.log('[backup] 完成。恢复示例：psql <连接串> -f ' + path.basename(result.file));
    process.exit(0);
  } catch (err) {
    console.error('[backup] 失败：' + err.message);
    process.exit(1);
  }
}

module.exports = {
  backupDatabase,
  backupFileName,
  resolveOutDir,
  parseArgs,
  connectionParts,
  describeTarget,
  timestamp,
  DEFAULT_OUT_DIR,
};

if (require.main === module) {
  main();
}
