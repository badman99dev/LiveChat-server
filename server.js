const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { Hub, openStream } = require('./lib/sse');
const { ScoreFeed } = require('./lib/score');
const roomkey = require('./lib/roomkey');
const stickers = require('./lib/stickers');
const reactions = require('./lib/reactions');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHAT_MAX_LEN = Number(process.env.CHAT_MAX_LEN || 500);
const RATE_MS = Number(process.env.RATE_MS || 1000);
const REPLAY_LIMIT = Number(process.env.REPLAY_LIMIT || 100);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ROOM_KEY_SECRET = process.env.ROOM_KEY_SECRET || '';
const DEFAULT_ROOM = process.env.DEFAULT_ROOM || '';
const DEFAULT_ROOM_NAME = process.env.DEFAULT_ROOM_NAME || 'Public chat';
const RETENTION_MINUTES = Number(process.env.RETENTION_MINUTES ?? 10);
const ROOM_IDLE_MINUTES = Number(process.env.ROOM_IDLE_MINUTES ?? 30);
const PRUNE_INTERVAL_MS = Number(process.env.PRUNE_INTERVAL_MS ?? 30_000);
// Reactions are not rate-limited per user; this caps the *whole server* per
// second so a single runaway client cannot melt the process. 0 = unlimited.
const REACT_MAX_PER_SEC = Number(process.env.REACT_MAX_PER_SEC ?? 500);
const MAX_BODY = 8 * 1024;

const hub = new Hub();
const score = new ScoreFeed();
if (process.env.MOCK_SCORE !== 'false') score.startMock(Number(process.env.MOCK_SCORE_MS || 7000));

const msgLimiter = new Map();
const loginLimiter = new Map();

// Server-wide reaction firehose cap (see REACT_MAX_PER_SEC).
let reactWindow = { start: 0, count: 0 };
let reactSeq = 0;
function reactAllowed() {
  if (!REACT_MAX_PER_SEC) return true;
  const now = Date.now();
  if (now - reactWindow.start >= 1000) {
    reactWindow.start = now;
    reactWindow.count = 0;
  }
  reactWindow.count += 1;
  return reactWindow.count <= REACT_MAX_PER_SEC;
}

const RID_RE = roomkey.RID_RE;
const NAME_RE = /^[\p{L}\p{N} _.\-]{2,24}$/u;

