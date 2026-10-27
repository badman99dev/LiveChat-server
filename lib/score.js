const { EventEmitter } = require('node:events');

class ScoreFeed extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.timer = null;
    this.state = {
      matchId: 'demo-1',
      league: 'DEMO LEAGUE · T20',
      status: 'LIVE',
      home: { name: 'IND', score: '142/3', overs: '16.2' },
      away: { name: 'AUS', score: '—', overs: '' },
      note: 'IND batting · 22 needed off 22',
      version: 0,
      updatedAt: Date.now(),
    };
  }

  get() {
    return this.state;
  }

  update(patch) {
    this.state = {
      ...this.state,
      ...patch,
      home: { ...this.state.home, ...(patch.home || {}) },
      away: { ...this.state.away, ...(patch.away || {}) },
      version: this.state.version + 1,
      updatedAt: Date.now(),
    };
    this.emit('update', this.state);
    return this.state;
  }

  playBall() {
    const [runStr] = this.state.home.score.split('/');
    const [ovStr] = this.state.home.overs.split('.');
    let runs = Number(runStr) || 0;
    let wickets = Number(this.state.home.score.split('/')[1]) || 0;
    let overs = Number(ovStr) || 0;
    let ball = Number(this.state.home.overs.split('.')[1] || 0);

    const r = Math.random();
    let scored = 0;
    let note = 'dot ball';
    if (r > 0.93 && wickets < 9) {
      wickets += 1;
      note = 'WICKET!';
    } else {
      scored = [0, 1, 1, 2, 4, 6][Math.floor(Math.random() * 6)];
      runs += scored;
      note = scored === 6 ? 'SIX!' : scored === 4 ? 'FOUR!' : `${scored} run${scored === 1 ? '' : 's'}`;
    }

    ball += 1;
    if (ball === 6) {
      ball = 0;
      overs += 1;
    }
    if (overs === 20 || wickets === 10) {
      return this.update({ status: 'ENDED', note: 'Innings over' });
    }

    return this.update({
      home: { score: `${runs}/${wickets}`, overs: `${overs}.${ball}` },
      note,
    });
  }

  startMock(ms = 7_000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.playBall(), ms);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { ScoreFeed };
