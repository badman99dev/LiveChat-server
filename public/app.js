const $ = (id) => document.getElementById(id);

const MAX_NODES = 350;
const RATE_MS = 1100;
const KEY_STORE = 'livchat.roomkey';

const state = {
  user: null,
  key: null,
  room: null,
  chatEs: null,
  seen: new Set(),
  frozen: false,
  unread: 0,
  cooldownUntil: 0,
  lastFeedTs: 0,
  feedDown: false,
};

const els = {
  msgs: $('messages'),
  body: $('chatBody'),
  online: $('online'),
  input: $('input'),
  send: $('send'),
  count: $('count'),
  jump: $('jump'),
  composer: $('composer'),
  stickerToggle: $('stickerToggle'),
  stickerPanel: $('stickerPanel'),
  stickerGrid: $('stickerGrid'),
  reactionBar: $('reactionBar'),
  floatLayer: $('floatLayer'),
  keyModal: $('keyModal'),
  keyForm: $('keyForm'),
  keyInput: $('keyInput'),
  keyError: $('keyError'),
  nameModal: $('nameModal'),
  nameForm: $('nameForm'),
  nameInput: $('nameInput'),
  nameError: $('nameError'),
  changeName: $('changeName'),
  leaveRoom: $('leaveRoom'),
  roomName: $('roomName'),
  roomId: $('roomId'),
  chatStatus: $('chatStatus'),
  feedStatus: $('feedStatus'),
  feedNote: $('feedNote'),
};

function setStatus(el, stateName) {
  el.dataset.state = stateName;
}

function storedKey() {
  try {
    return sessionStorage.getItem(KEY_STORE) || '';
  } catch {
    return '';
  }
}

function saveKey(key) {
  try {
    if (key) sessionStorage.setItem(KEY_STORE, key);
    else sessionStorage.removeItem(KEY_STORE);
  } catch {
    /* ignore (private mode) */
  }
}

/* ---------------- stickers ---------------- */
/* The server only knows sticker ids; the artwork is fetched from /stickers/
   (client-side asset). Sending a sticker posts { kind:'sticker', body:<id> }. */

const STICKER_BASE = '/stickers';
let stickersReady = false;

async function loadStickers() {
  if (stickersReady) return;
  try {
    const res = await fetch('/api/stickers');
    const data = await res.json();
    const list = data.stickers || [];
    const base = data.basePath || STICKER_BASE;
    els.stickerGrid.replaceChildren();
    for (const s of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sticker-btn';
      btn.title = s.label || s.id;
      btn.dataset.id = s.id;
      const img = document.createElement('img');
      img.src = `${base}/${encodeURIComponent(s.id)}.svg`;
      img.alt = s.label || s.id;
      img.loading = 'lazy';
      img.draggable = false;
      btn.append(img);
      els.stickerGrid.append(btn);
    }
    stickersReady = true;
  } catch {
    /* ignore — stickers are optional */
  }
}

function toggleStickerPanel(force) {
  const show = force ?? els.stickerPanel.hidden;
  els.stickerPanel.hidden = !show;
  els.stickerToggle.setAttribute('aria-expanded', String(show));
  els.stickerToggle.classList.toggle('active', show);
}

els.stickerToggle.addEventListener('click', () => {
  loadStickers();
  toggleStickerPanel();
});

els.stickerGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.sticker-btn');
  if (!btn) return;
  sendSticker(btn.dataset.id);
});

document.addEventListener('click', (e) => {
  if (els.stickerPanel.hidden) return;
  if (els.composer.contains(e.target)) return;
  toggleStickerPanel(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleStickerPanel(false);
});

/* ---------------- reactions (ephemeral, spam-friendly) ---------------- */
/* Not stored in the DB, not rate-limited per user. A tap floats an emoji
   locally and fires a tiny SSE event so the whole room sees it. */

let reactionsReady = false;

async function loadReactions() {
  if (reactionsReady) return;
  try {
    const res = await fetch('/api/reactions');
    const data = await res.json();
    const list = data.reactions || [];
    els.reactionBar.replaceChildren();
    for (const r of list) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'react-btn';
      btn.dataset.id = r.id;
      btn.title = r.label || r.id;
      btn.textContent = r.emoji;
      els.reactionBar.append(btn);
    }
    els.reactionBar.hidden = list.length === 0;
    reactionsReady = true;
  } catch {
    /* reactions are optional */
  }
}

els.reactionBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.react-btn');
  if (!btn) return;
  if (!state.key) return openKeyModal();
  if (!state.user) return openNameModal();
  floatReaction(btn.textContent, true); // instant local feedback
  sendReaction(btn.dataset.id); // fire-and-forget
});

