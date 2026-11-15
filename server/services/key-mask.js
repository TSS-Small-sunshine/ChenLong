const MASKED_KEY = '••••';

function maskKey(plain) {
  const value = typeof plain === 'string' ? plain : '';
  if (value.length < 12) return MASKED_KEY;
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

module.exports = { maskKey, MASKED_KEY };
