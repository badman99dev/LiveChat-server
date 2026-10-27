const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./lib/db');
const auth = require('./lib/auth');
const { Hub, openStream } = require('./lib/sse');
const { ScoreFeed } = require('./lib/score');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || (process.env.RENDER || process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CHAT_MAX_LEN = Number(process.env.CHAT_MAX_LEN || 500);
const RATE_MS = Number(process.env.RATE_MS || 1000);
const REPLAY_LIMIT = Number(process.env.REPLAY_LIMIT || 100);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BODY = 8 * 1024;

const hub = new Hub();
const score = new ScoreFeed();
if (process.env.MOCK_SCORE !== 'false') score.startMock(Number(process.env.MOCK_SCORE_MS || 7000));

const msgLimiter = new Map();
const loginLimiter = new Map();

const CHANNEL_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const NAME_RE = /^[\p{L}\p{N} _.\-]{2,24}$/u;

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

  if (route === 'GET /api/chat/history') {
    const channel = url.searchParams.get('channel') || 'main';
    if (!CHANNEL_RE.test(channel)) return json(res, 400, { error: 'bad channel' });
    const since = Number(url.searchParams.get('since') || 0);
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
    const rows = since > 0 ? db.replay(channel, since, limit) : db.history(channel, limit);
    return json(res, 200, { messages: rows.map(toWire) });
  }

  if (route === 'POST /api/chat/send') {
    const user = auth.sessionFrom(req);
    if (!user) return json(res, 401, { error: 'login required' });

    const body = await readBody(req);
    const channel = String(body.channel || 'main');
    if (!CHANNEL_RE.test(channel)) return json(res, 400, { error: 'bad channel' });

    if (rateLimited(msgLimiter, `${channel}:${user.uid}`, RATE_MS)) {
      return json(res, 429, { error: 'slow down' });
    }

    if (db.isBanned(channel, user.uid)) {
      return json(res, 403, { error: 'you are muted' });
    }

    const text = normalizeText(body.body);
    if (!text) return json(res, 400, { error: 'empty message' });
    if (text.length > CHAT_MAX_LEN) {
      return json(res, 400, { error: `max ${CHAT_MAX_LEN} characters` });
    }

    const row = db.insert({ channel, userId: user.uid, name: user.name, body: text });
    const wire = toWire(row);
    hub.emit(`chat:${channel}`, 'chat', wire, wire.seq);
    return json(res, 200, { ok: true, message: wire });
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
    const channel = url.searchParams.get('channel') || 'main';
    return json(res, 200, { channel, online: hub.count(`chat:${channel}`) });
  }

  return json(res, 404, { error: 'not found' });
}

function handleChatStream(req, res, url) {
  const channel = url.searchParams.get('channel') || 'main';
  if (!CHANNEL_RE.test(channel)) return json(res, 400, { error: 'bad channel' });

  const key = `chat:${channel}`;
  const sinceHeader = Number(req.headers['last-event-id'] || 0);
  const sinceParam = Number(url.searchParams.get('since') || 0);
  const since = Number.isFinite(sinceHeader) && sinceHeader > 0 ? sinceHeader : sinceParam;

  openStream(req, res);

  for (const row of db.replay(channel, since, REPLAY_LIMIT)) {
    const wire = toWire(row);
    res.write(`id: ${wire.seq}\nevent: chat\ndata: ${JSON.stringify(wire)}\n\n`);
  }

  const online = hub.add(key, res);
  hub.emit(key, 'presence', { online, channel });
  const user = auth.sessionFrom(req);
  res.write(`event: hello\ndata: ${JSON.stringify({ channel, online, me: user ? user.name : null })}\n\n`);

  const cleanup = () => {
    const left = hub.remove(key, res);
    hub.emit(key, 'presence', { online: left, channel });
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
    channel: row.channel_id,
    userId: row.user_id,
    name: row.name,
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

server.listen(PORT, HOST, () => {
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`live-chat-sse listening on http://${HOST}:${PORT}  |  rss ${mem}MB  |  db data/chat.db`);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, draining connections...`);
  hub.closeAll();
  db.prune(7);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