async function sendReaction(reaction) {
  try {
    await fetch('/api/chat/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.key, reaction }),
      credentials: 'include',
    });
  } catch {
    /* best-effort */
  }
}

function floatReaction(emoji, mine) {
  const span = document.createElement('span');
  span.className = 'float-emoji' + (mine ? ' mine' : '');
  span.textContent = emoji;
  span.style.left = `${10 + Math.random() * 80}%`;
  span.style.setProperty('--drift', `${(Math.random() - 0.5) * 90}px`);
  els.floatLayer.append(span);
  span.addEventListener('animationend', () => span.remove(), { once: true });
  while (els.floatLayer.childElementCount > 60) els.floatLayer.firstElementChild.remove();
}

/* ---------------- second SSE stream (live score) ---------------- */
/* Room chat ke saath ye doosra EventSource chalta hai — same HTTP/2 connection. */

function connectFeed() {
  const es = new EventSource('/events/score');

  es.addEventListener('open', () => {
    state.feedDown = false;
    setStatus(els.feedStatus, 'live');
  });

  es.addEventListener('error', () => {
    state.feedDown = true;
    setStatus(els.feedStatus, 'connecting');
    els.feedNote.textContent = 'feed reconnecting...';
    els.feedNote.className = 'feed-note bad';
  });

  es.addEventListener('score', (e) => {
    const data = JSON.parse(e.data);
    state.lastFeedTs = data.updatedAt || Date.now();
    state.feedDown = false;
    setStatus(els.feedStatus, 'live');
    renderFeedNote();
  });
}

function renderFeedNote() {
  if (state.feedDown) return;
  if (!state.lastFeedTs) {
    els.feedNote.textContent = 'feed —';
    els.feedNote.className = 'feed-note';
    return;
  }
  const secs = Math.max(0, Math.round((Date.now() - state.lastFeedTs) / 1000));
  els.feedNote.textContent = secs < 2 ? 'feed live' : `feed ${secs}s ago`;
  els.feedNote.className = 'feed-note ok';
}

setInterval(renderFeedNote, 1000);

/* ---------------- room key ---------------- */

function renderRoom() {
  if (!state.room) return;
  els.roomName.textContent = state.room.name || state.room.id;
  els.roomId.textContent = state.room.id ? `#${state.room.id}` : '';
  els.leaveRoom.hidden = false;
}

async function verifyKey(key) {
  try {
    const res = await fetch('/api/room/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || data.error || 'invalid key' };

    state.key = key;
    state.room = data.room;
    saveKey(key);
    renderRoom();
    return { ok: true, created: !!data.created };
  } catch {
    return { ok: false, error: 'network error, try again' };
  }
}

function openKeyModal() {
  els.keyError.hidden = true;
  els.keyModal.hidden = false;
  setTimeout(() => els.keyInput.focus(), 50);
}

els.keyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = els.keyInput.value.trim();
  if (key.length < 8) return showKeyError('that does not look like a room key');

  const btn = els.keyForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  els.keyError.hidden = true;

  const result = await verifyKey(key);
  btn.disabled = false;

  if (!result.ok) return showKeyError(result.error);

  els.keyModal.hidden = true;
  els.keyInput.value = '';
  startChat();
});

function showKeyError(msg) {
  els.keyError.textContent = msg;
  els.keyError.hidden = false;
}

/* ---------------- chat SSE ---------------- */

function connectChat() {
  if (state.chatEs) state.chatEs.close();
  const es = new EventSource(`/events/chat?key=${encodeURIComponent(state.key)}`);
  state.chatEs = es;

  es.addEventListener('open', () => setStatus(els.chatStatus, 'live'));
  es.addEventListener('error', () => {
    setStatus(els.chatStatus, es.readyState === EventSource.CLOSED ? 'down' : 'connecting');
  });

  es.addEventListener('chat', (e) => addMessage(JSON.parse(e.data)));

  es.addEventListener('presence', (e) => setOnline(JSON.parse(e.data).online));

  // Ephemeral reaction from anyone in the room (no DB, no replay).
  es.addEventListener('reaction', (e) => {
    const data = JSON.parse(e.data);
    if (!data || !data.emoji) return;
    if (state.user && data.userId === state.user.id) return; // already shown locally
    floatReaction(data.emoji, false);
  });

  // Server force-closed the room (window ended / idle timeout).
  es.addEventListener('room', (e) => {
    const data = JSON.parse(e.data);
    if (data && data.closed) roomClosed(data.reason);
  });

  // Terminal deny: bad/expired key, room gone, or window not open yet.
  es.addEventListener('denied', (e) => {
    let data = {};
    try {
      data = JSON.parse(e.data);
    } catch {
      /* ignore */
    }
    roomUnavailable(denyMessage(data));
  });

  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data);
    setOnline(data.online);
    if (data.room) {
      state.room = data.room;
      renderRoom();
    }
    if (data.me && !state.user) setUser({ name: data.me });
    setStatus(els.chatStatus, 'live');
  });
}

