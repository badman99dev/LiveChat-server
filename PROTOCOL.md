# Room Access Key (RAK) — Protocol v1

Ek encrypted, reusable token jo ek client ko ek **chat room** me entry deta hai.
Issuer (tumhara match/admin backend) key banata hai; live chat server usko
**verify** karta hai. Dono ek hi shared secret (`ROOM_KEY_SECRET`) use karte hain,
isliye **koi DB lookup ya network call-back nahi** chahiye.

```
┌────────────────┐   rk1.<...>   ┌──────────────┐   ?key=rk1.<...>   ┌──────────┐
│  Issues keys   │ ────────────► │   Browser    │ ─────────────────► │  Chat    │
│ (match server) │               │  (join link) │ ◄───── 200 ─────── │  server  │
└────────────────┘               └──────────────┘   verifies + join  └──────────┘
        ▲                                                                    │
        └──────────────── shared ROOM_KEY_SECRET ───────────────────────────┘
```

---

## 1. Wire format

```
rk1.<base64url( iv(12 bytes) || tag(16 bytes) || ciphertext )>
```

| Part | Size | Matlab |
|---|---|---|
| `rk1` | 3 | protocol prefix + version |
| `iv` | 12 B | AES-GCM nonce, **random per key** |
| `tag` | 16 B | GCM auth tag (tamper detection) |
| `ciphertext` | variable | AES-256-GCM(JSON payload) |

- Base64url = `A–Z a–z 0–9 - _`, **no padding**.
- Poori key URL-safe hai — seedha `?key=` me daal sakte ho.
- Typcial length: `rk1.` + ~120–180 chars.

**Cipher:** `aes-256-gcm`
**AAD (additional authenticated data):** `livechat:roomkey:v1` (UTF-8)
**Key derivation** from `ROOM_KEY_SECRET`: 64-char hex → raw 32 B; base64 32 B → raw;
warna `scryptSync(secret, "livechat:roomkey:v1", 32)`.

> AAD bind karne se ye token kisi aur purpose ke liye replay nahi ho sakta.
> GCM tag hi authenticity deta hai — alag signature ki zaroorat nahi.

---

## 2. Payload (plaintext JSON)

```json
{
  "v": 1,
  "rid": "match-1024",
  "name": "IND vs AUS — 2nd ODI",
  "type": "cricket",
  "iat": 1761540000,
  "openAt": 1761540000,
  "closeAt": 1761547200,
  "exp": 1761550800,
  "meta": { "kind": "match", "sport": "cricket" }
}
```

| Field | Type | Req | Rules |
|---|---|---|---|
| `v` | int | ✅ | `1` |
| `rid` | string | ✅ | `^[a-zA-Z0-9_-]{1,64}$` — **room id** |
| `name` | string | ✅ | 1–64 chars — room display name |
| `type` | string | ❌ | room type (cricket/football/food…), `^[a-z0-9_-]{1,32}$`; stickers/reactions isi se filter |
| `iat` | int | ✅ | issued-at, unix **seconds** |
| `openAt` | int | ❌ | isse pehle room khulega hi nahi (`now < openAt` → `not_yet`) |
| `closeAt` | int | ❌ | **issuer ka room order**: is waqt room **force-close**; uske baad key sirf ENTER, reopen nahi |
| `exp` | int | ❌ | **key ka apna order**: key kab tak valid (agar `now > exp` → `expired`, poori key reject) |
| `meta` | object | ❌ | client ko wapas milta hai (icon, kind, etc.) |

### Room window (`openAt` / `closeAt`) — dono optional, ek akela bhi chalega

| Value | Matlab |
|---|---|
| dono nahi | Room abhi bhi khul sakta hai, kabhi force-close nahi (purana behaviour) |
| sirf `openAt` | Room `openAt` se pehle nahi khulega; uske baad normally chalta rahega |
| sirf `closeAt` | Room abhi se khul sakta hai, `closeAt` pe band |
| dono | Room sirf `[openAt, closeAt)` ke andar **open/re-open** ho sakta hai, `closeAt` pe band |

**Semantics:**
- `now < openAt` → **`not_yet`**, room touch bhi nahi hota.
- `openAt <= now < closeAt` (ya window na ho) → room **open / re-open** ho sakta hai.
- `now >= closeAt` → key ke paas **sirf enter** permission:
  - Room abhi band ho jaata hai (row + messages delete, SSE clients ko `event: room` `{closed:true}`).
  - Dobara kholne ki koshish → **`room_not_exist`** (404). Room `entries` ke liye bhi nahi milega.
