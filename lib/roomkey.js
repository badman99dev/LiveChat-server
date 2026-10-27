// Room Access Key (RAK) — protocol v1
//
// An encrypted, reusable, self-describing token that grants entry to a chat
// room. The *issuer* (a separate service, e.g. your match/admin backend) mints
// keys with issueRoomKey(). This chat server only ever *verifies* them with
// verifyRoomKey(). Both sides share one symmetric secret (ROOM_KEY_SECRET),
// so no DB lookup and no call-back to the issuer is needed.
//
// Wire format:
//     rk1.<base64url( iv(12) || tag(16) || ciphertext )>
//
// Cipher: AES-256-GCM. AAD binds the version + purpose, so a token minted for
// anything else can never be replayed here.

const crypto = require('node:crypto');

const PREFIX = 'rk1';
const VERSION = 1;
const AAD = Buffer.from('livechat:roomkey:v1', 'utf8');
const IV_LEN = 12;
const TAG_LEN = 16;
const SALTD = 'livechat:roomkey:v1';

const RID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_NAME = 64;

class RoomKeyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'RoomKeyError';
    this.code = code;
  }
}

// Accepts a 64-char hex string, a base64 32-byte blob, or any passphrase
// (passphrase is stretched with scrypt). Returns a 32-byte Buffer.
function deriveKey(secret) {
  if (!secret) throw new RoomKeyError('no_secret', 'ROOM_KEY_SECRET is not set');
  const s = String(secret).trim();

  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');

  if (/^[A-Za-z0-9+/_-]{43,44}={0,2}$/.test(s)) {
    try {
      const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (buf.length === 32) return buf;
    } catch {
      /* fall through to scrypt */
    }
  }

  return crypto.scryptSync(s, SALTD, 32);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function normalizePayload(input = {}) {
  const rid = String(input.rid ?? input.id ?? input.room ?? '').trim();
  if (!RID_RE.test(rid)) {
    throw new RoomKeyError('bad_room', 'room id must be 1-64 chars of A-Z a-z 0-9 _ -');
  }
  const name = String(input.name ?? rid).trim();
  if (!name || name.length > MAX_NAME) {
    throw new RoomKeyError('bad_name', `room name must be 1-${MAX_NAME} chars`);
  }
  return { rid, name };
}

// issueRoomKey({ rid, name, meta }, { secret, ttlSeconds })
//   ttlSeconds: optional. Omit for a non-expiring key (discouraged for prod).
function issueRoomKey(payload, { secret, ttlSeconds } = {}) {
  const key = deriveKey(secret);
  const { rid, name } = normalizePayload(payload);

  const now = Math.floor(Date.now() / 1000);
  const body = { v: VERSION, rid, name, iat: now };
  if (payload.meta && typeof payload.meta === 'object') body.meta = payload.meta;
  if (ttlSeconds && ttlSeconds > 0) body.exp = now + Math.floor(ttlSeconds);

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}.${b64u(Buffer.concat([iv, tag, ct]))}`;
}

// verifyRoomKey(token, { secret }) -> { rid, name, iat, exp, meta }
// Throws RoomKeyError with a .code on any problem. Never touches the network.
function verifyRoomKey(token, { secret } = {}) {
  const key = deriveKey(secret);

  if (typeof token !== 'string') throw new RoomKeyError('bad_format');
  const dot = token.indexOf('.');
  if (dot !== PREFIX.length || token.slice(0, dot) !== PREFIX) {
    throw new RoomKeyError('bad_format', 'unknown key format');
  }

  let raw;
  try {
    raw = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    throw new RoomKeyError('bad_format');
  }
  if (raw.length < IV_LEN + TAG_LEN + 1) throw new RoomKeyError('bad_format');

  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);

  let pt;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new RoomKeyError('bad_signature', 'key could not be verified');
  }

  let body;
  try {
    body = JSON.parse(pt.toString('utf8'));
  } catch {
    throw new RoomKeyError('bad_payload');
  }

  if (body.v !== VERSION) throw new RoomKeyError('bad_version');
  if (!RID_RE.test(String(body.rid || ''))) throw new RoomKeyError('bad_room');

  const name = String(body.name || '').trim();
  if (!name || name.length > MAX_NAME) throw new RoomKeyError('bad_name');

  const now = Math.floor(Date.now() / 1000);
  if (body.exp && now > Number(body.exp)) throw new RoomKeyError('expired', 'key has expired');

  return {
    rid: body.rid,
    name,
    iat: Number(body.iat) || null,
    exp: Number(body.exp) || null,
    meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
  };
}

// Best-effort read of rid/name without verifying (debug / logging only).
function peekRoomKey(token) {
  try {
    const dot = String(token).indexOf('.');
    if (dot < 0) return null;
    const raw = Buffer.from(String(token).slice(dot + 1), 'base64url');
    return { bytes: raw.length, prefix: String(token).slice(0, dot) };
  } catch {
    return null;
  }
}

module.exports = {
  PREFIX,
  VERSION,
  RID_RE,
  RoomKeyError,
  deriveKey,
  issueRoomKey,
  verifyRoomKey,
  peekRoomKey,
};
