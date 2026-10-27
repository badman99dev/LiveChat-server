#!/usr/bin/env node
// Mint a Room Access Key (RAK) for the live chat server.
//
// This is the *issuer* side of the protocol. Your match/admin backend will do
// the same thing in-process by `require`-ing lib/roomkey.js — this CLI is just
// a convenient wrapper for testing and ops.
//
// Usage:
//   ROOM_KEY_SECRET=<secret> node scripts/make-room-key.js --id match-1024 --name "IND vs AUS"
//
// Options:
//   --id,   --room   room id            (required, A-Z a-z 0-9 _ - , max 64)
//   --name           room display name  (default: same as id)
//   --open, --start  room may open from this time (default: now)
//   --close, --end   room force-closes at this time; afterwards the key can
//                    only ENTER an existing room, never reopen it
//   --ttl            seconds until the KEY itself expires (omit for none)
//   --meta           JSON object string, e.g. '{"kind":"match"}'
//   --secret         override ROOM_KEY_SECRET
//   --url            base URL, prints a ready-to-share join link
//   --json           print a JSON object instead of the bare key
//
// Time values accept: an epoch (seconds), an ISO-8601 string, "now", or a
// relative offset like "+2h", "-30m", "+7d" (s = seconds, m = minutes,
// h = hours, d = days).

const { issueRoomKey, RoomKeyError } = require('../lib/roomkey');

// Resolve a CLI time argument to epoch seconds (or null).
function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  if (s.toLowerCase() === 'now') return Math.floor(Date.now() / 1000);

  const rel = s.match(/^([+-]?)(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[rel[3].toLowerCase()];
    const sign = rel[1] === '-' ? -1 : 1;
    return Math.floor(Date.now() / 1000) + sign * Math.round(Number(rel[2]) * unit);
  }
  return s; // epoch or ISO — lib/roomkey normalizes it
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[a.slice(2)] = next;
        i += 1;
      } else {
        out[a.slice(2)] = true;
      }
    }
  }
  return out;
}

function usage(code) {
  process.stderr.write(
    [
      'make-room-key — mint a room access key',
      '',
      '  node scripts/make-room-key.js --id <room-id> [--name "<Room name>"]',
      '        [--open +0m | --start <time>] [--close +6h | --end <time>]',
      '        [--ttl <seconds>] [--meta \'{"k":"v"}\'] [--url https://chat.example.com] [--json]',
      '',
      '  --open/-close: "now", "+2h", "-30m", "+7d", epoch seconds, or ISO-8601',
      '  secret comes from ROOM_KEY_SECRET (or --secret).',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);

const rid = args.id || args.room || args.slug;
if (!rid) usage(1);

const secret = args.secret || process.env.ROOM_KEY_SECRET || '';
if (!secret) {
  process.stderr.write('error: set ROOM_KEY_SECRET (or pass --secret)\n');
  process.exit(1);
}

let meta = null;
if (typeof args.meta === 'string') {
  try {
    meta = JSON.parse(args.meta);
  } catch {
    process.stderr.write('error: --meta must be valid JSON\n');
    process.exit(1);
  }
}

const openAt = parseTime(args.open ?? args.start);
const closeAt = parseTime(args.close ?? args.end);

let key;
try {
  key = issueRoomKey(
    { rid, name: args.name || rid, meta, openAt, closeAt },
    { secret, ttlSeconds: args.ttl ? Number(args.ttl) : undefined },
  );
} catch (err) {
  if (err instanceof RoomKeyError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

if (args.json) {
  const base = typeof args.url === 'string' ? args.url.replace(/\/+$/, '') : null;
  process.stdout.write(
    JSON.stringify(
      {
        key,
        room: {
          id: rid,
          name: args.name || rid,
          openAt: openAt ?? null,
          closeAt: closeAt ?? null,
        },
        ttl: args.ttl ? Number(args.ttl) : null,
        joinUrl: base ? `${base}/?key=${encodeURIComponent(key)}` : null,
      },
      null,
      2,
    ) + '\n',
  );
} else if (typeof args.url === 'string') {
  process.stdout.write(`${args.url.replace(/\/+$/, '')}/?key=${encodeURIComponent(key)}\n`);
} else {
  process.stdout.write(`${key}\n`);
}