- `exp` alag cheez hai — wo **poori key** ko maar deta hai (`expired`), jabki `closeAt` sirf room band karta hai.

> **`exp` aur `closeAt` do alag orders hain:**
> - `exp` = **key ka order** — key ki apni validity. Uske baad key poori tarah dead (`expired`), kisi bhi room ke liye.
> - `closeAt` = **issuer server ka order** — room ko band karne ka hukm. Uske baad key zinda rehti hai (verify pass), bas uske paas **room kholne ka haq nahi** — sirf jo room already khula ho usme enter.
>
> Isliye "window khatm = key khatm" nahi, "window khatm = **room** khatm" hai. Agar issuer ko key bhi wahin maarni ho to `exp = closeAt` set kar do.

### Room type (`type`) — stickers/reactions ka context

`type` batata hai room kis baare me hai. Chat server isse sirf **sticker/reaction
catalogue filter** karne ke liye use karta hai (`GET /api/stickers?type=...`):

- Universal stickers (jinpe `types` nahi) har room me dikhte hain.
- Tagged stickers sirf apne type ke room me (jaise `wicket` sirf `cricket` me).
- `type` na ho ya unknown ho to poora catalogue.

Isse "bhabhi ji ki chaat" room me galti se wicket sticker nahi aata. 😄

> ⚠️ Room identity `rid` hai. Ek hi `rid` ke do keys ho (ek `closeAt` ke saath, ek bina) to jo bhi request pehle aayegi apne hisaab se room ko close/open karegi — strictest window jeetegi.

---

## 3. Verification rules (chat server)

Order exactly ye hai:

1. `rk1.` prefix check → warna `bad_format`
2. base64url decode, `len >= 29` (12+16+1) → warna `bad_format`
3. split `iv | tag | ct`
4. `AES-256-GCM` decrypt with AAD → **fail = `bad_signature`** (tampered / wrong secret)
5. JSON parse → `bad_payload`
6. `v === 1` → `bad_version`
7. `rid` regex → `bad_room`
8. `name` 1–64 → `bad_name`
9. `type` (agar ho) regex → `bad_type`
10. `openAt` / `closeAt` parse (bad time / `closeAt <= openAt`) → `bad_time` / `bad_window`
11. `exp` present && expired → `expired`

`bad_signature` pe **timing-safe** hona GCM me built-in hai (tag check constant-time).
Steps 9–10 se aage badhne wale checks **room policy** hain (verify ke baad, resolveRoom me):
`not_yet`, `room_not_exist`.

### Error codes

| Code | HTTP | Kab |
|---|---|---|
| `no_key` | 400 | koi key bheji nahi gayi |
| `bad_format` | 403 | prefix / encoding galat |
| `bad_signature` | 403 | decrypt fail — fake ya corrupted key |
| `bad_payload` | 403 | JSON nahi |
| `bad_version` | 403 | `v != 1` |
| `bad_room` | 403 | rid regex fail |
| `bad_name` | 403 | name missing/too long |
| `bad_type` | 403 | `type` invalid (1–32 chars `a-z 0-9 _ -`) |
| `bad_time` | 403 | `openAt`/`closeAt` valid time nahi |
| `bad_window` | 403 | `closeAt <= openAt` |
| `expired` | 403 | `exp` nikal gaya (poori key dead) |
| `not_yet` | 403 | `now < openAt` (room abhi open nahi) |
| `room_not_exist` | 404 | room band hai aur reopen nahi ho sakta |

### SSE pe deny kaise dikhta hai

`GET /events/chat` pe deny hone par server **200 + SSE** deta hai (JSON error nahi),
jisme ek terminal event hota hai, phir stream band:

```
retry: 3000

event: denied
data: {"error":"room_not_exist","message":"this room is closed and can no longer be reopened","openAt":null}
```

Client ise dekh ke EventSource **khud close** karta hai → na client retry loop,
na server pe koi idle connection / RAM. (Plain JSON 4xx hota to browser EventSource
hamesha retry karta rehta.)

---

## 4. Room lifecycle (lazy create)

