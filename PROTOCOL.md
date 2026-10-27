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
  "iat": 1761540000,
  "exp": 1761543600,
  "meta": { "kind": "match", "sport": "cricket" }
}
```

| Field | Type | Req | Rules |
|---|---|---|---|
| `v` | int | ✅ | `1` |
| `rid` | string | ✅ | `^[a-zA-Z0-9_-]{1,64}$` — **room id** |
| `name` | string | ✅ | 1–64 chars — room display name |
| `iat` | int | ✅ | issued-at, unix **seconds** |
| `exp` | int | ❌ | unix seconds; agar present aur `now > exp` → reject |
| `meta` | object | ❌ | client ko wapas milta hai (icon, kind, etc.) |

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
9. `exp` present && expired → `expired`

`bad_signature` pe **timing-safe** hona GCM me built-in hai (tag check constant-time).

### Error codes

| Code | HTTP | Matlab |
|---|---|---|
| `no_key` | 400 | koi key bheji nahi gayi |
| `bad_format` | 403 | prefix / encoding galat |
| `bad_signature` | 403 | decrypt fail — fake ya corrupted key |
| `bad_payload` | 403 | JSON nahi |
| `bad_version` | 403 | `v != 1` |
| `bad_room` | 403 | rid regex fail |
| `bad_name` | 403 | name missing/too long |
| `expired` | 403 | `exp` nikal gaya |

---

## 4. Room lifecycle (lazy create)

```
client key bhejta hai
        │
        ▼
  key verify hoti hai
        │
        ▼
  rooms table me rid hai?
   ├── NAHI  →  ROOM BANTA HAI  (name/meta key se aate hain, created=1)
   └── HAAN  →  SIRF JOIN       (existing room hi use hota hai, created=0)
```

- **Same key, multiple clients** → sab ek hi room me. Koi limit nahi.
- **Same rid, different key** → bhi same room (rid hi identity hai).
- Room ka `name`/`meta` **pehli baar** banate waqt set hota hai; baad me overwrite
  nahi hota (predictable). Name badalna ho to room id naya do ya DB me update karo.
- Room **delete** nahi hota; messages `prune` hote hain (default 7 din).

---

## 5. Client ↔ chat server API

| Method | Path | Body / Query | Kaam |
|---|---|---|---|
| `POST` | `/api/room/verify` | `{ "key": "rk1…" }` | key verify + lazy create → `{ok, created, room}` |
| `GET` | `/events/chat?key=…` | query | SSE stream (replay + live) |
| `GET` | `/api/chat/history?key=…&since=…&limit=…` | query | purane messages |
| `POST` | `/api/chat/send` | `{ "key": "rk1…", "body": "hi" }` | message bhejo (login zaroori) |
| `GET` | `/api/chat/stats?key=…` | query | `{room, online}` |
| `GET` | `/api/rooms` | — | sab rooms + live online count |

Key hamesha **server** verify karta hai — client kabhi `rid`/`name` khud nahi bhejta.

---

## 6. Issuer integration (tumhara doosra server)

### 6a. Node (same repo, zero deps)

```js
const { issueRoomKey } = require('./lib/roomkey');

const key = issueRoomKey(
  {
    rid: `match-${match.id}`,
    name: `${match.home} vs ${match.away}`,
    meta: { kind: 'match', sport: 'cricket' },
  },
  {
    secret: process.env.ROOM_KEY_SECRET,
    ttlSeconds: 60 * 60 * 6,      // 6 hours; omit for no expiry
  },
);

// share:  https://chat.example.com/?key=<key>
```

### 6b. CLI (testing / ops)

```bash
ROOM_KEY_SECRET=$SECRET node scripts/make-room-key.js \
  --id match-1024 --name "IND vs AUS — 2nd ODI" --ttl 21600 \
  --url https://chat.example.com
# -> https://chat.example.com/?key=rk1.xj3...
```

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

def issue_room_key(rid, name, meta=None, ttl=None, secret=os.environ['ROOM_KEY_SECRET']):
    now = int(time.time())
    body = {'v': 1, 'rid': rid, 'name': name, 'iat': now}
    if meta: body['meta'] = meta
    if ttl:  body['exp'] = now + int(ttl)
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
