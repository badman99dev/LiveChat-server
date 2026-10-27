// Live "reaction bar" — the YouTube-style heart / emoji spam.
//
// Reactions are EPHEMERAL: they are never written to the database, never touch
// retention, and are just fanned out over the room's SSE stream. There is no
// per-user rate limit (spamming is the point); a generous server-wide safety
// cap (REACT_MAX_PER_SEC) absorbs a runaway client so one socket can't melt the
// process.
const REACTIONS = [
  { id: 'heart', emoji: '❤️', label: 'Love' },
  { id: 'like', emoji: '👍', label: 'Nice' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'lol', emoji: '😂', label: 'Ha ha' },
  { id: 'party', emoji: '🎉', label: 'Party' },
  { id: 'clap', emoji: '👏', label: 'Clap' },
];

const BY_ID = new Map(REACTIONS.map((r) => [r.id, r]));

const getReaction = (id) => BY_ID.get(String(id ?? '').trim()) || null;
const isValidReaction = (id) => BY_ID.has(String(id ?? '').trim());

module.exports = { REACTIONS, getReaction, isValidReaction };