```
client key bhejta hai
        │
        ▼
  key verify hoti hai (signature, exp)
        │
        ▼
  now < openAt?  ── HAAN ─►  not_yet (403)
        │ NAHI
        ▼
  rooms table me rid hai?
   ├── NAHI  →  mayOpen?  ── NAHI ─►  room_not_exist (404)
   │            └─ HAAN ─►  ROOM BANTA HAI  (name/meta/window key se, created=1)
   └── HAAN  →  closeAt nikal gaya?  ── HAAN ─►  room CLOSE ─► room_not_exist
                └─ NAHI ─►  SIRF JOIN  (existing room, created=0)
```

- **Same key, multiple clients** → sab ek hi room me. Koi limit nahi.
- **Same rid, different key** → bhi same room (rid hi identity hai).
- Room ka `name`/`meta` **pehli baar** banate waqt set hota hai; baad me overwrite
  nahi hota (predictable). Name badalna ho to room id naya do ya DB me update karo.

### Retention & idle close

Sweeper (default har 30s) do cheezein karta hai:

| Cheez | Rule | Env / source |
|---|---|---|
| Messages | `created_at` purana → delete | `RETENTION_MINUTES` (default **10**) |
| Rooms | Activity nahi → room **CLOSE** (row + uske messages delete) | `ROOM_IDLE_MINUTES` (default **30**) |
| Rooms | `closeAt` nikal gaya → usi instant room **CLOSE** | key ka `closeAt` |

- **Activity** = key verify, `/api/chat/history`, message send, ya SSE connect
  (jo bhi room ko touch kare).
- Room close hone pe connected clients ko `event: room`
  `{closed:true, reason:"idle"|"window"}` milta hai; `rooms` row + uske messages
  chale jaate hain (`bans` rehte hain).
- **Key valid rehti hai** — wahi key dobara bhejo to room **lazily reopen** hota hai
  (naya khaali room). Isliye key ko "permanent room" ki tarah treat na karo, wo
  entry ticket hai. (Exception: `closeAt` nikal gaya ho to reopen `room_not_exist`
  deta hai.)
- Idle closing band karni ho to `ROOM_IDLE_MINUTES=0`.

---

## 5. Client ↔ chat server API

| Method | Path | Body / Query | Kaam |
|---|---|---|---|
| `POST` | `/api/room/verify` | `{ "key": "rk1…" }` | key verify + lazy create → `{ok, created, room}` |
| `GET` | `/events/chat?key=…` | query | SSE stream (replay + live) |
| `GET` | `/api/chat/history?key=…&since=…&limit=…` | query | purane messages |
| `POST` | `/api/chat/send` | `{ "key": "rk1…", "body": "hi" }` | message bhejo (login zaroori) |
| `GET` | `/api/chat/stats?key=…` | query | `{room, online}` |
| `POST` | `/api/chat/send` | `{ "key": "rk1…", "kind": "sticker", "body": "six" }` | sticker (id allowlist se validate) |
| `GET` | `/api/stickers` | — | sticker id + label list (art client-side) |
| `POST` | `/api/chat/react` | `{ "key": "rk1…", "reaction": "heart" }` | ephemeral reaction (store NAHI hota) |
| `GET` | `/api/reactions` | — | reaction id + emoji list |
| `GET` | `/api/rooms` | — | sab rooms + live online count |

Key hamesha **server** verify karta hai — client kabhi `rid`/`name` khud nahi bhejta.

Har room endpoint (`verify`, `history`, `send`, `stats`, `react`, `events/chat`) ye deny
status de sakta hai: `400 no_key`, `403 not_yet|expired|bad_*`, `404 room_not_exist`.

**Reactions (`/api/chat/react`)** ek alag, ephemeral event hai — DB me store **nahi**
hota, retention/history pe koi asar nahi, aur **per-user rate limit nahi** (sirf
`REACT_MAX_PER_SEC` server-wide cap). SSE pe `event: reaction` (bina `id:`, isliye
replay nahi hota).
`/api/rooms` response me per-room `openAt` / `closeAt` bhi aata hai.

---

## 6. Issuer integration (tumhara doosra server)

### 6a. Node (same repo, zero deps)