function setOnline(n) {
  els.online.textContent = String(n ?? 0);
}

function denyMessage(data) {
  switch (data.error) {
    case 'room_not_exist':
      return 'This room is closed and can no longer be reopened.';
    case 'not_yet':
      return 'This room has not opened yet. Try again later.';
    case 'expired':
      return 'This key has expired.';
    case 'bad_format':
    case 'bad_signature':
      return 'That key is not valid.';
    default:
      return data.message || 'This room is no longer available.';
  }
}

// Drop the stream and send the user back to the key gate (key prefilled) so
// they can reopen the room if their key still allows it.
function roomUnavailable(message) {
  if (state.chatEs) {
    state.chatEs.close();
    state.chatEs = null;
  }
  const key = state.key;
  state.room = null;
  state.seen.clear();
  els.msgs.replaceChildren();
  els.floatLayer.replaceChildren();
  els.roomName.textContent = 'Room closed';
  els.roomId.textContent = '';
  els.online.textContent = '0';
  setStatus(els.chatStatus, 'down');
  els.keyInput.value = key || '';
  openKeyModal();
  showKeyError(message);
}

function roomClosed(reason) {
  if (reason === 'window') return roomUnavailable('This room closed at the end of its scheduled window.');
  return roomUnavailable('This room closed after being idle. Submit the key again to reopen it.');
}

function addMessage(m) {
  if (!m || state.seen.has(m.seq)) return;
  state.seen.add(m.seq);

  const li = document.createElement('li');
  li.className = 'msg';
  li.dataset.seq = m.seq;
  li.dataset.uid = m.userId;
  if (state.user && m.userId === state.user.id) li.classList.add('mine');

  const seq = document.createElement('span');
  seq.className = 'msg-seq';
  seq.textContent = String(m.seq).padStart(4, '0');

  const main = document.createElement('div');
  main.className = 'msg-main';

  const name = document.createElement('span');
  name.className = 'msg-name h' + hashName(m.name);
  name.textContent = m.name;

  const body = document.createElement('span');
  if (m.kind === 'sticker') {
    li.classList.add('sticker-msg');
    body.className = 'msg-body sticker';
    const img = document.createElement('img');
    img.className = 'sticker-img';
    img.src = `${STICKER_BASE}/${encodeURIComponent(m.body)}.svg`;
    img.alt = m.body;
    img.draggable = false;
    body.append(img);
  } else {
    body.className = 'msg-body';
    body.textContent = m.body;
  }

  main.append(name, body);

  const time = document.createElement('time');
  time.className = 'msg-time';
  time.textContent = clockTime(m.ts).slice(0, 5);
  time.dateTime = new Date(m.ts).toISOString();

  li.append(seq, main, time);
  els.msgs.append(li);

  while (els.msgs.childElementCount > MAX_NODES) {
    const first = els.msgs.firstElementChild;
    state.seen.delete(Number(first.dataset.seq));
    first.remove();
  }

  onNewContent();
}

function hashName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 8;
}

/* ---------------- scroll ---------------- */

let scrollRaf = 0;

function onNewContent() {
  if (distanceFromBottom() < 90) state.frozen = false;

  if (state.frozen) {
    state.unread += 1;
    els.jump.hidden = false;
    els.jump.textContent = `${state.unread} new message${state.unread === 1 ? '' : 's'}`;
    return;
  }

  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    els.body.scrollTop = els.body.scrollHeight;
  });
}

function distanceFromBottom() {
  return els.body.scrollHeight - els.body.scrollTop - els.body.clientHeight;
}

els.body.addEventListener('scroll', () => {
  if (distanceFromBottom() < 40) {
    state.frozen = false;
    state.unread = 0;
    els.jump.hidden = true;
  } else {
    state.frozen = true;
  }
}, { passive: true });

els.jump.addEventListener('click', () => {
  state.frozen = false;
  state.unread = 0;
  els.jump.hidden = true;
  els.body.scrollTo({ top: els.body.scrollHeight, behavior: 'smooth' });
});

/* ---------------- composer ---------------- */