// ---- room key resolution ---------------------------------------------------
// Accepts a Room Access Key from ?key= or the JSON body, verifies it, and
// lazily creates the room on first sight. Never trusts client-supplied rid/name.
function resolveRoom(url, body) {
  const key = (url && url.searchParams.get('key')) || (body && body.key) || '';

  if (key && key.startsWith('rk1.')) {
    let payload;
    try {
      payload = roomkey.verifyRoomKey(key, { secret: ROOM_KEY_SECRET });
    } catch (err) {
      return { error: err.code || 'invalid_key', message: err.message || 'invalid room key' };
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // Key's window hasn't opened yet.
    if (payload.openAt && nowSec < payload.openAt) {
      return {
        error: 'not_yet',
        message: `room opens at ${new Date(payload.openAt * 1000).toISOString()}`,
        openAt: payload.openAt,
      };
    }

    // Once the window has elapsed the key can only ENTER an open room — never
    // create or reopen one.
    const mayOpen = !payload.closeAt || nowSec < payload.closeAt;

    let room = db.getRoom(payload.rid);
    if (room && payload.closeAt && nowSec >= payload.closeAt) {
      // Window elapsed but the sweeper hasn't run yet: close it right here.
      db.deleteRoom(payload.rid);
      hub.closeRoom(`chat:${payload.rid}`, 'room', {
        closed: true,
        reason: 'window',
        id: payload.rid,
      });
      console.log(`room closed (window ended): ${payload.rid}`);
      room = null;
    }

    let created = false;
    if (!room) {
      if (!mayOpen) {
        return {
          error: 'room_not_exist',
          message: 'this room is closed and can no longer be reopened',
        };
      }
      const res = db.ensureRoom({
        rid: payload.rid,
        name: payload.name,
        type: payload.type,
        meta: payload.meta,
        openAt: payload.openAt,
        closeAt: payload.closeAt,
      });
      room = res.room;
      created = res.created;
      if (created) console.log(`room created: ${room.room_id} — ${room.name}`);
    }

    db.touchRoom(room.room_id);
    return { room, created, keyed: true };
  }

  const explicitRid = (url && (url.searchParams.get('rid') || url.searchParams.get('room'))) || (body && (body.rid || body.room)) || '';
  const rawRid = (key && !key.startsWith('rk1.')) ? key : explicitRid;
  if (rawRid) {
    const cleanRid = String(rawRid).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    if (cleanRid) {
      const roomName = (url && url.searchParams.get('name')) || (body && body.name) || cleanRid;
      const roomType = (url && url.searchParams.get('type')) || (body && body.type) || (cleanRid.startsWith('sports') ? 'sports' : 'general');
      const res = db.ensureRoom({
        rid: cleanRid,
        name: roomName,
        type: roomType,
      });
      db.touchRoom(res.room.room_id);
      return { room: res.room, created: res.created, keyed: false };
    }
  }

  if (DEFAULT_ROOM && RID_RE.test(DEFAULT_ROOM)) {
    const { room } = db.ensureRoom({ rid: DEFAULT_ROOM, name: DEFAULT_ROOM_NAME });
    db.touchRoom(room.room_id);
    return { room, created: false, fallback: true };
  }

  return { error: 'no_key', message: 'a room key is required' };
}

const DENY_STATUS = { no_key: 400, room_not_exist: 404 };

function roomDenied(res, resolved) {
  const body = { error: resolved.error, message: resolved.message };
  if (resolved.openAt) body.openAt = resolved.openAt;
  return json(res, DENY_STATUS[resolved.error] || 403, body);
}

// SSE clients get a terminal `denied` event instead of a JSON error, so the
// browser stops retrying and the server holds no connection / memory for it.
function streamDenied(req, res, resolved) {
  openStream(req, res);
  res.write(
    `event: denied\ndata: ${JSON.stringify({
      error: resolved.error,
      message: resolved.message,
      openAt: resolved.openAt ?? null,
    })}\n\n`,
  );
  res.end();
}

// ---- retention & room expiry ----------------------------------------------
// Messages older than RETENTION_MINUTES are dropped. A room that sees no
// activity (key verify / history / send / SSE connect) for ROOM_IDLE_MINUTES is
// closed: its row + messages are deleted and every connected stream gets a
// final `room` event. The key stays valid — reusing it lazily reopens the room.
function sweep() {
  const messages = db.pruneMessages(RETENTION_MINUTES * 60_000);

  // Rooms whose key window ended are closed the moment it elapses.
  for (const rid of db.pruneExpiredRooms()) {
    hub.closeRoom(`chat:${rid}`, 'room', { closed: true, reason: 'window', id: rid });
    console.log(`room closed (window ended): ${rid}`);
  }

  // Rooms idle past the idle limit.
  if (ROOM_IDLE_MINUTES > 0) {
    for (const rid of db.pruneIdleRooms(ROOM_IDLE_MINUTES * 60_000)) {
      hub.closeRoom(`chat:${rid}`, 'room', { closed: true, reason: 'idle', id: rid });
      console.log(`room closed (idle > ${ROOM_IDLE_MINUTES}m): ${rid}`);
    }
  }

  if (messages) console.log(`pruned ${messages} message(s) older than ${RETENTION_MINUTES}m`);
}

function rateLimited(map, key, windowMs) {
  const now = Date.now();
  const last = map.get(key) || 0;
  if (now - last < windowMs) return true;
  map.set(key, now);
  if (map.size > 5000) {
    for (const [k, v] of map) if (now - v > 60_000) map.delete(k);
  }
  return false;
}

function json(res, code, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeText(input) {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cookieOptions(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const secure = process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === 'true'
    : req.socket.encrypted === true || proto === 'https';
  return { secure };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
        "style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/me') {
    const user = auth.sessionFrom(req);
    return json(res, 200, { user: user ? { id: user.uid, name: user.name } : null });
  }

  if (route === 'POST /api/login') {
    if (rateLimited(loginLimiter, req.socket.remoteAddress, 500)) {
      return json(res, 429, { error: 'too many attempts' });
    }
    const body = await readBody(req);
    const name = normalizeText(body.name);
    if (!NAME_RE.test(name)) {
      return json(res, 400, { error: 'name must be 2-24 chars (letters, numbers, _ . -)' });
    }
    const user = auth.newUser(name);
    return json(
      res,
      200,
      { user: { id: user.uid, name: user.name } },
      { 'Set-Cookie': auth.issue(user, cookieOptions(req)) },
    );
  }

  if (route === 'POST /api/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clear(cookieOptions(req)) });
  }

  if (route === 'POST /api/room/verify') {
    const body = await readBody(req);
    const resolved = resolveRoom(url, body);
    if (resolved.error) return roomDenied(res, resolved);
    const { room, created } = resolved;
    return json(res, 200, {
      ok: true,
      created,
      room: {
        id: room.room_id,
        name: room.name,
        type: room.type,
        meta: room.meta,
        createdAt: room.created_at,
        openAt: room.open_at,
        closeAt: room.close_at,
      },
    });
  }

  if (route === 'GET /api/stickers') {
    // Catalogue only — the SVG artwork is served client-side from /stickers/.
    // ?type=<room type> narrows it to stickers that fit that room.
    const type = url.searchParams.get('type');
    return json(res, 200, { basePath: '/stickers', type: type || null, stickers: stickers.stickersFor(type) });
  }

  if (route === 'GET /api/reactions') {
    const type = url.searchParams.get('type');
    return json(res, 200, { type: type || null, reactions: reactions.reactionsFor(type) });
  }

  if (route === 'GET /api/rooms') {
    return json(res, 200, {
      rooms: db.listRooms(Number(url.searchParams.get('limit') || 50)).map((r) => ({
        id: r.room_id,
        name: r.name,
        type: r.type,
        online: hub.count(`chat:${r.room_id}`),
        createdAt: r.created_at,
        lastActivityAt: r.last_activity_at,
        openAt: r.open_at,
        closeAt: r.close_at,
      })),
    });
  }

  if (route === 'GET /api/chat/history') {
    const resolved = resolveRoom(url, null);
    if (resolved.error) return roomDenied(res, resolved);
    const rid = resolved.room.room_id;
    const since = Number(url.searchParams.get('since') || 0);
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const rows = since > 0 ? db.replay(rid, since, limit) : db.history(rid, limit);
    return json(res, 200, {
      room: { id: rid, name: resolved.room.name, type: resolved.room.type },
      messages: rows.map(toWire),
    });
  }

  if (route === 'POST /api/chat/send') {
    const user = auth.sessionFrom(req);
    if (!user) return json(res, 401, { error: 'login required' });

    const body = await readBody(req);
    const resolved = resolveRoom(url, body);
    if (resolved.error) return roomDenied(res, resolved);
    const rid = resolved.room.room_id;

    if (rateLimited(msgLimiter, `${rid}:${user.uid}`, RATE_MS)) {
      return json(res, 429, { error: 'slow down' });
    }

    if (db.isBanned(rid, user.uid)) {
      return json(res, 403, { error: 'you are muted' });
    }

    // A sticker message carries only an id; the artwork lives client-side. We
    // validate the id against the catalogue so nothing arbitrary is broadcast.
    const isSticker = body.kind === 'sticker' || body.sticker !== undefined;
    let kind = 'text';
    let text;

    if (isSticker) {
      const id = normalizeText(body.sticker ?? body.body).toLowerCase();
      if (!stickers.isValidSticker(id)) return json(res, 400, { error: 'unknown sticker' });
      kind = 'sticker';
      text = id;
    } else {
      text = normalizeText(body.body);
      if (!text) return json(res, 400, { error: 'empty message' });
      if (text.length > CHAT_MAX_LEN) {
        return json(res, 400, { error: `max ${CHAT_MAX_LEN} characters` });
      }
    }

    const row = db.insert({ channel: rid, userId: user.uid, name: user.name, body: text, kind });
    const wire = toWire(row);
    hub.emit(`chat:${rid}`, 'chat', wire, wire.seq);
    return json(res, 200, { ok: true, message: wire });
  }

  if (route === 'POST /api/chat/react') {
    const user = auth.sessionFrom(req);
    if (!user) return json(res, 401, { error: 'login required' });

    const body = await readBody(req);
    const resolved = resolveRoom(url, body);
    if (resolved.error) return roomDenied(res, resolved);

    const r = reactions.getReaction(body.reaction ?? body.body);
    if (!r) return json(res, 400, { error: 'unknown reaction' });

    // Deliberately NOT rate-limited per user. Only a server-wide cap guards us;
    // over the cap we quietly drop (200) so spamming stays seamless.
    if (!reactAllowed()) return json(res, 200, { ok: true, dropped: true });

    hub.emit(`chat:${resolved.room.room_id}`, 'reaction', {
      rid: `r${++reactSeq}`,
      reaction: r.id,
      emoji: r.emoji,
      userId: user.uid,
      name: user.name,
      ts: Date.now(),
    });
    return json(res, 200, { ok: true, reaction: r.id });
  }

  if (route === 'POST /api/score') {
    if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
      return json(res, 403, { error: 'forbidden' });
    }
    const body = await readBody(req);
    const state = score.update(body);
    return json(res, 200, { ok: true, score: state });
  }

  if (route === 'GET /api/chat/stats') {
    const resolved = resolveRoom(url, null);
    if (resolved.error) return roomDenied(res, resolved);
    const rid = resolved.room.room_id;
    return json(res, 200, {
      room: { id: rid, name: resolved.room.name, type: resolved.room.type },
      online: hub.count(`chat:${rid}`),
    });
  }

  return json(res, 404, { error: 'not found' });
}

function handleChatStream(req, res, url) {
  const resolved = resolveRoom(url, null);
  if (resolved.error) return streamDenied(req, res, resolved);

  const room = resolved.room;
  const rid = room.room_id;
  const key = `chat:${rid}`;
  const sinceHeader = Number(req.headers['last-event-id'] || 0);
  const sinceParam = Number(url.searchParams.get('since') || 0);
  const since = Number.isFinite(sinceHeader) && sinceHeader > 0 ? sinceHeader : sinceParam;

  openStream(req, res);

  for (const row of db.replay(rid, since, REPLAY_LIMIT)) {
    const wire = toWire(row);
    res.write(`id: ${wire.seq}\nevent: chat\ndata: ${JSON.stringify(wire)}\n\n`);
  }

  const online = hub.add(key, res);
  hub.emit(key, 'presence', { online, room: rid });

  const user = auth.sessionFrom(req);
  res.write(
    `event: hello\ndata: ${JSON.stringify({
      room: { id: rid, name: room.name, type: room.type },
      online,
      me: user ? user.name : null,
    })}\n\n`,
  );

  const cleanup = () => {
    const left = hub.remove(key, res);
    hub.emit(key, 'presence', { online: left, room: rid });
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
  res.on('close', cleanup);
}

function handleScoreStream(req, res) {
  openStream(req, res);
  res.write(`event: score\ndata: ${JSON.stringify(score.get())}\n\n`);
  const onUpdate = (state) => {
    try {
      res.write(`event: score\ndata: ${JSON.stringify(state)}\n\n`);
    } catch {
      /* ignore */
    }
  };
  score.on('update', onUpdate);
  const cleanup = () => score.off('update', onUpdate);
  req.on('close', cleanup);
  res.on('close', cleanup);
}

function toWire(row) {
  return {
    seq: row.seq,
    room: row.channel_id,
    userId: row.user_id,
    name: row.name,
    kind: row.kind || 'text',
    body: row.body,
    ts: row.created_at,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/events/chat') return handleChatStream(req, res, url);
    if (url.pathname === '/events/score') return handleScoreStream(req, res);
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, uptime: process.uptime() });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res);
  } catch (err) {
    if (!res.headersSent) json(res, 400, { error: err.message || 'bad request' });
    else res.end();
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

const sweepTimer = setInterval(sweep, PRUNE_INTERVAL_MS);
sweepTimer.unref();

server.listen(PORT, HOST, () => {
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`live-chat-sse listening on http://${HOST}:${PORT}  |  rss ${mem}MB  |  db data/chat.db`);
  if (ROOM_KEY_SECRET) {
    console.log('room keys: enabled (AES-256-GCM, rk1)');
  } else {
    console.log('room keys: DISABLED — set ROOM_KEY_SECRET to accept ?key= room links');
  }
  if (DEFAULT_ROOM) console.log(`default room fallback: ${DEFAULT_ROOM}`);
  console.log(
    `retention: messages ${RETENTION_MINUTES}m  |  room idle close ${ROOM_IDLE_MINUTES}m  |  sweep every ${PRUNE_INTERVAL_MS / 1000}s`,
  );
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, draining connections...`);
  clearInterval(sweepTimer);
  hub.closeAll();
  db.pruneMessages(RETENTION_MINUTES * 60_000);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
