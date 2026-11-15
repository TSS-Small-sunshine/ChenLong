const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,24}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;
const NICKNAME_MIN = 1;
const NICKNAME_MAX = 20;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateUsername(raw) {
  const value = normalizeText(raw);
  if (!value) return { ok: false, message: '请输入用户名' };
  if (!USERNAME_PATTERN.test(value)) {
    return { ok: false, message: '用户名需为 3–24 位字母、数字或下划线' };
  }
  return { ok: true, value };
}

function validatePassword(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (!value) return { ok: false, message: '请输入密码' };
  if (value.length < PASSWORD_MIN || value.length > PASSWORD_MAX) {
    return { ok: false, message: '密码长度需为 6–64 个字符' };
  }
  return { ok: true, value };
}

function validateNickname(raw) {
  const value = normalizeText(raw);
  if (!value) return { ok: false, message: '请输入昵称' };
  if (value.length < NICKNAME_MIN || value.length > NICKNAME_MAX) {
    return { ok: false, message: '昵称长度需为 1–20 个字符' };
  }
  return { ok: true, value };
}

function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    role: row.role,
    created_at: row.created_at,
  };
}

module.exports = {
  USERNAME_PATTERN,
  PASSWORD_MIN,
  PASSWORD_MAX,
  NICKNAME_MIN,
  NICKNAME_MAX,
  validateUsername,
  validatePassword,
  validateNickname,
  toPublicUser,
};
