// Sticker catalogue.
//
// The server only ever knows sticker *ids* — it never ships artwork. When a
// user sends a sticker, the wire carries { kind: 'sticker', body: '<id>' } and
// each client renders its own local asset at public/stickers/<id>.svg.
//
// `types` scopes a sticker to room types (see the room key's `type`). A sticker
// with no `types` is universal and shows in every room. This is what stops a
// wicket sticker from turning up in a "bhabhi ji ki chaat" kitchen room.
//
// To add a sticker: add an entry here AND drop the matching SVG in
// public/stickers/. The verifier rejects any id that is not on this list, so a
// client cannot inject arbitrary ids (e.g. to smuggle a URL / HTML).
const STICKERS = [
  // cricket rooms
  { id: 'six', label: 'SIX!', types: ['cricket'] },
  { id: 'wicket', label: 'OUT!', types: ['cricket'] },
  { id: 'hundred', label: 'CENTURY', types: ['cricket'] },
  // football rooms
  { id: 'goal', label: 'GOAL!', types: ['football'] },
  // shared sports
  { id: 'goat', label: 'GOAT', types: ['cricket', 'football'] },
  // universal
  { id: 'fire', label: 'On fire' },
  { id: 'clap', label: 'Clap' },
  { id: 'lol', label: 'LOL' },
  { id: 'love', label: 'Love' },
  { id: 'wow', label: 'Wow' },
  { id: 'sad', label: 'Sad' },
  { id: 'gg', label: 'GG' },
  { id: 'respect', label: 'Respect' },
];

const BY_ID = new Map(STICKERS.map((s) => [s.id, s]));

const isValidSticker = (id) => BY_ID.has(String(id ?? '').trim());

// Stickers that fit a room type: universal ones + those tagged for it.
// No type (or an unknown one) => the full catalogue.
function stickersFor(type) {
  const t = String(type ?? '').trim().toLowerCase();
  if (!t) return STICKERS;
  return STICKERS.filter((s) => !s.types || s.types.includes(t));
}

module.exports = { STICKERS, isValidSticker, stickersFor };
