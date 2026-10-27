// Client identity verification — Firebase JWT + chat handle.
//
// The app signs EVERY chat request with its Firebase ID token and the handle
// the backend assigned it. Both are checked against the BlazeMovies identity
// endpoint, which is the only source of truth: this server never trusts a
// display name typed by a client.
//
// Env:
//   IDENTITY_URL        identity endpoint (default: the BlazeMovies API)
//   IDENTITY_SECRET     shared secret — must match CHAT_IDENTITY_SECRET on the
//                       backend. Unset => verification is OFF (legacy mode).
//   IDENTITY_REQUIRED   "true" => reject clients that send no identity at all
//   IDENTITY_CACHE_MS   TTL of a positive verification (default 300000)
//   IDENTITY_TIMEOUT_MS upstream call timeout (default 4000)
const crypto = require('node:crypto');

const URL_ = process.env.IDENTITY_URL || '';
const SECRET = process.env.IDENTITY_SECRET || '';
const REQUIRED = String(process.env.IDENTITY_REQUIRED || '').toLowerCase() === 'true';
const CACHE_MS = Number(process.env.IDENTITY_CACHE_MS || 300_000);
const TIMEOUT_MS = Number(process.env.IDENTITY_TIMEOUT_MS || 4000);

const cache = new Map(); // sha256(jwt) -> { uid, handle, until }

function configured() {
  return Boolean(URL_ && SECRET);
}

function required() {
  return REQUIRED;
}

function bearer(req) {
  const raw = req.headers['authorization'] || req.headers['x-auth-token'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
  return m ? m[1].trim() : '';
}

function chatHandle(req) {
  return String(req.headers['x-chat-handle'] || '').trim();
}

/** What the client sent us (empty on legacy builds that predate identity). */
function clientIdentity(req) {
  const jwt = bearer(req);
  const handle = chatHandle(req);
  return { jwt, handle, present: Boolean(jwt || handle) };
}

function prune() {
  if (cache.size < 5000) return;
  const now = Date.now();
  for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
}

/**
 * Verify the caller.
 * @returns {Promise<{ok:true,uid:string,handle:string,cached?:boolean}
 *   | {ok:false,legacy:true}
 *   | {ok:false,code:string,message:string}>}
 */
async function verify(req) {
  const { jwt, handle, present } = clientIdentity(req);

  if (!configured()) return { ok: false, legacy: true };
  if (!present) {
    return REQUIRED
      ? { ok: false, code: 'identity_required', message: 'chat identity required' }
      : { ok: false, legacy: true };
  }
  if (!jwt || !handle) {
    return { ok: false, code: 'identity_required', message: 'incomplete chat identity' };
  }

  const key = crypto.createHash('sha256').update(jwt).digest('hex');
  const hit = cache.get(key);
  if (hit && hit.until > Date.now() && hit.handle === handle) {
    return { ok: true, uid: hit.uid, handle: hit.handle, cached: true };
  }

  try {
    const resp = await fetch(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-identity-secret': SECRET,
      },
      body: JSON.stringify({ jwt, handle }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await resp.json().catch(() => null);
    const payload = data && data.data ? data.data : null;

    if (!resp.ok || !payload || !payload.uid || !payload.handle) {
      return {
        ok: false,
        code: 'identity_rejected',
        message: (data && (data.message || data.error)) || 'chat identity rejected',
      };
    }

    cache.set(key, { uid: String(payload.uid), handle: String(payload.handle), until: Date.now() + CACHE_MS });
    prune();
    return { ok: true, uid: String(payload.uid), handle: String(payload.handle) };
  } catch (e) {
    // Never fall back to an unverified name while identity is configured.
    return { ok: false, code: 'identity_unreachable', message: 'chat identity could not be verified' };
  }
}

module.exports = { configured, required, clientIdentity, verify };
