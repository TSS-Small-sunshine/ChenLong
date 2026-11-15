'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 测试固定密钥：32 字节（64 位 hex），绝不读真实 .env 里的业务密钥
const TEST_ENCRYPTION_KEY_HEX = '11'.repeat(32);
const TEST_ENCRYPTION_KEY_HEX_ALT = '22'.repeat(32);
const TEST_SESSION_SECRET = 'chenlong-test-session-secret-please-change';

function createTempDir(prefix = 'chenlong-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir) {
  // Windows 上 SQLite 关闭后文件句柄释放可能有毫秒级延迟，删除时带重试
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * 把 DB_PATH 指向 os.tmpdir() 下的全新临时库，并清除会触发初始管理员播种的 ADMIN_* 变量。
 * 必须在 require server/database/* 之前调用；测试结束后调用 cleanup()。
 */
function installTempDatabase(prefix = 'chenlong-test-db-') {
  const dir = createTempDir(prefix);
  const file = path.join(dir, 'chenlong.db');
  process.env.DB_PATH = file;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  return {
    dir,
    file,
    cleanup() {
      removeDir(dir);
    },
  };
}

function uniqueId() {
  return crypto.randomUUID();
}

module.exports = {
  TEST_ENCRYPTION_KEY_HEX,
  TEST_ENCRYPTION_KEY_HEX_ALT,
  TEST_SESSION_SECRET,
  createTempDir,
  removeDir,
  installTempDatabase,
  uniqueId,
};
