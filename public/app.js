const $ = (id) => document.getElementById(id);

const CHANNEL = 'main';
const MAX_NODES = 350;
const RATE_MS = 1100;

const state = {
  user: null,
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
  modal: $('nameModal'),
  nameForm: $('nameForm'),
  nameInput: $('nameInput'),
  nameError: $('nameError'),
  changeName: $('changeName'),
  chatStatus: $('chatStatus'),
  feedStatus: $('feedStatus'),
  feedNote: $('feedNote'),
};

function setStatus(el, stateName) {
  el.dataset.state = stateName;
}

/* ---------------- second SSE stream (your existing feed) ---------------- */
/* Chat ke saath ye doosra EventSource chalta hai — same HTTP/2 connection.
   Yahan bas "alive hai" dikha rahe hain; apna score/odds data yahin render karo. */

function connectFeed() {
  const es = new EventSource('/events/score');

  es.addEventListener('open', () => {
    state.feedDown = false;
    setStatus(els.feedStatus, 'live');
  });

  es.addEventListener('error', () => {
    state.feedDown = true;
    setStatus(els.feedStatus, 'connecting');
    els.feedNote.textContent = 'feed reconnecting…';
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

/* ---------------- chat SSE ---------------- */

function connectChat() {
  const es = new EventSource(`/events/chat?channel=${CHANNEL}`);

  es.addEventListener('open', () => setStatus(els.chatStatus, 'live'));
  es.addEventListener('error', () => {
    setStatus(els.chatStatus, es.readyState === EventSource.CLOSED ? 'down' : 'connecting');
  });

  es.addEventListener('chat', (e) => addMessage(JSON.parse(e.data)));

  es.addEventListener('presence', (e) => setOnline(JSON.parse(e.data).online));

  es.addEventListener('hello', (e) => {
    const data = JSON.parse(e.data);
    setOnline(data.online);
    setStatus(els.chatStatus, 'live');
  });
}

function setOnline(n) {
  els.online.textContent = String(n ?? 0);
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
  body.className = 'msg-body';
  body.textContent = m.body;

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
      body: JSON.stringify({ channel: CHANNEL, body }),
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
  els.changeName.hidden = !user;
  els.input.placeholder = user ? 'Say something…' : 'Set a name to chat';
  if (user) {
    els.input.focus();
    for (const li of els.msgs.children) {
      li.classList.toggle('mine', li.dataset.uid === user.id);
    }
  }
}

function openNameModal() {
  els.nameError.hidden = true;
  els.modal.hidden = false;
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
    els.modal.hidden = true;
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

/* ---------------- clock ---------------- */

function clockTime(ts) {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/* ---------------- boot ---------------- */

(async function boot() {
  connectFeed();
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
})();
