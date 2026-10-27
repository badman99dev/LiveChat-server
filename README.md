# live-chat-sse 🎙️

Live chat + live score, **poore zero framework** pe — sirf Node ka `http` module, SSE (Server-Sent Events) aur SQLite. Ek hi TLS connection pe multiple streams, writes ke liye normal `POST`.

```
Browser ──HTTP/2──► Nginx ──► Node (SSE + POST) ──► SQLite
              │
              ├─ GET  /events/chat?key=rk1...   (stream, browser-native reconnect)
              ├─ GET  /events/score             (stream, doosri stream parallel)
              ├─ POST /api/room/verify          (room key validate)
              └─ POST /api/chat/send            (write path)
```

WebSocket **nahi** hai. Kyun? Dekho [Kyun SSE?](#kyun-sse-websocket-nahi).
Room me entry **Room Access Key (RAK)** se hoti hai — dekho [Room Access Keys](#room-access-keys-rak-).

---

## Features ✅

- **SSE chat** — server → client push, browser khud reconnect karta hai
- **Room Access Keys (RAK)** — encrypted `rk1...` key me room id + name, lazy room create, multi-use
- **Key-embedded window** — `openAt` / `closeAt` optional; window ke bahar key sirf enter kar sakti hai
- **Stickers** — server sirf sticker **id** bhejta hai, art client-side (`/stickers/*.svg`), id allowlist se validate
- **Reaction bar** — YouTube-jaisa emoji spam: **ephemeral** (DB me store nahi), per-user rate limit **nahi**, server-wide safety cap
- **Room type** — key me `type` (cricket/football/food/...); uske hisaab se stickers/reactions filter — chaat room me wicket sticker nahi aayega 😄
- **Auto retention** — 10 min purane messages delete, 30 min idle room auto-close (configurable)
- **Free gap-fill** — `Last-Event-ID` header se miss hui messages apne aap replay
- **Do parallel streams** — chat + score ek hi connection pe (HTTP/2 multiplexing)
- **Cookie auth** — HMAC-signed `sid` cookie, koi JWT library nahi
- **Rate limit** — per-user (chat) + per-IP (login), memory-map based
- **Mute/ban** — room-wise, SQLite `bans` table se
- **Self-hosted fonts** — Barlow / Barlow Condensed / IBM Plex Mono, koi Google CDN nahi
- **Graceful shutdown** — SIGTERM pe streams close + DB prune
- **Low-RAM tuned** — 512MB VPS pe ~50MB RSS, `MemoryMax=384M` cap
- **Path-traversal safe** — static server `PUBLIC_DIR` ke bahar nahi jaata

---

## Quick start 🚀

```bash
# 1. deps
npm install                     # better-sqlite3 compile hota hai

# 2. env
cp deploy/.env.example .env     # SESSION_SECRET zaroor badlo

# 3. chalao
npm start                       # http://127.0.0.1:8080
```

Dev mode (auto-restart on file change):
```bash
npm run dev
```

Health check:
```bash
curl localhost:8080/healthz
# {"ok":true,"uptime":12.3}
```

---

## Env vars ⚙️

| Var | Default | Matlab |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (nginx ke peeche hi rakho) |
| `SESSION_SECRET` | — | **Zaroori.** Cookie sign karne ke liye. `openssl rand -hex 32` |
| `COOKIE_SECURE` | auto | `true` HTTPS pe. Auto = `X-Forwarded-Proto` se detect |
| `ADMIN_TOKEN` | `` (empty) | Set karo to `POST /api/score` unlock. Empty = endpoint band |
| `MOCK_SCORE` | `true` | Mock cricket feed. Real scores bhjone ke liye `false` |
| `MOCK_SCORE_MS` | `7000` | Mock update interval (ms) |
| `CHAT_MAX_LEN` | `500` | Max message length |
| `RATE_MS` | `1000` | Ek user ek ms mein kitne ms wait kare |
| `REPLAY_LIMIT` | `100` | Reconnect pe max kitne messages replay ho |
| `DATA_DIR` | `./data` | SQLite file kahan |
| `ROOM_KEY_SECRET` | `` (empty) | **RAK ke liye.** Shared secret (64-hex ya base64 ya koi bhi string). Empty = keys band |
| `DEFAULT_ROOM` | `` (empty) | Key na ho to fallback room id (dev/demo). Empty = sirf key-based rooms |
| `DEFAULT_ROOM_NAME` | `Public chat` | Fallback room ka display naam |
| `RETENTION_MINUTES` | `10` | Isse purane messages delete (10 min ka chat retention) |
| `ROOM_IDLE_MINUTES` | `30` | Itni der koi activity na ho to room **close** (row + messages delete). `0` = kabhi nahi |
| `PRUNE_INTERVAL_MS` | `30000` | Sweeper kitni der me chale (ms) |

---

## Retention & room lifespan ⏳

Do cheezein **sweeper** (har `PRUNE_INTERVAL_MS`, default 30s) handle karta hai:

| Cheez | Rule | Default |
|---|---|---|
| **Messages** | `created_at` isse purana → **delete** | `RETENTION_MINUTES=10` → last **10 min** ka chat |
| **Rooms** | Koi **activity** nahi → room **close** (row + uske messages delete) | `ROOM_IDLE_MINUTES=30` → **30 min** idle pe close |
| **Rooms** | Key ka `closeAt` nikal gaya → usi instant close | key ke andar (optional) |

**Activity kya maana jaata hai?** Room ka koi bhi touch: key verify, `/api/chat/history`, message send, ya SSE connect. Jo room 30 min tak chhua nahi gaya, wo band.

**Room close hone pe:**
- `rooms` row + uske saare messages delete (`bans` chhod ke).
- Connected clients ko final SSE `event: room` `{closed:true, reason:"idle"|"window"}` jaata hai → frontend key gate pe wapas, "room closed" notice ke saath.
- Key **valid rehta hai** — wahi key dobara bhejo to room **lazily reopen** ho jaata hai (fresh room, khaali chat). (Agar key ka `closeAt` nikal gaya ho to reopen `404 room_not_exist` deta hai.)

> 💡 `ROOM_IDLE_MINUTES=0` set karo → rooms kabhi auto-close nahi honge (sirf 10-min message retention lagegi).

---

## Room Access Keys (RAK) 🔑

Chat room me ghusne ke liye **encrypted key** chahiye — format `rk1...`. Key ke andar room id (`rid`) aur naam encoded hota hai, isliye server ko kuch bhi trust karne ki zaroorat nahi. Pehli valid key aane pe room **khud ban jaata hai** (lazy create), uske baad wahi key se jitne chaho log join kar sakte hain.

```
Key-issuer server ──issue──►  rk1...  ──►  Chat server ──verify──►  room
      (optional)                                (ye repo)
             └────────────── shared ROOM_KEY_SECRET ──────────────┘
```

**Flow:**
1. Koi key bhejta hai (URL `?key=rk1...` ya frontend ke key-gate modal me paste)
2. Server `POST /api/room/verify` pe verify karta hai → `{ok, created, room}`
3. Verify pass → `GET /events/chat?key=rk1...` stream khulta hai, chat live 🎉

**Naam se login + key se room:** `sid` cookie = user identity (room se independent). Room **hamesha key se** derive hota hai, isliye ek user ek hi time pe multiple rooms me ho sakta hai (multi-tab safe).

**Secret:** `ROOM_KEY_SECRET` dono servers pe same hona chahiye — key-issuer aur chat server. Secret badla → purane saare keys invalid.

**Key ke andar room ka window bhi chhupa sakte ho** (`openAt` / `closeAt`, dono optional):

| Key me | Matlab |
|---|---|
| `type` | Room ka type (`cricket`, `football`, `food`...) — stickers/reactions isi se filter hote hain |
| `openAt` | Isse pehle room khulega hi nahi → `403 not_yet` |
| `closeAt` | Is waqt room **band**; uske baad key **sirf enter** kar sakti hai, reopen nahi → `404 room_not_exist` |
| dono | Room sirf `[openAt, closeAt)` ke andar open/re-open ho sakta hai, `closeAt` pe band |

`type` optional hai (1–32 chars, `a-z 0-9 _ -`). Naya type = bas key me daal do; sticker/reaction jo us type ke liye tag kiye hain wahi dikhte hain (universal ones sab jagah).

> `closeAt` = room ka "khatam hone ka time". Uske baad key zinda rehti hai par uske paas **sirf enter ka haq** hai. Room already band ho gaya ho to `room_not_exist` (404) milta hai aur SSE stream turant band — koi RAM waste nahi.

**Key generate karo:**
```bash
ROOM_KEY_SECRET=$(openssl rand -hex 32) node scripts/make-room-key.js \
  --id match-1024 --name "IND vs AUS — 2nd ODI" --type cricket --close +6h
# rk1.AbCd...xyz

# fixed window
node scripts/make-room-key.js --id final-1 --name "Final" --type football \
  --open "2026-11-01T14:00:00Z" --end "2026-11-01T17:00:00Z"
```

**Wire format, error codes, Python issuer, rotation — sab detail me [`PROTOCOL.md`](./PROTOCOL.md) me hai.** 👈

---

## 🔐 Client identity (Firebase JWT + handle)

Every request the app makes carries two headers:

```
Authorization: Bearer <firebase id token>
X-Chat-Handle:  <server-assigned handle, e.g. rahul_k7x2>
```

This server verifies **both** against the BlazeMovies identity endpoint
(`POST /v1/internal/chat-identity`, shared-secret protected) and then uses the
**canonical handle from that response** — a client-typed display name is never
trusted, so nobody can post under someone else's handle.

Verified on: `POST /api/login`, `POST /api/chat/send`, `POST /api/chat/react`,
`GET /events/chat` (a failed check gets a terminal `denied` event) and `GET /api/me`.
Results are cached in-process per token (`IDENTITY_CACHE_MS`, default 5 min), so
the extra hop costs one call per few minutes — not one per message.

When the identity is verified the chat session's uid **is the Firebase uid**, so
mutes / bans / reports follow the account instead of one socket.

Sab kuch **`config.js`** me hardcoded hai — deploy ke liye koi env var set
karne ki zarurat nahi. Env var (same naam) set karne par wo config ko override
karta hai (local testing ke liye):

```js
// config.js
IDENTITY_URL:          'https://blazemovies.badman993944.workers.dev/v1/internal/chat-identity'
IDENTITY_SECRET:       '<must equal CHAT_IDENTITY_SECRET on the backend>'
IDENTITY_REQUIRED:     false     // true = purane builds (bina identity) reject
IDENTITY_CACHE_MS:     300000    // verified combo TTL (5 min)
IDENTITY_NEGATIVE_MS:  30000     // rejection TTL
IDENTITY_COMBO_MAX:    10        // NEW combos per IP ...
IDENTITY_COMBO_WINDOW_MS: 1800000 // ... per 30 min
IDENTITY_TIMEOUT_MS:   4000
ROOM_KEY_SECRET:       '...'     // same as the Cricfy issuer
```

Caching is keyed by the **(jwt + handle) combination**, so the same person costs
one upstream call, not one per message. A new combination is verified again, and
each IP gets a budget of `IDENTITY_COMBO_MAX` new combinations per
`IDENTITY_COMBO_WINDOW_MS` — beyond that the request fails with **429** +
`retryAfter` (SSE gets `denied` + `retryAfter`). Combinations already verified
keep working from cache even after the IP hits its budget.

**Rollout:** keep `IDENTITY_REQUIRED=false` while older builds (no headers) are
in use — they keep working with the legacy client-typed name. Flip to `true`
once every shipped client sends identity.

Backend contract (BlazeMovies):

```jsonc
POST /v1/internal/chat-identity
X-Identity-Secret: <CHAT_IDENTITY_SECRET>
{"jwt":"<firebase id token>","handle":"rahul_k7x2"}

200 {"status":"success","data":{"uid":"...","handle":"rahul_k7x2","email_verified":true}}
401 invalid/expired jwt · 403 wrong secret or handle mismatch · 503 not configured
```

---

## API endpoints 🔌

### Auth
| Method | Path | Body | Kaam |
|---|---|---|---|
| `GET` | `/api/me` | — | Current user `{user:{id,name}}` ya `{user:null}` |
| `POST` | `/api/login` | `{"name":"Arjun"}` | Cookie issue karta hai (2-24 chars) |
| `POST` | `/api/logout` | — | Cookie clear |

### Rooms
| Method | Path | Kaam |
|---|---|---|
| `POST` | `/api/room/verify` | `{"key":"rk1..."}` → verify + lazy create → `{ok, created, room}` |
| `GET` | `/api/rooms` | Sab rooms + live online count |

### Chat
| Method | Path | Kaam |
|---|---|---|
| `GET` | `/api/chat/history?key=rk1...&limit=50` | Last N messages |
| `GET` | `/api/chat/history?key=rk1...&since=42` | seq 42 ke baad ke messages (replay) |
| `POST` | `/api/chat/send` | `{"key":"rk1...","body":"hello"}` → broadcast |
| `POST` | `/api/chat/send` | `{"key":"rk1...","kind":"sticker","body":"six"}` → sticker |
| `POST` | `/api/chat/react` | `{"key":"rk1...","reaction":"heart"}` → ephemeral reaction (store nahi hota) |
| `GET` | `/api/chat/stats?key=rk1...` | `{room, online}` |
| `GET` | `/api/stickers?type=cricket` | Sticker id + label list (type ke hisaab se filtered; art client-side) |
| `GET` | `/api/reactions?type=cricket` | Reaction id + emoji list (type-filtered) |

### Streams (SSE)
| Method | Path | Events |
|---|---|---|
| `GET` | `/events/chat?key=rk1...` | `hello`, `chat`, `presence`, `reaction`, `room` (closed), `denied` (terminal) |
| `GET` | `/events/score` | `score` |

### Admin
| Method | Path | Header | Kaam |
|---|---|---|---|
| `POST` | `/api/score` | `x-admin-token: <ADMIN_TOKEN>` | Score state update |

### Other
| Method | Path | Kaam |
|---|---|---|
| `GET` | `/healthz` | `{ok, uptime}` |

---

## SSE wire format 📡

Har event aisa dikhta hai:

```
id: 42
event: chat
data: {"seq":42,"room":"match-1024","userId":"u_ab12","name":"Arjun","kind":"text","body":"hi","ts":1730000000000}

id: 43
event: chat
data: {"seq":43,"room":"match-1024","userId":"u_ab12","name":"Arjun","kind":"sticker","body":"six","ts":1730000001200}

```

`kind` = `text` (default) ya `sticker`. Sticker message me `body` = sticker **id** (e.g. `six`), asli art client `public/stickers/<id>.svg` se laata hai.

Reaction ek alag, **ephemeral** event hai (koi `id:` nahi, isliye replay nahi hota):

```
event: reaction
data: {"rid":"r7","reaction":"heart","emoji":"❤️","userId":"u_ab12","name":"Arjun","ts":1730000002000}

```

- `id:` = message seq number. Browser ise yaad rakhta hai.
- Reconnect hone pe browser `Last-Event-ID: 42` header bhejta hai → server seq 42 ke baad ke saare messages bhej deta hai. **Messages kabhi miss nahi hote.**
- Har 20s mein `: ping` comment (heartbeat) — proxies connection zinda rakhte hain.

### Browser me subscribe
```js
const key = 'rk1.AbCd...';                       // room access key
const es = new EventSource(`/events/chat?key=${encodeURIComponent(key)}`);

es.addEventListener('chat', (e) => {
  const msg = JSON.parse(e.data);
  console.log(msg.name, msg.body);
});

es.addEventListener('presence', (e) => {
  console.log('online:', JSON.parse(e.data).online);
});

es.addEventListener('error', () => {
  // browser khud reconnect karega, kuch karne ki zaroorat nahi
});
```
> ⚠️ `EventSource` custom headers nahi bhej sakta — isliye auth **cookie** se hota hai, room `?key=` query se.

### Message bhejna
```js
await fetch('/api/chat/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',                        // cookie (login) zaroori
  body: JSON.stringify({ key, body: 'hello' }),
});

// sticker bhejna (id allowlist me honi chahiye)
await fetch('/api/chat/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ key, kind: 'sticker', body: 'six' }),
});
```

---

## Kyun SSE (WebSocket nahi)? 🤔

Tumhara case: **~100 concurrent users, 512MB RAM.**

| | SSE | WebSocket |
|---|---|---|
| Server → client push | ✅ | ✅ |
| Client → server | ❌ (POST use karo) | ✅ (2-way) |
| Reconnect + replay | ✅ built-in (`Last-Event-ID`) | ❌ khud likho |
| Infra (proxy/CDN) | Plain HTTP, sab support | Upgrade handshake, alag config |
| Server RAM | Kam | Zyada (`ws` buffers per socket) |
| Code | 0 deps | `ws` / `socket.io` |

Live chat me **server → client 99% traffic hai** (broadcast). Client → server sirf message send, jo `POST` se ho jaata hai. Isliye SSE perfect hai aur WebSocket ke saare complexity se bacha.

**Kab WebSocket lo?** Real-time typing indicators, gaming, collaborative editing, jahan sub-second 2-way chahiye.

---

## Deploy — Ubuntu VPS (Nginx + systemd) 🌐

Assume: Ubuntu 22.04 VM, domain `chat.example.com`, DNS pehle se point hai.

### 1. Node 20 + deps
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo apt install -y build-essential python3   # better-sqlite3 compile ke liye
```

### 2. App user + code
```bash
sudo useradd -r -m -d /opt/live-chat -s /usr/sbin/nologin chatapp
sudo mkdir -p /opt/live-chat
sudo rsync -a --exclude node_modules --exclude data ./ /opt/live-chat/
sudo chown -R chatapp:chatapp /opt/live-chat
```

### 3. Build + env
```bash
cd /opt/live-chat
sudo -u chatapp npm install --omit=dev
sudo -u chatapp cp deploy/.env.example .env
sudo -u chatapp sed -i "s|change-me.*|$(openssl rand -hex 32)|" .env
sudo -u chatapp mkdir -p data
```

### 4. systemd service
```bash
sudo cp deploy/chat.service /etc/systemd/system/live-chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now live-chat
sudo systemctl status live-chat
```

### 5. Nginx
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/live-chat
sudo sed -i 's/chat.example.com/YOUR_DOMAIN/g' /etc/nginx/sites-available/live-chat
sudo ln -sf /etc/nginx/sites-available/live-chat /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 6. HTTPS (Let's Encrypt)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

Bas! `https://YOUR_DOMAIN` pe live chat chalega. 🎉

---

## Deploy — Render (ek click) ⚡

Repo me `render.yaml` (Blueprint) ready hai.

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
2. Apna GitHub repo connect karo → Render `render.yaml` khud padh lega
3. **Apply** dabao — `SESSION_SECRET` auto-generate ho jaayega
4. 2-3 min me live: `https://livechat-server-xxxx.onrender.com`

**Yaad rakho:**
- Free plan pe filesystem **ephemeral** hai — har deploy/restart pe chat history reset. Demo ke liye theek hai.
- **History permanent chahiye?** `render.yaml` me `plan: starter` karo aur `disk:` block uncomment karo.
- `HOST=0.0.0.0` (Render ki zaroorat) aur `COOKIE_SECURE=true` (TLS) already set hain.
- Free instance 15 min inactive ke baad sleep karta hai — pehla request slow hoga.

---

## Nginx me ye lines **mandatory** hain ⚠️

SSE ke liye warna events stuck ho jaate hain:

```nginx
proxy_buffering off;      # warna nginx events buffer kar leta hai, client ko late milte hain
gzip off;                 # gzip bhi buffer karta hai
proxy_read_timeout 24h;   # default 60s = har minute connection toot jaata
chunked_transfer_encoding on;
```

Aur `http2 on;` — ek TLS connection pe chat + score dono streams chalti hain.

---

## Doosri SSE stream kaise add kare? ➕

Score stream (`/events/score`) isi ka live example hai. Naya stream (e.g. notifications):

```js
// 1. server.js me
if (url.pathname === '/events/notify') {
  openStream(req, res);
  res.write(`event: hello\ndata: {}\n\n`);
  const key = 'notify';
  hub.add(key, res);
  req.on('close', () => hub.remove(key, res));
}

// 2. kahin se bhi broadcast
hub.emit('notify', 'notify', { text: 'new follower!' });
```

```js
// 3. client
const n = new EventSource('/events/notify');
n.addEventListener('notify', (e) => showToast(JSON.parse(e.data)));
```

`Hub` khud rooms handle karta hai (`chat:<rid>` per room) — alag streams/rooms free hain.

---

## Reaction bar (emoji spam) 💥

YouTube-style: log bina rukawat ❤️ 👍 🔥 😂 🎉 👏 spam karte hain. Design:

- **Store nahi hota** — reactions DB me nahi jaate, na retention, na history. Sirf SSE event.
- **Per-user rate limit nahi** — spam karna hi point hai. `POST /api/chat/react {key, reaction}`.
- **Safety cap** — `REACT_MAX_PER_SEC` (default `500`) poore **server** ka firehose cap hai; limit cross ho to extra reactions chup-chaap drop (client ko `{ok:true,dropped:true}`). `0` = unlimited.
- Client tap pe **turant** apna emoji float karta hai, aur SSE se baaki sab ke. Apne hi event ko skip karta hai (double na dikhe).
- **Login zaroori** (401 warna) taaki anonymous flood na ho, par reaction pe koi cooldown nahi.

Naya reaction add karna: `lib/reactions.js` me `{ id, emoji, label }` daal do. Bas.

---

## Naya sticker add karna 🏷️

Server sirf **id** jaanta hai, art client-side rehti hai:

1. `lib/stickers.js` me entry add karo:
   - har room me: `{ id: 'hattrick', label: 'Hat-trick!' }`
   - sirf cricket room me: `{ id: 'hattrick', label: 'Hat-trick!', types: ['cricket'] }`
2. `public/stickers/hattrick.svg` daal do

Bas. Client `/api/stickers?type=<room type>` se list laata hai aur `/stickers/<id>.svg`
render karta hai. Server id ko allowlist se validate karta hai — galat id pe
`400 unknown sticker`, isliye koi client arbitrary id inject nahi kar sakta.

---

## Scaling notes 📈

- **1 server, 512MB RAM:** ~5,000-10,000 idle SSE connections aaram se. 100 users = mushkil se 50MB.
- **Multiple rooms:** har room apni `rid` + RAK key pe alag hai. Ek user multi-tab me multiple rooms me ho sakta hai.
- **Bahut zyada users (>10k):** SSE edge (Cloudflare/Fly) + multiple Node instances + Redis pub/sub for `hub.emit` fan-out.
- **SQLite:** single-writer, isliye writes serialized. Chat me problem nahi. Agar 10k msgs/sec chahiye to Postgres + LISTEN/NOTIFY.
- **OS tuning:** `worker_rlimit_nofile 8192` (nginx) + `LimitNOFILE=8192` (systemd) me set hai.

---

## Troubleshooting 🔧

| Problem | Fix |
|---|---|
| Events client ko late milte hain | `proxy_buffering off;` + `gzip off;` nginx me |
| Har ~60s pe connection toot jaata | `proxy_read_timeout 24h;` set karo |
| `better-sqlite3` install fail | `build-essential` + `python3` install karo |
| Login ke baad bhi "login required" | `COOKIE_SECURE=false` (http) ya HTTPS pe daalo |
| Cookie set nahi ho raha HTTPS pe | `COOKIE_SECURE=true` aur nginx `X-Forwarded-Proto` bhej raha ho |
| Reconnect pe purane messages dobara | Client-side seq dedupe (frontend me already hai) |
| `403 bad_signature` / `bad_format` | Key corrupt hai ya `ROOM_KEY_SECRET` issuer se match nahi karta |
| `400 no_key` | Key bheji hi nahi gayi (aur `DEFAULT_ROOM` bhi empty hai) |
| `500 no_secret` | Chat server pe `ROOM_KEY_SECRET` set nahi hai |

---

## Project structure 📁

```
live-chat-sse/
├── server.js              # HTTP server, routes, room-key resolution, SSE endpoints
├── lib/
│   ├── db.js              # SQLite: messages (text+sticker) + bans + rooms
│   ├── roomkey.js         # RAK issue/verify (AES-256-GCM, rk1)
│   ├── stickers.js        # sticker id allowlist (server knows ids only)
│   ├── reactions.js       # reaction emoji allowlist (ephemeral)
│   ├── auth.js            # HMAC signed cookie sessions
│   ├── sse.js             # Hub (rooms) + openStream + heartbeat
│   └── score.js           # Mock score feed (example 2nd stream)
├── public/
│   ├── index.html         # Chat UI + room header + key gate + sticker picker
│   ├── style.css          # Broadcast-lime dark theme
│   ├── app.js             # key gate + 2 EventSource + POST, stickers, dedupe
│   ├── favicon.svg
│   ├── stickers/          # sticker SVGs, served client-side by id
│   └── fonts/             # Self-hosted woff2 (156K total)
├── scripts/
│   └── make-room-key.js   # CLI: room access key mint karo
├── deploy/
│   ├── nginx.conf         # HTTP/2 + SSE-safe proxy config
│   ├── chat.service       # systemd unit (low-RAM tuned)
│   └── .env.example
├── PROTOCOL.md            # RAK spec (issuer + verifier)
├── .node-version          # 20.18.0 (Render better-sqlite3 fix)
├── .gitignore
└── README.md
```

---

## License
MIT — jo karna hai karo. 😎
