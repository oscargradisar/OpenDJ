// Unit tests for the sync clock (src/renderer/sync.js) with simulated decks and a
// controllable clock. Run: node test/sync.test.mjs
import { SyncGroup } from '../src/renderer/sync.js';

let fails = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ': ' + info : ''}`);
  if (!ok) fails++;
};
const wrap = (x) => x - Math.round(x);

// A deck with the engine's position bookkeeping (startPos / startTime / speed, scheduled starts).
class FakeDeck {
  constructor(ctx, name, bpm, downbeat = 0, beatsPerBar = 4) {
    Object.assign(this, { ctx, name, rate: 1, bendFactor: 1, busyUntil: 0, playing: false, pausedPos: 0, startPos: 0, startTime: 0, scratching: false });
    this.track = { bpm, beatOffset: downbeat, downbeat, beatsPerBar };
    this.fader = { gain: { value: 1 } };
    this.xfade = { gain: { value: 1 } };
    this.trims = [];
  }
  get bpm() { return this.track.bpm; }
  get bars() { return { beatsPerBar: this.track.beatsPerBar, downbeat: this.track.downbeat }; }
  get speed() { return this.rate * this.bendFactor; }
  get beatPeriod() { return 60 / this.bpm; }
  get duration() { return 600; }
  deckBeat(pos) { return (pos - this.track.downbeat) / this.beatPeriod; }
  positionAt(t) {
    if (!this.playing) return this.pausedPos;
    if (t < this.startTime) return this.startPos;
    return this.startPos + (t - this.startTime) * this.speed;
  }
  get position() { return this.positionAt(this.ctx.currentTime); }
  setRate(rate) {
    if (this.playing && this.ctx.currentTime >= this.startTime) {
      this.startPos = this.position;
      this.startTime = this.ctx.currentTime;
    }
    this.rate = rate;
  }
  play({ at = this.pausedPos, when = this.ctx.currentTime + 0.025 } = {}) {
    this.playing = true;
    this.startPos = at;
    this.startTime = when;
    this.busyUntil = when;
  }
  pause() { this.pausedPos = this.position; this.playing = false; }
  jumpTo(pos, when) { this.startPos = pos; this.startTime = when; this.busyUntil = when; }
  trimPulse(eps, when, dur) { this.startPos += eps * this.speed * dur; this.trims.push(eps); }
}

const ctx = { currentTime: 10 };
const mixer = { ctx };
const mk = () => {
  const g = new SyncGroup(mixer);
  clearInterval(g.timer); // ticks are driven by hand
  return g;
};
const step = (g, sec) => {
  for (let t = 0; t < sec; t += 0.025) {
    ctx.currentTime += 0.025;
    g.tick();
  }
};
const errBeats = (a, b) => wrap(a.deckBeat(a.position) - b.deckBeat(b.position)); // same-tempo decks

// 1. Multiplier choice (√2 rule) and rate; even far-apart tempos (174 vs 128) sync at the nearest level.
{
  const g = mk();
  const lead = new FakeDeck(ctx, 'A', 128);
  lead.play();
  ctx.currentTime += 1;
  for (const [bpm, k] of [[124, 1], [64, 0.5], [174, 1], [250, 2]]) {
    const d = new FakeDeck(ctx, 'B', bpm);
    g.members.clear();
    const res = g.join(d, lead);
    check(`k for ${bpm} vs 128`, res.ok && res.k === k && Math.abs(d.rate - (128 * k) / bpm) < 1e-9, `k=${res.k} rate=${d.rate.toFixed(4)}`);
  }
}

// 2. Sync while playing: lines up beats within ½ beat, keeps the leader untouched.
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128, 0.123);
  const b = new FakeDeck(ctx, 'B', 126, 0.05);
  a.play({ at: 30 });
  b.play({ at: 61.3 });
  ctx.currentTime += 0.5;
  const aPos = a.position;
  const res = g.join(b, a);
  ctx.currentTime += 0.1;
  check('join ok', res.ok);
  check('leader keeps its tempo and place', a.rate === 1 && Math.abs(a.position - (aPos + 0.1)) < 1e-9);
  const tb = (x) => x.deckBeat(x.position);
  check('beats line up after join', Math.abs(wrap(tb(b) - tb(a))) < 1e-6, `${wrap(tb(b) - tb(a)).toFixed(6)} beats`);
  step(g, 30);
  check('still in phase after 30 s', Math.abs(wrap(tb(b) - tb(a))) < 1e-6);
}

// 3. Pressing Sync on the deck on air (partner paused) moves the paused one, not the playing one.
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 125);
  a.play({ at: 20 });
  b.pausedPos = 40.17;
  ctx.currentTime += 0.3;
  const before = a.position;
  g.join(a, b);
  check('on-air deck not moved or retimed', a.rate === 1 && Math.abs(a.position - before) < 1e-9);
  check('paused partner took the tempo', Math.abs(b.rate - 128 / 125) < 1e-9);
}

// 4. Tempo move on a member: clock and others follow, phase continuous.
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 120);
  a.play({ at: 10 });
  b.play({ at: 50.2 });
  ctx.currentTime += 0.2;
  g.join(b, a);
  step(g, 2);
  a.setRate(1.05);
  g.setTempoFrom(a);
  check('follower follows tempo', Math.abs(b.effectiveBpm ?? b.bpm * b.rate - 128 * 1.05) < 1e-6, (b.bpm * b.rate).toFixed(3));
  step(g, 10);
  const e = wrap(b.deckBeat(b.position) - a.deckBeat(a.position));
  check('in phase after a tempo move', Math.abs(e) < 1e-4, `${(e * 1000).toFixed(3)} mbeat`);
}

// 5. Phase lock pulls a 10 ms slip back smoothly (no overshoot, no jump).
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 128);
  a.play({ at: 10 });
  b.play({ at: 10 });
  ctx.currentTime += 0.1;
  g.join(b, a);
  step(g, 1);
  b.startPos += 0.010; // slip 10 ms ahead
  let worst = 0;
  let overshoot = 0;
  for (let i = 0; i < 200; i++) {
    step(g, 0.025);
    const e = errBeats(b, a) * b.beatPeriod;
    worst = Math.max(worst, Math.abs(e));
    if (e < -0.0011) overshoot = Math.min(overshoot, e);
  }
  const end = errBeats(b, a) * b.beatPeriod;
  check('10 ms slip corrected within 5 s', Math.abs(end) < 0.0011, `${(end * 1000).toFixed(2)} ms left`);
  check('no overshoot', overshoot === 0, `${(overshoot * 1000).toFixed(2)} ms`);
  check('trims stay inaudible (≤0.4%)', b.trims.every((x) => Math.abs(x) <= 0.004 + 1e-12));
}

// 6. Quantized seek keeps the beat phase.
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 128);
  a.play({ at: 10 });
  b.play({ at: 10 });
  ctx.currentTime += 0.1;
  g.join(b, a);
  const to = g.quantizeSeek(b, 95.31);
  const ph = (p) => wrap(b.deckBeat(p));
  check('quantizeSeek keeps phase', Math.abs(wrap(ph(to) - ph(b.position))) < 1e-9 && Math.abs(to - 95.31) <= b.beatPeriod / 2 + 1e-9);
}

// 7. Starting a cued (paused) synced deck: it comes in on the clock's beat, at its cue point.
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 128, 0.2);
  a.play({ at: 10.3 });
  b.pausedPos = 0.2 + 32 * (60 / 128); // cued on a beat
  ctx.currentTime += 0.1;
  g.join(b, a);
  b.pausedPos = 0.2 + 32 * (60 / 128); // re-cue after join moved it
  ctx.currentTime += 3.7;
  const plan = g.startPlan(b);
  check('starts at its cue point', Math.abs(plan.at - b.pausedPos) < 1e-9);
  check('cued on beat 1: waits at most one bar', plan.when - ctx.currentTime <= (4 * 60) / 128 + 0.03);
  b.play(plan);
  ctx.currentTime = plan.when + 0.5;
  const bar = (x) => wrap(x.deckBeat(x.position) / 4);
  check('lands on the bar', Math.abs(bar(b) - bar(a)) < 1e-6, (bar(b) - bar(a)).toFixed(6));
  // Cued mid-bar on a beat: waits at most one beat.
  b.pause();
  b.pausedPos = 0.2 + 33 * (60 / 128);
  const p2 = g.startPlan(b);
  check('cued on beat 2: waits at most one beat', p2.when - ctx.currentTime <= 60 / 128 + 0.03);
}

// 8. Half tempo: a 64 BPM deck (k = ½) has its beat 1 lands on the clock's beat 1 (not the snare).
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 64);
  a.play({ at: 0 });
  ctx.currentTime += 0.05;
  b.pausedPos = 7.3;
  g.join(b, a);
  b.play(g.startPlan(b));
  ctx.currentTime += 2;
  const bb = b.deckBeat(b.position);
  const ab = a.deckBeat(a.position);
  check('half-tempo deck beats sit on every other clock beat', Math.abs(wrap(2 * bb - ab)) < 1e-6 || Math.abs(wrap(bb - ab / 2)) < 1e-6);
}

// 9. Nudge offset is kept.
{
  const g = mk();
  const a = new FakeDeck(ctx, 'A', 128);
  const b = new FakeDeck(ctx, 'B', 128);
  a.play({ at: 10 });
  b.play({ at: 10 });
  ctx.currentTime += 0.1;
  g.join(b, a);
  b.startPos += 0.02; // the user nudged 20 ms ahead
  g.keepOffset(b);
  step(g, 5);
  const e = errBeats(b, a) * b.beatPeriod;
  check('nudged offset kept', Math.abs(e - 0.02) < 0.0005, `${(e * 1000).toFixed(2)} ms`);
}

if (fails) {
  console.log(`${fails} sync test(s) failed`);
  process.exit(1);
}
console.log('all sync tests passed');