```js
const { issueRoomKey } = require('./lib/roomkey');

const now = Math.floor(Date.now() / 1000);

const key = issueRoomKey(
  {
    rid: `match-${match.id}`,
    name: `${match.home} vs ${match.away}`,
    type: 'cricket',              // optional: room type
    meta: { kind: 'match', sport: 'cricket' },
    openAt: match.startsAt,       // optional: room opens at match start
    closeAt: match.endsAt,        // optional: room closes when match ends
  },
  {
    secret: process.env.ROOM_KEY_SECRET,
    ttlSeconds: 60 * 60 * 6,      // optional: hard key expiry too
  },
);

// share:  https://chat.example.com/?key=<key>
```

### 6b. CLI (testing / ops)

```bash
# room opens now, force-closes after 6 hours
ROOM_KEY_SECRET=$SECRET node scripts/make-room-key.js \
  --id match-1024 --name "IND vs AUS — 2nd ODI" --type cricket --close +6h \
  --url https://chat.example.com
# -> https://chat.example.com/?key=rk1.xj3...

# room opens at a fixed time, closes 3 hours later
node scripts/make-room-key.js --id match-1025 --name "Final" \
  --open "2026-11-01T14:00:00Z" --end "2026-11-01T17:00:00Z"
```

`--open`/`--start` aur `--close`/`--end` ye sab accept karte hain: `now`,
`+2h`, `-30m`, `+7d`, epoch seconds, ya ISO-8601.

### 6c. Python (agar doosra server Python me hai)

```python
import json, time, os, base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def derive(secret: str) -> bytes:
    b = bytes.fromhex(secret) if len(secret) == 64 else None
    if b and len(b) == 32:
        return b
    # base64 32-byte
    try:
        raw = base64.b64decode(secret + '=' * (-len(secret) % 4))
        if len(raw) == 32:
            return raw
    except Exception:
        pass
    import hashlib
    return hashlib.scrypt(secret.encode(), salt=b'livechat:roomkey:v1', n=16384, r=8, p=1, dklen=32)

AAD = b'livechat:roomkey:v1'
B64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()

def issue_room_key(rid, name, meta=None, ttl=None, open_at=None, close_at=None,
                   room_type=None, secret=os.environ['ROOM_KEY_SECRET']):
    now = int(time.time())
    body = {'v': 1, 'rid': rid, 'name': name, 'iat': now}
    if meta:     body['meta'] = meta
    if room_type: body['type'] = room_type
    if open_at:  body['openAt'] = int(open_at)    # unix seconds
    if close_at: body['closeAt'] = int(close_at)  # unix seconds
    if ttl:      body['exp'] = now + int(ttl)
    iv = os.urandom(12)
    blob = AESGCM(derive(secret)).encrypt(iv, json.dumps(body, separators=(',', ':')).encode(), AAD)
    # cryptography returns ciphertext||tag  ->  iv + tag + ct
    ct, tag = blob[:-16], blob[-16:]
    return 'rk1.' + B64(iv + tag + ct)
```

> ⚠️ Python ka `scrypt` default `n=16384, r=8, p=1` — Node ke `crypto.scryptSync`
> default se **match karta hai** (`N=16384, r=8, p=1`). Passphrase use kar rahe ho to
> dono taraf params fix rakhna. **Best: 64-char hex secret use karo** — tab koi
> derivation mismatch hi nahi hoga.

---

## 7. Security notes

- **Secret rotation:** `ROOM_KEY_SECRET` badla to purane saare keys invalid ho jaate hain.
  Zero-downtime rotation chahiye to verifier me do secrets support karo (naya + purana)
  aur ek window tak dono accept karo.
- **Key = access token.** Jiske paas key hai wo room me aa sakta hai — kaise bhi share mat karo
  (public GitHub, screenshot). `exp` kam rakho.
- **Logs:** chat server key ko log nahi karta, sirf `rid` + `name` (create hone par).
  Reverse-proxy access logs me `?key=` aa sakti hai — nginx me `log_format` se strip kar dena
  behtar hai.
- **Replay:** design hi reusable hai (ye intended hai). Single-use chahiye to payload me
  `jti` daalo aur chat server ek `used_keys` table rakhke enforce kare (v2).
- **Room id choice:** `rid` = stable identity. `match-1024` jaisa rakho, random nahi —
  warna re-issue pe naya room ban jaayega.

---

## 8. Versioning

`rk1` prefix future me `rk2` (naya cipher/format) ko allow karta hai. Verifier unknown
prefix ko `bad_format` deta hai, isliye purane clients safe rehte hain.
