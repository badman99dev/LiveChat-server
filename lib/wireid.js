const crypto = require('node:crypto');
const config = require('../config');

const SALT = process.env.WIRE_ID_SALT || config.WIRE_ID_SALT || 'livechat-wire-id-v2';

function wireId(uid) {
  const raw = String(uid == null ? '' : uid);
  if (!raw) return '';
  const digest = crypto.createHmac('sha256', SALT).update(raw).digest('hex');
  return 'u' + digest.slice(0, 16);
}

module.exports = { wireId };
