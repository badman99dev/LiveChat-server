const HEARTBEAT_MS = 20_000;

function frame({ event, id, data }) {
  let out = '';
  if (id !== undefined && id !== null) out += `id: ${id}\n`;
  if (event) out += `event: ${event}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of payload.split('\n')) out += `data: ${line}\n`;
  return out + '\n';
}

class Hub {
  constructor() {
    this.rooms = new Map();
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.timer.unref();
  }

  room(key) {
    let set = this.rooms.get(key);
    if (!set) {
      set = new Set();
      this.rooms.set(key, set);
    }
    return set;
  }

  add(key, res) {
    this.room(key).add(res);
    return this.count(key);
  }

  remove(key, res) {
    const set = this.rooms.get(key);
    if (!set) return 0;
    set.delete(res);
    if (set.size === 0) this.rooms.delete(key);
    return set.size;
  }

  count(key) {
    return this.rooms.get(key)?.size || 0;
  }

  emit(key, event, data, id) {
    const set = this.rooms.get(key);
    if (!set || set.size === 0) return;
    const chunk = frame({ event, id, data });
    for (const res of set) {
      try {
        res.write(chunk);
      } catch {
        set.delete(res);
      }
    }
  }

  heartbeat() {
    for (const set of this.rooms.values()) {
      for (const res of set) {
        try {
          res.write(': ping\n\n');
        } catch {
          set.delete(res);
        }
      }
    }
  }

  // Optionally push a final event, then end every stream in one room.
  closeRoom(key, event, data) {
    const set = this.rooms.get(key);
    if (!set) return 0;
    const n = set.size;
    const chunk = event ? frame({ event, data }) : '';
    for (const res of set) {
      try {
        if (chunk) res.write(chunk);
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.rooms.delete(key);
    return n;
  }

  closeAll() {
    clearInterval(this.timer);
    for (const set of this.rooms.values()) {
      for (const res of set) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
    this.rooms.clear();
  }
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true, 30_000);
}

module.exports = { Hub, openStream, frame, HEARTBEAT_MS };
