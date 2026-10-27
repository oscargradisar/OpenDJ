// Beat sync: one shared clock every synced deck locks to (like Mixxx's internal clock or
// Ableton Link). Joining sets the deck's tempo from the clock and lines its beats up once;
// after that a 25 ms loop keeps the phase with tiny speed trims (at most 0.4%, about 7 cents),
// so decks never drift and a stopping deck never drags the others. Tempo moves on any
// member move the clock, and the rest follow.

import { LOOKAHEAD } from './engine.js';

const TICK_MS = 25;
const MAX_TRIM = 0.004; // ±0.4% speed: inaudible
const SETTLE_SEC = 1; // phase error time constant
const RESEEK_SEC = 0.015; // further off than this (heard time): jump back in place instead of trimming

const wrap = (x, q = 1) => x - q * Math.round(x / q); // into [-q/2, q/2]

export class SyncGroup {
  constructor(mixer, { onChange = () => {} } = {}) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.onChange = onChange;
    this.members = new Map(); // deck -> { k, offset, forcedK, reseeks: [] }
    this.bpm = 0; // clock beats per minute
    this.t0 = 0; // context time ...
    this.b0 = 0; // ... at which the clock read this beat
    this.parked = true; // no member playing: the next one to start re-anchors the clock
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  has(deck) {
    return this.members.has(deck);
  }

  clockBeat(t) {
    return this.b0 + ((t - this.t0) * this.bpm) / 60;
  }

  /** Where deck should be (in its own beats) at time t. */
  target(deck, t) {
    const m = this.members.get(deck);
    return m.k * this.clockBeat(t) + m.offset;
  }

  /** Re-anchor the clock so `deck` is exactly on it at time t (tempo unchanged). */
  anchorOn(deck, t) {
    const m = this.members.get(deck);
    this.b0 = (deck.deckBeat(deck.positionAt(t)) - m.offset) / m.k;
    this.t0 = t;
    this.parked = false;
  }

  /** The ½ / 1 / 2 multiplier that keeps a deck nearest its own tempo (Mixxx's √2 rule), or the forced one. */
  pickK(deck, forcedK) {
    if (forcedK) return forcedK;
    const r = deck.bpm / this.bpm;
    return r > Math.SQRT2 ? 2 : r < Math.SQRT1_2 ? 0.5 : 1;
  }

  /**
   * Link `deck` with `partner`. Returns { ok, reason }. Nothing about the tracks
   * is saved. A new group takes its tempo and phase from whichever of the two is playing
   * (the partner if both or neither), so pressing Sync never yanks the deck on air.
   */
  join(deck, partner, { forcedK = null } = {}) {
    if (!deck.bpm || !deck.bars) return { ok: false, reason: `Deck ${deck.name} has no beat grid yet.` };
    const when = this.ctx.currentTime + LOOKAHEAD;
    if (!this.members.size) {
      if (!partner?.bpm || !partner.bars) return { ok: false, reason: 'Load a track with a beat grid on another deck to sync to.' };
      const anchor = deck.playing && !partner.playing ? deck : partner;
      const other = anchor === deck ? partner : deck;
      this.bpm = anchor.bpm * anchor.rate;
      this.members.set(anchor, { k: 1, offset: 0, forcedK: null, reseeks: [] });
      this.anchorOn(anchor, when);
      this.parked = !anchor.playing;
      const res = this.add(other, when, other === deck ? forcedK : null);
      if (!res.ok) this.members.clear();
      this.onChange();
      return res;
    }
    if (!this.members.has(partner) && partner?.bars) {
      // Joining a group through a deck that isn't in it yet: bring the partner in first.
      const r = this.add(partner, when, null);
      if (!r.ok) return r;
    }
    const res = this.add(deck, when, forcedK);
    this.onChange();
    return res;
  }

  add(deck, when, forcedK) {
    const k = this.pickK(deck, forcedK);
    const rate = (this.bpm * k) / deck.bpm;
    this.members.set(deck, { k, offset: 0, forcedK, reseeks: [], tempoOnly: false });
    deck.setRate(rate, { silent: true });
    this.place(deck, when);
    if (this.parked && deck.playing) this.anchorOn(deck, when);
    return { ok: true, k };
  }

  leave(deck) {
    if (!this.members.delete(deck)) return;
    if (this.members.size < 2) this.members.clear(); // a lone deck isn't synced to anything
    this.onChange();
  }

  clear() {
    this.members.clear();
    this.onChange();
  }

  /**
   * Line `deck` up with the clock at time `when`. Moves by beat phase only (at most half a
   * beat) unless the deck can't be heard, in which case it lines up whole bars too.
   */
  place(deck, when) {
    const m = this.members.get(deck);
    const quiet = !deck.playing || deck.fader.gain.value * deck.xfade.gain.value < 0.1;
    const anchorBars = [...this.members.keys()].find((d) => d !== deck)?.bars;
    const byBar = quiet && m.k === 1 && anchorBars && deck.bars.beatsPerBar === anchorBars.beatsPerBar;
    const q = byBar ? deck.bars.beatsPerBar : 1;
    const pos = deck.positionAt(when);
    const d = wrap(deck.deckBeat(pos) - this.target(deck, when), q); // deck beats it's ahead
    if (Math.abs(d * deck.beatPeriod) < 0.0005) return;
    let to = pos - d * deck.beatPeriod;
    while (to < 0) to += q * deck.beatPeriod; // before 0:00 would clamp: go forward whole units
    if (deck.playing) deck.jumpTo(to, when);
    else deck.pausedPos = to;
  }

