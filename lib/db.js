const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'chat.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel_seq
    ON messages (channel_id, seq);

  CREATE TABLE IF NOT EXISTS bans (
    channel_id TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    until      INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS rooms (
    room_id          TEXT PRIMARY KEY,
    name             TEXT    NOT NULL,
    meta             TEXT,
    created_at       INTEGER NOT NULL,
    created_by       TEXT,
    last_activity_at INTEGER NOT NULL,
    open_at          INTEGER,
    close_at         INTEGER
  );
`);

// Migrations: columns added after the first releases.
{
  const cols = db.prepare('PRAGMA table_info(rooms)').all().map((c) => c.name);
  if (!cols.includes('last_activity_at')) {
    db.exec('ALTER TABLE rooms ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE rooms SET last_activity_at = created_at WHERE last_activity_at = 0');
  }
  if (!cols.includes('open_at')) db.exec('ALTER TABLE rooms ADD COLUMN open_at INTEGER');
  if (!cols.includes('close_at')) db.exec('ALTER TABLE rooms ADD COLUMN close_at INTEGER');
}

const stmtInsert = db.prepare(`
  INSERT INTO messages (channel_id, user_id, name, body, created_at)
  VALUES (@channel, @userId, @name, @body, @createdAt)
`);

const stmtReplay = db.prepare(`
  SELECT * FROM (
    SELECT seq, channel_id, user_id, name, body, created_at
    FROM messages
    WHERE channel_id = ? AND seq > ?
    ORDER BY seq DESC
    LIMIT ?
  ) ORDER BY seq ASC
`);

const stmtRecent = db.prepare(`
  SELECT seq, channel_id, user_id, name, body, created_at
  FROM messages
  WHERE channel_id = ?
  ORDER BY seq DESC
  LIMIT ?
`);

const stmtBan = db.prepare(`
  INSERT INTO bans (channel_id, user_id, until) VALUES (?, ?, ?)
  ON CONFLICT (channel_id, user_id) DO UPDATE SET until = excluded.until
`);

const stmtBanCheck = db.prepare(`
  SELECT until FROM bans WHERE channel_id = ? AND user_id = ?
`);

const stmtPrune = db.prepare(`
  DELETE FROM messages WHERE created_at < ?
`);

const stmtRoomGet = db.prepare(`SELECT * FROM rooms WHERE room_id = ?`);

const stmtRoomInsert = db.prepare(`
  INSERT INTO rooms (room_id, name, meta, created_at, created_by, last_activity_at, open_at, close_at)
  VALUES (@roomId, @name, @meta, @createdAt, @createdBy, @createdAt, @openAt, @closeAt)
  ON CONFLICT (room_id) DO NOTHING
`);

const stmtRoomTouch = db.prepare(`UPDATE rooms SET last_activity_at = ? WHERE room_id = ?`);

const stmtRoomList = db.prepare(`
  SELECT * FROM rooms ORDER BY last_activity_at DESC LIMIT ?
`);

const stmtIdleRooms = db.prepare(`SELECT room_id FROM rooms WHERE last_activity_at < ?`);
const stmtExpiredRooms = db.prepare(
  `SELECT room_id FROM rooms WHERE close_at IS NOT NULL AND close_at <= ?`,
);
const stmtRoomDelete = db.prepare(`DELETE FROM rooms WHERE room_id = ?`);
const stmtRoomMessagesDelete = db.prepare(`DELETE FROM messages WHERE channel_id = ?`);

function mapRoom(row) {
  if (!row) return null;
  let meta = null;
  try {
    meta = row.meta ? JSON.parse(row.meta) : null;
  } catch {
    meta = null;
  }
  return {
    room_id: row.room_id,
    name: row.name,
    meta,
    created_at: row.created_at,
    created_by: row.created_by,
    last_activity_at: row.last_activity_at,
    open_at: row.open_at ?? null,
    close_at: row.close_at ?? null,
  };
}

// First caller that presents a valid key creates the room; everyone else
// (same key, or a different key with the same rid) just joins the existing one.
function ensureRoom({ rid, name, meta, createdBy, openAt, closeAt }) {
  const info = stmtRoomInsert.run({
    roomId: rid,
    name,
    meta: meta ? JSON.stringify(meta) : null,
    createdAt: Date.now(),
    createdBy: createdBy || null,
    openAt: openAt ?? null,
    closeAt: closeAt ?? null,
  });
  return { room: mapRoom(stmtRoomGet.get(rid)), created: info.changes > 0 };
}

// Any interaction with a room (key verify, history, send, SSE connect) bumps
// its last_activity_at, which keeps the idle sweeper from closing it.
function touchRoom(rid, ts = Date.now()) {
  return stmtRoomTouch.run(ts, rid).changes;
}

function getRoom(rid) {
  return mapRoom(stmtRoomGet.get(rid));
}

function listRooms(limit = 50) {
  return stmtRoomList.all(Math.min(Number(limit) || 50, 200)).map(mapRoom);
}

function insert({ channel, userId, name, body }) {
  const row = {
    channel,
    userId,
    name,
    body,
    createdAt: Date.now(),
  };
  const info = stmtInsert.run(row);
  return {
    seq: Number(info.lastInsertRowid),
    channel_id: channel,
    user_id: userId,
    name,
    body,
    created_at: row.createdAt,
  };
}

function replay(channel, since, limit = 100) {
  return stmtReplay.all(channel, since, limit);
}

function history(channel, limit = 100) {
  return stmtRecent.all(channel, limit).reverse();
}

function ban(channel, userId, minutes) {
  stmtBan.run(channel, userId, Date.now() + minutes * 60_000);
}

function isBanned(channel, userId) {
  const row = stmtBanCheck.get(channel, userId);
  return Boolean(row && row.until > Date.now());
}

function pruneMessages(maxAgeMs) {
  return stmtPrune.run(Date.now() - maxAgeMs).changes;
}

function prune(days = 7) {
  return pruneMessages(days * 86_400_000);
}

// Close rooms with no activity for idleMs: drop the room row and its messages.
// Returns the list of closed room ids. A still-valid key lazily reopens one.
// Drop a room row and every message it holds.
function deleteRoom(rid) {
  stmtRoomMessagesDelete.run(rid);
  return stmtRoomDelete.run(rid).changes;
}

const closeRoomsTx = db.transaction((ids) => {
  for (const rid of ids) deleteRoom(rid);
});

function pruneIdleRooms(idleMs) {
  const ids = stmtIdleRooms.all(Date.now() - idleMs).map((r) => r.room_id);
  if (ids.length) closeRoomsTx(ids);
  return ids;
}

// Close rooms whose key window (close_at) has elapsed, regardless of activity.
function pruneExpiredRooms(now = Date.now()) {
  const ids = stmtExpiredRooms.all(now).map((r) => r.room_id);
  if (ids.length) closeRoomsTx(ids);
  return ids;
}

module.exports = {
  db,
  insert,
  replay,
  history,
  ban,
  isBanned,
  prune,
  pruneMessages,
  pruneIdleRooms,
  pruneExpiredRooms,
  deleteRoom,
  ensureRoom,
  touchRoom,
  getRoom,
  listRooms,
};
