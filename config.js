// Hardcoded deployment config — Render par kuch set karne ki zarurat nahi.
//
// Har value ko env var se override kiya ja sakta hai (same naam), jo local
// testing ke liye useful hai. Env set na ho to yahan wali value use hoti hai.
module.exports = {
  // ── client identity (Firebase JWT + chat handle) ──────────
  // POST /v1/internal/chat-identity on the BlazeMovies backend.
  IDENTITY_URL: 'https://blazemovies.badman993944.workers.dev/v1/internal/chat-identity',

  // MUST be identical to CHAT_IDENTITY_SECRET on the BlazeMovies backend.
  IDENTITY_SECRET: '24a8d290483e13f5ee893aacd4ec0be4153ee1b6a8fb36d9c85592bf3efbcb7a',

  // false = older builds (no identity headers) keep working with client-typed
  // names. true = identity is mandatory for everyone.
  IDENTITY_REQUIRED: false,

  IDENTITY_CACHE_MS: 300_000,      // verified (jwt+handle) combo TTL: 5 min
  IDENTITY_NEGATIVE_MS: 30_000,    // cached rejection TTL: 30 s
  IDENTITY_COMBO_MAX: 10,          // NEW combos per IP ...
  IDENTITY_COMBO_WINDOW_MS: 1_800_000, // ... per 30 min window
  IDENTITY_TIMEOUT_MS: 4_000,      // upstream identity call timeout

  // ── rooms ─────────────────────────────────────────────────
  // Shared with the Cricfy issuer (ROOM_KEY_SECRET on that service).
  ROOM_KEY_SECRET: '6239a3b9744a5586c88853c1e5d66a634b60daac2380be38fbc85a892411eece',
};