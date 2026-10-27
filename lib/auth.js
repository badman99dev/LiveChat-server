const crypto = require('node:crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const COOKIE_NAME = 'sid';
const MAX_AGE = 60 * 60 * 24 * 30;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 1) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // v2 = the cookie carries the derived 'u...' id, never a real uid. Cookies
    // minted before v2 held real uids, so they are refused (client re-logs in).
    if (data.v !== 2 || !data.uid || !data.name) return null;
    return data;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function serializeCookie(name, value, { maxAge = MAX_AGE, secure = false } = {}) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function sessionFrom(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verify(cookies[COOKIE_NAME]);
}

function issue(user, opts) {
  return serializeCookie(COOKIE_NAME, sign({ v: 2, uid: user.uid, name: user.name }), opts);
}

function clear(opts) {
  return serializeCookie(COOKIE_NAME, '', { ...opts, maxAge: 0 });
}

function newUser(name) {
  return { uid: crypto.randomUUID(), name, v: 2 };
}

module.exports = {
  COOKIE_NAME,
  sessionFrom,
  issue,
  clear,
  newUser,
  sign,
  verify,
};
