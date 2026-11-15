const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/admin');
const settingsStore = require('../services/settings-store');

const router = express.Router();

function readBody(req) {
  const body = req.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

router.get('/', (req, res, next) => {
  try {
    return res.json({ items: settingsStore.readSettings() });
  } catch (err) {
    return next(err);
  }
});

router.patch('/', requireAuth, requireAdmin, (req, res, next) => {
  try {
    const result = settingsStore.updateSettings(readBody(req));
    if (!result.ok) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: result.message } });
    }
    return res.json({ items: result.items });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
