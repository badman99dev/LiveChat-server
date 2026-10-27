// Hardcoded deployment config — Render par kuch set karne ki zarurat nahi.
//
// Har value ko env var se override kiya ja sakta hai (same naam), jo local
// testing ke liye useful hai. Env set na ho to yahan wali value use hoti hai.
module.exports = {
  // ── client identity (Firebase JWT + chat handle) ──────────
  // POST /v1/internal/chat-identity on the BlazeMovies backend.
  IDENTITY_URL: 'https://blazemovies.badman993944.workers.dev/v1/internal/chat-identity',

  // Khali = env se lo. Render ke environment me IDENTITY_SECRET set karo —
  // value wahi jo BlazeMovies ke CHAT_IDENTITY_SECRET me hai.
  IDENTITY_SECRET: '',

  // true = identity (Firebase JWT + handle) is MANDATORY: a client that sends
  // no identity headers is rejected with 403 identity_required, so nobody can
  // post under a random uid / client-typed name. Old builds must be updated.
  IDENTITY_REQUIRED: true,

  IDENTITY_CACHE_MS: 300_000,      // verified (jwt+handle) combo TTL: 5 min
  IDENTITY_NEGATIVE_MS: 30_000,    // cached rejection TTL: 30 s
  IDENTITY_COMBO_MAX: 10,          // NEW combos per IP ...
  IDENTITY_COMBO_WINDOW_MS: 1_800_000, // ... per 30 min window
  IDENTITY_TIMEOUT_MS: 4_000,      // upstream identity call timeout

  // Real uids never leave this server: clients only ever see
  // 'u' + HMAC-SHA256(WIRE_ID_SALT, uid).slice(0,16).
  WIRE_ID_SALT: 'livechat-wire-id-v2',

  // ── rooms ─────────────────────────────────────────────────
  // Room keys ka secret Render ke env (ROOM_KEY_SECRET) se aata hai — yahan
  // kuch hardcode nahi, taaki live value se takra na jaye.
};