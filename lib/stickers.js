// Sticker catalogue.
//
// The server only ever knows sticker *ids* — it never ships artwork. When a
// user sends a sticker, the wire carries { kind: 'sticker', body: '<id>' } and
// each client renders its own local asset at public/stickers/<id>.svg.
//
// To add a sticker: add an entry here AND drop the matching SVG in
// public/stickers/. The verifier rejects any id that is not on this list, so a
// client cannot inject arbitrary ids (e.g. to smuggle a URL / HTML).
const STICKERS = [
  { id: 'six', label: 'SIX!' },
  { id: 'wicket', label: 'OUT!' },
  { id: 'hundred', label: 'CENTURY' },
  { id: 'fire', label: 'On fire' },
  { id: 'clap', label: 'Clap' },
  { id: 'lol', label: 'LOL' },
  { id: 'love', label: 'Love' },
  { id: 'wow', label: 'Wow' },
  { id: 'sad', label: 'Sad' },
  { id: 'goat', label: 'GOAT' },
  { id: 'gg', label: 'GG' },
  { id: 'respect', label: 'Respect' },
];

const IDS = new Set(STICKERS.map((s) => s.id));

const isValidSticker = (id) => IDS.has(String(id ?? '').trim());

module.exports = { STICKERS, isValidSticker };
