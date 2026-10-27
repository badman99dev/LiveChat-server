// Client identity verification — Firebase JWT + chat handle.
//
// The app signs EVERY chat request with its Firebase ID token and the handle
// the backend assigned it. Both are checked against the BlazeMovies identity
// endpoint, which is the only source of truth: this server never trusts a
// display name typed by a client.
//
// Verification is cached per (jwt + handle) COMBINATION, so the same person
// costs one upstream call instead of one per message. A brand-new combination
// is verified again — and each IP may only introduce a small number of new
// combinations per window (default 10 per 30 min), which stops identity
// guessing/spam from a single source.
//
// Env:
//   IDENTITY_URL              identity endpoint
//   IDENTITY_SECRET           shared secret (matches CHAT_IDENTITY_SECRET)
//   IDENTITY_REQUIRED         "true" => reject clients that send no identity
//   IDENTITY_CACHE_MS         TTL of a positive verification (default 300000)
//   IDENTITY_NEGATIVE_MS      TTL of a cached rejection (default 30000)
//   IDENTITY_COMBO_MAX        new combinations per IP per window (default 10)
//   IDENTITY_COMBO_WINDOW_MS  window length (default 1800000 = 30 min)
//   IDENTITY_TIMEOUT_MS       upstream call timeout (default 4000)
const crypto = require('node:crypto');

const URL_ = process.env.IDENTITY_URL || '';
const SECRET = process.env.IDENTITY_SECRET || '';
const REQUIRED = String(process.env.IDENTITY_REQUIRED || '').toLowerCase() === 'true';
const CACHE_MS = Number(process.env.IDENTITY_CACHE_MS || 300_000);
const NEGATIVE_MS = Number(process.env.IDENTITY_NEGATIVE_MS || 30_000);
const COMBO_MAX = Number(process.env.IDENTITY_COMBO_MAX || 10);
const COMBO_WINDOW_MS = Number(process.env.IDENTITY_COMBO_WINDOW_MS || 1_800_000);
const TIMEOUT_MS = Number(process.env.IDENTITY_TIMEOUT_MS || 4000);

/** sha256(jwt + "\n" + handle) -> { until, result } */
const cache = new Map();
/** ip -> { start, keys:Set<comboKey> } — new combinations seen this window */
const ipCombos = new Map();

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

function comboKey(jwt, handle) {
  return crypto.createHash('sha256').update(jwt).update('\n').update(handle).digest('hex');
}

function pruneStore() {
  const now = Date.now();
  if (cache.size > 5000) {
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
  }
  if (ipCombos.size > 5000) {
    for (const [ip, v] of ipCombos) if (now - v.start >= COMBO_WINDOW_MS) ipCombos.delete(ip);
  }
}

/**
 * Count a new (jwt + handle) combination against its IP.
 * Cached combinations never get here, so only genuinely new identities cost a slot.
 * @returns {{ok:true}|{ok:false,retryAfter:number}}
 */
function takeComboSlot(ip, key) {
  const id = ip || 'unknown';
  const now = Date.now();

  let entry = ipCombos.get(id);
  if (!entry || now - entry.start >= COMBO_WINDOW_MS) {
    entry = { start: now, keys: new Set() };
    ipCombos.set(id, entry);
  }

  if (entry.keys.has(key)) return { ok: true };
  if (COMBO_MAX > 0 && entry.keys.size >= COMBO_MAX) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.start + COMBO_WINDOW_MS - now) / 1000)) };
  }
  entry.keys.add(key);
  pruneStore();
  return { ok: true };
}

/**
 * Verify the caller.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} [ip] client IP, used for the new-combination budget
 * @returns {Promise<
 *   {ok:true,uid:string,handle:string,cached?:boolean} |
 *   {ok:false,legacy:true} |
 *   {ok:false,code:string,message:string,status?:number,retryAfter?:number}>}
 */
async function verify(req, ip = '') {
  const { jwt, handle, present } = clientIdentity(req);

  if (!configured()) return { ok: false, legacy: true };
  if (!present) {
    return REQUIRED
      ? { ok: false, code: 'identity_required', message: 'chat identity required', status: 403 }
      : { ok: false, legacy: true };
  }
  if (!jwt || !handle) {
    return { ok: false, code: 'identity_required', message: 'incomplete chat identity', status: 403 };
  }

  const key = comboKey(jwt, handle);

  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return { ...hit.result, cached: true };

  // New combination from this IP? Spend one slot (and only one, even on failure).
  const slot = takeComboSlot(ip, key);
  if (!slot.ok) {
    return {
      ok: false,
      code: 'identity_rate_limited',
      message: 'too many new chat identities from this address, try again later',
      status: 429,
      retryAfter: slot.retryAfter,
    };
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
      const result = {
        ok: false,
        code: 'identity_rejected',
        message: (data && (data.message || data.error)) || 'chat identity rejected',
        status: resp.status === 401 ? 401 : 403,
      };
      // Short negative cache: a repeated bad combination must not hammer the
      // identity endpoint, but a fixed client can retry a moment later.
      cache.set(key, { until: Date.now() + NEGATIVE_MS, result });
      return result;
    }

    const result = { ok: true, uid: String(payload.uid), handle: String(payload.handle) };
    cache.set(key, { until: Date.now() + CACHE_MS, result });
    return result;
  } catch (e) {
    // Never fall back to an unverified name while identity is configured.
    return { ok: false, code: 'identity_unreachable', message: 'chat identity could not be verified', status: 503 };
  }
}

module.exports = { configured, required, clientIdentity, verify };