els.input.addEventListener('input', () => {
  const len = els.input.value.length;
  els.count.textContent = len ? `${len}/${els.input.maxLength}` : '';
  els.count.classList.toggle('warn', len > 450);
});

els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!state.key) return openKeyModal();

  if (!state.user) {
    openNameModal();
    return;
  }

  const body = els.input.value.trim();
  if (!body || performance.now() < state.cooldownUntil) return;

  els.send.disabled = true;
  const sent = els.input.value;
  els.input.value = '';
  els.input.dispatchEvent(new Event('input'));
  state.cooldownUntil = performance.now() + RATE_MS;

  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.key, body }),
      credentials: 'include',
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      els.input.value = sent;
      els.input.dispatchEvent(new Event('input'));
      showComposerError(data.error || 'could not send');
      return;
    }

    if (data.message) addMessage(data.message);
    els.input.focus();
  } catch {
    els.input.value = sent;
    els.input.dispatchEvent(new Event('input'));
    showComposerError('network error');
  } finally {
    setTimeout(() => {
      els.send.disabled = false;
      if (state.user) els.input.focus();
    }, RATE_MS);
  }
});

async function sendSticker(id) {
  if (!id) return;
  if (!state.key) return openKeyModal();
  if (!state.user) return openNameModal();
  if (performance.now() < state.cooldownUntil) return;

  state.cooldownUntil = performance.now() + RATE_MS;
  toggleStickerPanel(false);

  try {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: state.key, kind: 'sticker', body: id }),
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showComposerError(data.error || 'could not send');
    if (data.message) addMessage(data.message);
  } catch {
    showComposerError('network error');
  }
}

let errTimer = 0;
function showComposerError(text) {
  clearTimeout(errTimer);
  els.count.textContent = text;
  els.count.classList.add('warn');
  errTimer = setTimeout(() => {
    els.count.textContent = '';
    els.count.classList.remove('warn');
  }, 2200);
}

/* ---------------- auth ---------------- */

function setUser(user) {
  state.user = user;
  els.input.disabled = !user;
  els.send.disabled = !user;
  els.stickerToggle.disabled = !user;
  if (!user) toggleStickerPanel(false);
  els.changeName.hidden = !user;
  els.input.placeholder = user ? 'Say something...' : 'Set a name to chat';
  if (user) {
    els.input.focus();
    for (const li of els.msgs.children) {
      li.classList.toggle('mine', li.dataset.uid === user.id);
    }
  }
}

function openNameModal() {
  els.nameError.hidden = true;
  els.nameModal.hidden = false;
  setTimeout(() => els.nameInput.focus(), 50);
}

els.nameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = els.nameInput.value.trim();
  if (name.length < 2) return showNameError('at least 2 characters');

  const btn = els.nameForm.querySelector('button[type="submit"]');
  btn.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      credentials: 'include',
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) return showNameError(data.error || 'could not join');

    setUser(data.user);
    els.nameModal.hidden = true;
    els.nameInput.value = '';
  } catch {
    showNameError('network error, try again');
  } finally {
    btn.disabled = false;
  }
});

function showNameError(msg) {
  els.nameError.textContent = msg;
  els.nameError.hidden = false;
}

els.changeName.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
  setUser(null);
  openNameModal();
});

els.leaveRoom.addEventListener('click', () => {
  if (state.chatEs) {
    state.chatEs.close();
    state.chatEs = null;
  }
  toggleStickerPanel(false);
  saveKey('');
  state.key = null;
  state.room = null;
  state.seen.clear();
  els.msgs.replaceChildren();
  els.floatLayer.replaceChildren();
  els.roomName.textContent = 'Waiting for a room key…';
  els.roomId.textContent = '';
  els.leaveRoom.hidden = true;
  els.online.textContent = '0';
  setStatus(els.chatStatus, 'connecting');
  setUser(null);
  openKeyModal();
});

/* ---------------- clock ---------------- */

function clockTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/* ---------------- boot ---------------- */

async function startChat() {
  connectChat();
  try {
    const res = await fetch('/api/me', { credentials: 'include' });
    const data = await res.json();
    if (data.user) {
      setUser(data.user);
    } else {
      setUser(null);
      openNameModal();
    }
  } catch {
    openNameModal();
  }
}

(async function boot() {
  connectFeed();
  loadStickers();
  loadReactions();

  const urlKey = new URLSearchParams(location.search).get('key');
  const key = urlKey || storedKey();

  if (key) {
    const result = await verifyKey(key);
    if (result.ok) {
      els.keyModal.hidden = true;
      return startChat();
    }
    saveKey('');
    showKeyError(result.error);
  }

  setUser(null);
  openKeyModal();
})();