  /** A user tempo move on a member: the clock takes that tempo and everyone else follows. */
  setTempoFrom(deck) {
    const m = this.members.get(deck);
    if (!m) return [];
    const now = this.ctx.currentTime;
    const b = this.clockBeat(now);
    this.bpm = (deck.bpm * deck.rate) / m.k;
    this.t0 = now;
    this.b0 = b;
    const moved = [];
    for (const [d, dm] of this.members) {
      if (d === deck) continue;
      d.setRate((this.bpm * dm.k) / d.bpm, { silent: true });
      moved.push({ deck: d });
    }
    if (this.members.size < 2) this.members.clear();
    this.onChange();
    return moved;
  }

  /** Where to land a jump to `pos` on a synced deck so it keeps its beat phase. */
  quantizeSeek(deck, pos) {
    if (!this.members.has(deck) || !deck.bpm) return pos;
    const from = deck.deckBeat(deck.position);
    const shift = wrap(from - deck.deckBeat(pos)) * deck.beatPeriod;
    const to = pos + shift;
    return to < 0 ? to + deck.beatPeriod : to;
  }

  /**
   * A synced deck is about to start: start it at its cue position on the next instant its
   * phase matches the clock (at most one beat away; one bar when it's cued on beat 1), so a deck cued
   * on a beat comes in on the beat, and one cued on beat 1 comes in on the bar.
   * Returns { at, when } for Deck.play, or null when there's no running clock to follow.
   */
  startPlan(deck) {
    const m = this.members.get(deck);
    if (!m || !deck.bpm) return null;
    const when = this.ctx.currentTime + LOOKAHEAD;
    const others = [...this.members.keys()].some((d) => d !== deck && d.playing);
    if (this.parked || !others) {
      // Nobody else is playing: this deck becomes the clock's reference.
      this.anchorOn(deck, when);
      return { at: deck.pausedPos, when };
    }
    const at = deck.pausedPos;
    // Cued on its beat 1 (same meter, same tempo level): come in on the clock's next bar, not just its next beat.
    const bpb = deck.bars.beatsPerBar;
    const anchorBars = [...this.members.keys()].find((d) => d !== deck && d.playing)?.bars;
    const onDownbeat = Math.abs(wrap(deck.deckBeat(at), bpb)) < 0.125;
    const q = m.k === 1 && anchorBars?.beatsPerBar === bpb && onDownbeat ? bpb : 1;
    const d = deck.deckBeat(at) - this.target(deck, when); // deck beats it's ahead of the clock
    const wait = ((d % q) + q) % q; // beats to wait until the clock reaches the deck's phase
    const beatSec = deck.beatPeriod / deck.speed; // real seconds per deck beat
    if ((q - wait) * beatSec < RESEEK_SEC) return { at: at + (q - wait) * deck.beatPeriod, when }; // a hair behind: skip ahead
    return { at, when: when + wait * beatSec };
  }

  /** After a nudge: keep the offset the user nudged to (Mixxx does the same). */
  keepOffset(deck) {
    const m = this.members.get(deck);
    if (!m || !deck.playing) return;
    const t = this.ctx.currentTime;
    m.offset = wrap(deck.deckBeat(deck.positionAt(t)) - m.k * this.clockBeat(t));
  }

  /** Signed phase error in heard milliseconds (+ = ahead), for the UI. */
  errorMs(deck) {
    if (!this.members.has(deck) || !deck.playing || this.parked) return null;
    const t = this.ctx.currentTime;
    return (wrap(deck.deckBeat(deck.positionAt(t)) - this.target(deck, t)) * deck.beatPeriod * 1000) / deck.speed;
  }

  tick() {
    if (!this.members.size) return;
    const playing = [...this.members.keys()].filter((d) => d.playing);
    if (!playing.length) {
      this.parked = true;
      return;
    }
    if (this.parked) this.anchorOn(playing[0], this.ctx.currentTime);
    const now = this.ctx.currentTime;
    for (const d of playing) {
      const m = this.members.get(d);
      if (m.tempoOnly || d.scratching || d.bendFactor !== 1 || d.busyUntil > now) continue;
      const w = now + LOOKAHEAD;
      const eBeats = wrap(d.deckBeat(d.positionAt(w)) - this.target(d, w));
      const eSec = (eBeats * d.beatPeriod) / d.speed; // heard seconds ahead of the clock
      if (Math.abs(eSec) < 0.001) continue;
      if (Math.abs(eSec) <= RESEEK_SEC) {
        const eps = Math.max(-MAX_TRIM, Math.min(MAX_TRIM, -eSec / SETTLE_SEC));
        d.trimPulse(eps, w, TICK_MS / 1000);
        continue;
      }
      // Far off (a scratch, a slipped jump): put it back in place, faded.
      m.reseeks = m.reseeks.filter((t) => now - t < 10);
      m.reseeks.push(now);
      if (m.reseeks.length > 3) {
        m.tempoOnly = true; // can't hold phase (a grid that doesn't fit the music): keep the tempo, stop fighting
        this.onChange();
        continue;
      }
      d.jumpTo(d.positionAt(w) - eBeats * d.beatPeriod, w);
    }
  }
}
