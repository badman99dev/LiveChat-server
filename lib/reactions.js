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
  { id: 'wow', emoji: '😮', label: 'Wow' },
  { id: '100', emoji: '💯', label: '100' },
  { id: 'eyes', emoji: '👀', label: 'Eyes' },
  { id: 'pray', emoji: '🙏', label: 'Pray' },
];

const BY_ID = new Map(REACTIONS.map((r) => [r.id, r]));

const getReaction = (id) => BY_ID.get(String(id ?? '').trim()) || null;
const isValidReaction = (id) => BY_ID.has(String(id ?? '').trim());

// Same scoping rule as stickers: no `types` = universal.
function reactionsFor(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!t) return REACTIONS;
  return REACTIONS.filter((r) => !r.types || r.types.includes(t));
}

module.exports = { REACTIONS, getReaction, isValidReaction, reactionsFor };
