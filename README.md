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

**Key generate karo:**
```bash
ROOM_KEY_SECRET=$(openssl rand -hex 32) node scripts/make-room-key.js \
  --id match-1024 --name "IND vs AUS — 2nd ODI" --ttl 7d
# rk1.AbCd...xyz
```

**Wire format, error codes, Python issuer, rotation — sab detail me [`PROTOCOL.md`](./PROTOCOL.md) me hai.** 👈

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
| `GET` | `/api/chat/stats?key=rk1...` | `{room, online}` |

### Streams (SSE)
| Method | Path | Events |
|---|---|---|
| `GET` | `/events/chat?key=rk1...` | `hello`, `chat`, `presence` |
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
data: {"seq":42,"room":"match-1024","userId":"u_ab12","name":"Arjun","body":"hi","ts":1730000000000}

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
│   ├── db.js              # SQLite: messages + bans + rooms, replay/history/prune
│   ├── roomkey.js         # RAK issue/verify (AES-256-GCM, rk1)
│   ├── auth.js            # HMAC signed cookie sessions
│   ├── sse.js             # Hub (rooms) + openStream + heartbeat
│   └── score.js           # Mock score feed (example 2nd stream)
├── public/
│   ├── index.html         # Chat UI + room header + key gate modal
│   ├── style.css          # Broadcast-lime dark theme
│   ├── app.js             # key gate + 2 EventSource + POST, dedupe, scroll-freeze
│   ├── favicon.svg
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
