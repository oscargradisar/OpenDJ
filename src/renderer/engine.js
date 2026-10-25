// Audio engine: two decks → mixer → master limiter → speakers.
// Built on the Web Audio API. Tempo changes are vinyl-style (pitch follows
// speed) unless key lock is on. Each deck runs through a deck-fx worklet
// (key shift / key lock / stems) before its EQ.

import SignalsmithStretch from './lib/SignalsmithStretch.mjs';

const dbToGain = (db) => Math.pow(10, db / 20);

export const XF_SIDE = { A: 'L', C: 'L', B: 'R', D: 'R' }; // crossfader side per deck

export const STEMS =['vocals', 'drums', 'instruments'];
export const AI_STEM_NAMES = ['drums', 'bass', 'other', 'vocals'];

// Starts, stops and jumps are scheduled this far ahead. Starting "now" can land a whole
// device period late (10 ms here) and stay that late; a little lookahead is always exact.
export const LOOKAHEAD = 0.025;

export class Mixer {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this.master = this.ctx.createGain();
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.master.connect(this.limiter);
    this.sfx = this.ctx.createGain(); // SFX pads, on top of the decks but under the limiter
    this.sfx.gain.value = 0.8;
    this.sfx.connect(this.limiter);
    this.limiter.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.ctx.destination);

    // Four decks always exist; the UI shows C and D in 4-deck mode. A and C sit on
    // the crossfader's left, B and D on its right.
    this.decks = {
      A: new Deck(this, 'A'),
      B: new Deck(this, 'B'),
      C: new Deck(this, 'C'),
      D: new Deck(this, 'D'),
    };
    this.crossfader = 0.5;
    this.crossfaderY = null; // set in 4-deck mode (XY pad)
    this.curve = 'smooth';
    this.applyCrossfader();

    // Key shift / stems processor. Decks play straight through until it's loaded.
    this.fxReady = this.ctx.audioWorklet
      .addModule(new URL('./deck-fx.worklet.js', import.meta.url))
      .then(() => {
        for (const d of Object.values(this.decks)) d.attachFx();
        return true;
      })
      .catch((err) => {
        console.error('Key shift / stems unavailable:', err);
        return false;
      });
    this.ctx.audioWorklet
      .addModule(new URL('./scratch.worklet.js', import.meta.url))
      .then(() => Object.values(this.decks).forEach((d) => d.attachScratch()))
      .catch((err) => console.error('Scratch sound unavailable:', err));
  }

  resume() {
    if (this.ctx.state !== 'running') return this.ctx.resume();
    return Promise.resolve();
  }

  setMasterVolume(v) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setCrossfader(x) {
    this.crossfader = Math.min(1, Math.max(0, x));
    this.applyCrossfader();
  }

  setCurve(curve) {
    this.curve = curve;
    this.applyCrossfader();
  }

  /** Vertical position of the 4-deck XY pad (0 = top: A and B, 1 = bottom: C and D); null = 2-deck crossfader. */
  setCrossfaderY(y) {
    this.crossfaderY = y == null ? null : Math.min(1, Math.max(0, y));
    this.applyCrossfader();
  }

  applyCrossfader() {
    // Per axis: [first side, second side] gains for position v (0..1).
    const curve = (v) =>
      this.curve === 'cut'
        ? [v > 0.95 ? (1 - v) / 0.05 : 1, v < 0.05 ? v / 0.05 : 1] // scratch-style: both full until the very edges
        : [Math.cos((v * Math.PI) / 2), Math.sin((v * Math.PI) / 2)]; // equal-power blend
    const [l, r] = curve(this.crossfader);
    const [top, bottom] = this.crossfaderY == null ? [1, 1] : curve(this.crossfaderY);
    const t = this.ctx.currentTime;
    for (const d of Object.values(this.decks)) {
      const x = XF_SIDE[d.name] === 'L' ? l : r;
      const y = d.name === 'A' || d.name === 'B' ? top : bottom; // A B on top, C D below
      d.xfade.gain.setTargetAtTime(x * y, t, 0.005);
    }
  }
}

export class Deck {
  constructor(mixer, name) {
    this.mixer = mixer;
    this.ctx = mixer.ctx;
    this.name = name;
    const ctx = this.ctx;

    this.trim = ctx.createGain();
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 3800;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 10;
    this.hp.Q.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 22000;
    this.lp.Q.value = 0.9;
    this.fader = ctx.createGain();
    this.xfade = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;

    this.trim.connect(this.low);
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.high.connect(this.hp);
    this.hp.connect(this.lp);
    this.fxChain = new FxChain(ctx, this);
    this.lp.connect(this.fxChain.input);
    this.fxChain.output.connect(this.fader);
    this.fader.connect(this.analyser);
    this.fader.connect(this.xfade);
    this.xfade.connect(mixer.master);

    this.buffer = null;
    this.track = null;
    this.source = null;
    this.playing = false;
    this.rate = 1; // tempo (slider / sync)
    this.bendFactor = 1; // nudge on top of the tempo while a nudge is held
    this.appliedSpeed = 1; // the speed the sources were last told
    this.busyUntil = 0; // context time until which a scheduled start / trim is still settling
    this.startPos = 0; // track seconds at startTime
    this.startTime = 0; // context time when playback (re)started
    this.pausedPos = 0;
    this.cuePoint = 0;
    this.loop = null; // { start, end, beats }
    this.listeners = new Set();

    this.fx = null; // deck-fx worklet node, once loaded
    this.keyShift = 0; // semitones (may be fractional after MATCH)
    this.keyLock = false; // tempo changes leave pitch alone
    this.stems = { vocals: 1, drums: 1, instruments: 1 };

    // AI stems (prototype): when a track's separated stems are loaded, the deck
    // plays them as four synced sources through these gains instead of the
    // mixed buffer, and the DSP stem masks are bypassed.
    this.bus = ctx.createGain(); // every source plays into this
    this.bus.connect(this.trim);
    this.aiStems = null; // { drums, bass, other, vocals } AudioBuffers
    this.aiGains = {};
    for (const n of AI_STEM_NAMES) {
      this.aiGains[n] = ctx.createGain();
      this.aiGains[n].connect(this.bus);
    }
    this.sources = []; // all running sources (1, or 4 with AI stems)
  }

  /** Where the sources play into (then through the fx node when loaded, then the EQ). */
  get input() {
    return this.bus;
  }

  attachFx() {
    if (this.fx) return;
    this.fx = new AudioWorkletNode(this.ctx, 'deck-fx', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { pitch: this.pitchFactor, stems: this.stems },
    });
    this.bus.disconnect();
    this.bus.connect(this.fx);
    this.fx.connect(this.stretchOn ? this.stretch : this.trim);
    this.emit('fx');
  }

  attachScratch() {
    this.scratchNode = new AudioWorkletNode(this.ctx, 'scratch', { numberOfInputs: 0, outputChannelCount: [2] });
    this.scratchNode.connect(this.stretchOn ? this.trim : this.bus); // through key shift, EQ and faders like normal playback
    if (this.buffer) this.sendScratchBuffer();
  }

  sendScratchBuffer() {
    // shortcut: copies the decoded track into the worklet (2× its RAM), use a SharedArrayBuffer if memory gets tight.
    const channels = [];
    for (let c = 0; c < this.buffer.numberOfChannels; c++) channels.push(this.buffer.getChannelData(c).slice());
    this.scratchNode.port.postMessage({ type: 'load', channels }, channels.map((a) => a.buffer));
  }

  /** Hand on the record: playback stops, the scratch voice follows scratchTo(). Returns whether it was playing. */
  scratchStart() {
    const wasPlaying = this.playing;
    this.pause();
    this.scratching = true;
    this.scratchNode?.port.postMessage({ type: 'start', pos: this.pausedPos });
    return wasPlaying;
  }

  scratchTo(t) {
    if (!this.buffer) return;
    this.pausedPos = Math.max(0, Math.min(t, this.duration));
    this.scratchNode?.port.postMessage({ type: 'target', pos: this.pausedPos });
  }

  scratchEnd(resume) {
    if (!this.scratching) return;
    this.scratching = false;
    this.scratchNode?.port.postMessage({ type: 'stop' });
    if (this.loop && (this.pausedPos < this.loop.start || this.pausedPos >= this.loop.end)) this.loop = null;
    if (resume) this.play();
    else this.emit('seek');
  }

  /** Bar grid: { beatsPerBar, downbeat } with fallbacks for tracks analysed before bars existed. */
  get bars() {
    const t = this.track;
    if (!t?.bpm || t.beatOffset == null) return null;
    return { beatsPerBar: t.beatsPerBar || 4, downbeat: t.downbeat ?? t.beatOffset };
  }

  /** Pitch change the fx node applies on top of playback speed. */
  get pitchFactor() {
    return 2 ** (this.keyShift / 12) / (this.keyLock ? this.rate : 1);
  }

  /** How far the heard key is from the track's own key, in semitones. */
  get keyOffset() {
    return this.keyShift + (this.keyLock ? 0 : 12 * Math.log2(this.rate));
  }

  sendFx() {
    // With AI stems the stem levels are applied by aiGains, so the DSP masks stay off.
    const stems = this.aiStems ? { vocals: 1, drums: 1, instruments: 1 } : this.stems;
    // Pitch goes through Signalsmith Stretch once it's running; the fx node's own
    // phase vocoder only covers the moment it takes to load (or if it can't).
    this.fx?.port.postMessage({ pitch: this.stretchOn ? 1 : this.pitchFactor, stems });
    this.updateStretch();
  }

  /**
   * Key lock / key shift through Signalsmith Stretch (much cleaner than the fx
   * node's phase vocoder). It adds a fixed delay, so while it's in the chain the
   * sources play `lead` seconds ahead (see startSource) and what you hear stays
   * exactly on the beat grid.
   */
  updateStretch() {
    const f = this.pitchFactor;
    const want = this.keyLock || Math.abs(f - 1) > 1e-4;
    if (want && !this.stretch) {
      this.stretchLoading ??= SignalsmithStretch(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
        .then(async (node) => {
          this.stretchLatency = await node.latency();
          node.start();
          this.stretch = node;
          this.updateStretch();
        })
        .catch((err) => console.error('Signalsmith Stretch unavailable, using the built-in pitch shifter:', err));
      return;
    }
    if (!this.stretch) return;
    if (want) this.stretch.schedule({ semitones: 12 * Math.log2(f) });
    if (want !== !!this.stretchOn) this.routeStretch(want);
  }

  routeStretch(on) {
    const src = this.fx || this.bus;
    const swap = () => {
      src.disconnect();
      if (on) {
        src.connect(this.stretch);
        this.stretch.connect(this.trim);
      } else {
        this.stretch.disconnect();
        src.connect(this.trim);
      }
      // The scratch voice skips the stretcher so the record answers your hand without its delay.
      this.scratchNode?.disconnect();
      this.scratchNode?.connect(on ? this.trim : this.bus);
      this.stretchOn = on;
      this.lead = on ? this.stretchLatency : 0;
      this.sendFx();
      if (this.playing) this.restartInPlace(); // re-anchor for the new delay
    };
    if (this.playing) this.fadeSwap(swap);
    else swap();
  }

  /** Apply the VOX / DRUMS / INST levels to the AI stem gains (INST = bass + other). */
  applyAiGains() {
    const t = this.ctx.currentTime;
    const level = { vocals: this.stems.vocals, drums: this.stems.drums, bass: this.stems.instruments, other: this.stems.instruments };
    for (const n of AI_STEM_NAMES) this.aiGains[n].gain.setTargetAtTime(level[n], t, 0.015);
  }

  /** Switch this deck to AI stems (buffers keyed drums/bass/other/vocals), keeping position. */
  setAiStems(buffers) {
    this.aiStems = buffers;
    this.applyAiGains();
    this.sendFx();
    if (this.playing) this.restartInPlace();
    this.emit('stems');
  }

  setKeyShift(semitones) {
    this.keyShift = Math.max(-12, Math.min(12, Math.round(semitones * 100) / 100));
    this.sendFx();
    this.emit('key');
  }

  setKeyLock(on) {
    this.keyLock = !!on;
    this.sendFx();
    this.emit('key');
  }

  /**
   * Shift this deck so it plays in the other deck's (heard) key, or its
   * relative major/minor — same Camelot number, so they mix harmonically.
   * Turns key lock on, so the match holds when tempo moves. Returns the shift
   * in semitones, or null if either key is unknown.
   */
  matchKeyTo(other) {
    const mine = this.track?.key;
    const theirs = other.track?.key;
    if (mine == null || mine < 0 || theirs == null || theirs < 0) return null;
    const relMajor = (k) => (k % 12) + (k >= 12 ? 3 : 0);
    let s = relMajor(theirs) + other.keyOffset - relMajor(mine);
    s = ((s % 12) + 12) % 12;
    if (s >= 6) s -= 12; // smallest move: −6…+6
    this.keyLock = true;
    this.setKeyShift(s);
    return this.keyShift;
  }

  /** Stem level 0..1 (vocals | drums | instruments). */
  setStem(name, level) {
    if (!(name in this.stems)) return;
    this.stems[name] = Math.max(0, Math.min(1, level));
    if (this.aiStems) this.applyAiGains();
    this.sendFx();
    this.emit('stems');
  }

  resetStems() {
    for (const k of STEMS) this.stems[k] = 1;
    if (this.aiStems) this.applyAiGains();
    this.sendFx();
    this.emit('stems');
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type) {
    for (const fn of this.listeners) fn(type, this);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  get bpm() {
    return this.track?.bpm || null;
  }

  get effectiveBpm() {
    return this.bpm ? this.bpm * this.rate : null;
  }

  /** Playback speed: tempo times any nudge being held. */
  get speed() {
    return this.rate * this.bendFactor;
  }

  /** Heard track position at context time t (a start scheduled after t reads as its start point). */
  positionAt(t) {
    if (!this.playing) return this.pausedPos;
    if (t < this.startTime) return this.startPos;
    let pos = this.startPos + (t - this.startTime) * this.speed;
    if (this.loop && pos >= this.loop.end) {
      const len = this.loop.end - this.loop.start;
      pos = this.loop.start + ((pos - this.loop.start) % len);
    }
    return Math.min(pos, this.duration);
  }

  get position() {
    return this.positionAt(this.ctx.currentTime);
  }

  /** Seconds per beat in track time. */
  get beatPeriod() {
    return this.bpm ? 60 / this.bpm : 0;
  }

  /** Beats since the downbeat at track position pos (fractional). */
  deckBeat(pos) {
    const bars = this.bars;
    return bars ? (pos - bars.downbeat) / this.beatPeriod : 0;
  }

  load(buffer, track) {
    this.stopSource();
    this.buffer = buffer;
    this.track = track;
    this.playing = false;
    this.pausedPos = 0;
    this.cuePoint = track.beatOffset && track.beatOffset < 2 ? track.beatOffset : 0;
    this.loop = null;
    // A new track starts in its own key with every stem on; key lock is a deck setting and stays.
    this.keyShift = 0;
    for (const k of STEMS) this.stems[k] = 1;
    this.aiStems = null;
    this.applyAiGains();
    this.sendFx();
    if (this.scratchNode) this.sendScratchBuffer();
    this.emit('load');
  }

  stopSource(when = this.ctx.currentTime) {
    for (const s of this.sources) {
      s.onended = () => s.disconnect();
      try {
        s.stop(when);
      } catch {}
    }
    this.sources = [];
    this.source = null;
  }

  /** Play from track position `at`, heard from context time `when` (old sources hand over at the same instant). */
  startSource(at, when = this.ctx.currentTime + LOOKAHEAD) {
    queueMicrotask(() => this.fxChain.syncGate());
    this.stopSource(when);
    // One source for the mixed track, or four (one per AI stem) started together.
    const plan = this.aiStems
      ? AI_STEM_NAMES.map((n) => [this.aiStems[n], this.aiGains[n]])
      : [[this.buffer, this.input]];
    // Read ahead by the stretcher's delay (lead = 0 without it); inside a loop, wrap into it.
    let offset = at + (this.lead || 0) * this.speed;
    if (this.loop && offset >= this.loop.end) offset = this.loop.start + ((offset - this.loop.start) % (this.loop.end - this.loop.start));
    offset = Math.max(0, Math.min(offset, this.duration - 0.001));
    for (const [buffer, dest] of plan) {
      const s = this.ctx.createBufferSource();
      s.buffer = buffer;
      s.playbackRate.value = this.speed;
      if (this.loop) {
        s.loop = true;
        s.loopStart = this.loop.start;
        s.loopEnd = this.loop.end;
      }
      s.connect(dest);
      s.start(when, offset);
      this.sources.push(s);
    }
    const src = this.sources[0];
    src.onended = () => {
      if (this.source === src) {
        this.stopSource();
        this.playing = false;
        this.pausedPos = this.duration;
        this.emit('state');
      }
    };
    this.startPos = at;
    this.startTime = when;
    this.appliedSpeed = this.speed;
    this.busyUntil = Math.max(this.busyUntil, when);
    this.source = src;
  }

  /** Restart the sources where the deck already is (after a routing change), without a jump. */
  restartInPlace() {
    const when = this.ctx.currentTime + LOOKAHEAD;
    this.startSource(this.positionAt(when), when);
  }

  /**
   * Start playing. `at` / `when` let sync start a deck at an exact position and instant
   * (e.g. on the next beat of the deck it's locked to).
   */
  play({ at, when } = {}) {
    if (!this.buffer || this.playing) return;
    this.mixer.resume();
    if (this.pausedPos >= this.duration - 0.01) this.pausedPos = 0;
    this.startSource(at ?? this.pausedPos, when);
    this.playing = true;
    this.emit('state');
  }

  pause() {
    if (!this.playing) return;
    this.pausedPos = this.position;
    this.stopSource();
    this.playing = false;
    this.emit('state');
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  /** Jump to t. While playing, t is where the deck should be *now*; the jump lands LOOKAHEAD later, on the same line. */
  seek(t) {
    if (!this.buffer) return;
    const pos = Math.max(0, Math.min(t, this.duration));
    if (this.loop && (pos < this.loop.start || pos >= this.loop.end)) this.loop = null;
    if (this.playing) this.startSource(pos + LOOKAHEAD * this.speed);
    else this.pausedPos = pos;
    this.emit('seek');
  }

  /** Move a playing deck to `pos` at context time `when`, dipping it for a few ms so the jump doesn't click. */
  jumpTo(pos, when = this.ctx.currentTime + LOOKAHEAD) {
    if (!this.playing) {
      this.pausedPos = Math.max(0, Math.min(pos, this.duration));
      return;
    }
    const g = this.bus.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(1, now);
    g.setValueAtTime(1, Math.max(now, when - 0.004));
    g.linearRampToValueAtTime(0, when);
    g.linearRampToValueAtTime(1, when + 0.006);
    if (this.loop && (pos < this.loop.start || pos >= this.loop.end)) {
      const len = this.loop.end - this.loop.start;
      pos = this.loop.start + ((((pos - this.loop.start) % len) + len) % len); // keep the loop: wrap into it
    }
    this.startSource(Math.max(0, pos), when);
  }

  /** CDJ-style cue: paused → set cue here; playing → jump back to cue and stop. */
  cue() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cuePoint);
    } else {
      const pos = this.snapToBeat(this.position);
      this.cuePoint = pos;
      this.seek(pos);
    }
    this.emit('cue');
  }

  setRate(rate, { silent = false } = {}) {
    this.rate = rate;
    this.applySpeed();
    queueMicrotask(() => this.fxChain.syncGate());
    if (this.keyLock) this.sendFx(); // pitch correction follows the tempo
    if (!silent) this.emit('rate');
  }

  /** Hand a new speed to the sources, rebasing the position so it stays continuous. */
  applySpeed() {
    const now = this.ctx.currentTime;
    const speed = this.speed;
    if (this.playing && now >= this.startTime) {
      const pos = this.positionAt(now);
      // With key lock, what you hear trails the read point by `lead`; the sources read
      // at the new speed straight away, so the heard position shifts by lead x (old - new).
      this.startPos = pos + (this.lead || 0) * (this.appliedSpeed - speed);
      this.startTime = now;
      if (this.loop && pos < this.loop.start) this.loop = null;
    }
    for (const s of this.sources) {
      s.playbackRate.cancelScheduledValues(now);
      s.playbackRate.setValueAtTime(speed, now);
    }
    this.appliedSpeed = speed;
  }

  /**
   * Sync's phase correction: run eps faster (or slower, eps < 0) for dur seconds from
   * `when`. The position books the whole correction at once, so a late tick can't overshoot.
   */
  trimPulse(eps, when, dur) {
    if (!this.playing) return;
    const v = this.speed;
    for (const s of this.sources) {
      s.playbackRate.setValueAtTime(v * (1 + eps), when);
      s.playbackRate.setValueAtTime(v, when + dur);
    }
    this.startPos += eps * v * dur; // back-to-back pulses tile: the next tick schedules from when + dur
  }

  /** Nudge (pitch bend) for manual beat-matching; call endBend() on release. */
  bend(amount) {
    this.bendFactor = 1 + amount;
    this.applySpeed();
  }

  endBend() {
    if (this.bendFactor === 1) return;
    this.bendFactor = 1;
    this.applySpeed();
    this.emit('bendEnd');
  }

  snapToBeat(pos) {
    const t = this.track;
    if (!t?.bpm || t.beatOffset == null) return pos;
    const period = 60 / t.bpm;
    const n = Math.round((pos - t.beatOffset) / period);
    const snapped = t.beatOffset + n * period;
    return Math.abs(snapped - pos) < period * 0.25 ? Math.max(0, snapped) : pos;
  }

  setLoop(beats) {
    if (!this.buffer) return;
    if (this.loop && this.loop.beats === beats) {
      this.exitLoop();
      return;
    }
    const bpm = this.bpm || 120;
    const period = 60 / bpm;
    const pos = this.position;
    let start = pos;
    if (this.track?.beatOffset != null && this.bpm) {
      const n = Math.floor((pos - this.track.beatOffset) / period);
      start = Math.max(0, this.track.beatOffset + n * period);
    }
    if (this.loop) start = this.loop.start; // resizing keeps the start
    const end = Math.min(this.duration, start + beats * period);
    if (end - start < 0.02) return;
    this.loop = { start, end, beats };
    if (this.playing) {
      // Rebase position, then hand the loop to the running source. Use the position from before the
      // new loop was set: read now, it would already be wrapped into the new loop while the source isn't.
      const p = pos;
      const inside = p >= start && p < end ? p : start + ((p - start) % (end - start));
      if (inside !== p) this.startSource(inside + LOOKAHEAD * this.speed);
      else {
        this.startPos = p;
        this.startTime = this.ctx.currentTime;
      }
      for (const s of this.sources) {
        s.loopStart = start;
        s.loopEnd = end;
        s.loop = true;
      }
    }
    this.emit('loop');
  }

  exitLoop() {
    if (!this.loop) return;
    if (this.playing) {
      const p = this.position;
      this.startPos = p;
      this.startTime = this.ctx.currentTime;
      for (const s of this.sources) s.loop = false;
    }
    this.loop = null;
    this.emit('loop');
  }

  /** Dip the deck for ~4 ms around a jump (e.g. key lock re-anchoring) so it doesn't click. */
  fadeSwap(fn) {
    const g = this.bus.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + 0.004);
    setTimeout(() => {
      fn();
      const t2 = this.ctx.currentTime;
      g.cancelScheduledValues(t2);
      g.setValueAtTime(0, t2);
      g.linearRampToValueAtTime(1, t2 + 0.006);
    }, 5);
  }

  /**
   * Snap to beat: how far to move `pos` (track seconds, at most half a step either
   * way; a step is 1/div beat) so it sits on a step lined up with `other`'s. Without a usable
   * other deck it just rounds to this track's own nearest beat.
   */
  beatSnap(pos, other, div = 1) {
    const t = this.track;
    if (!this.bpm || t?.beatOffset == null) return 0;
    const per = 60 / this.bpm;
    let target = 0; // phase (0..1) the beat should land on
    if (other && other !== this && other.playing && other.bpm && other.track?.beatOffset != null) {
      const k = [1, 2, 0.5].find((m) => Math.abs((this.effectiveBpm * m) / other.effectiveBpm - 1) < 0.1); // close tempos: line up with where the other deck is now
      if (k) target = frac((((other.position - other.track.beatOffset) / (60 / other.bpm)) / k) * div);
    }
    let d = target - frac(((pos - t.beatOffset) / per) * div); // in steps of 1/div beat
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    if (pos + (d * per) / div < 0) d += 1; // before 0:00 would get clamped: take the next step instead
    return (d * per) / div;
  }

  setEq(band, db) {
    const node = band === 'low' ? this.low : band === 'mid' ? this.mid : this.high;
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  setTrim(db) {
    this.trim.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.01);
  }

  setFader(v) {
    // Slight curve so the fader feels even to the ear.
    this.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01);
  }

  /** One-knob filter: -1 = low-pass closed, 0 = off, +1 = high-pass closed. */
  setFilter(x) {
    const t = this.ctx.currentTime;
    if (x < -0.02) {
      const f = 22000 * Math.pow(150 / 22000, -x);
      this.lp.frequency.setTargetAtTime(f, t, 0.01);
      this.hp.frequency.setTargetAtTime(10, t, 0.01);
    } else if (x > 0.02) {
      const f = 10 * Math.pow(6000 / 10, x);
      this.hp.frequency.setTargetAtTime(f, t, 0.01);
      this.lp.frequency.setTargetAtTime(22000, t, 0.01);
    } else {
      this.lp.frequency.setTargetAtTime(22000, t, 0.01);
      this.hp.frequency.setTargetAtTime(10, t, 0.01);
    }
  }
}

const frac = (x) => x - Math.floor(x);

// ---------------------------------------------------------------- deck effects

/**
 * Per-deck effects after the EQ and filter: gate → flanger → reverb.
 *  • Gate: beat-synced tremolo. A soft square wave opens the volume on every
 *    step (¼, ⅛ or ⅟₁₆ note) and dips it in between; amount = how deep.
 *  • Flanger: a 1–5 ms swept delay with feedback, mixed in; amount = mix + feedback.
 *  • Reverb: a generated 2.6 s room tail, mixed in; amount = wet level. The tail
 *    rings out naturally when it's switched off.
 * Every change glides (setTargetAtTime), so toggling and sliding never click.
 */
export class FxChain {
  constructor(ctx, deck) {
    this.ctx = ctx;
    this.deck = deck;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.state = {
      gate: { on: false, amount: 0.7, div: 2 }, // div: steps per beat (1 = ¼, 2 = ⅛, 4 = ⅟₁₆)
      flanger: { on: false, amount: 0.5 },
      reverb: { on: false, amount: 0.4 },
    };

    // Gate: gain = 1 − depth·(1 − wave)/2, where wave swings −1..1 and is +1 (open) on the step.
    this.gate = ctx.createGain();
    this.gateDepth = ctx.createGain(); // scales the oscillator into the gain
    this.gateDepth.gain.value = 0;
    this.gateDepth.connect(this.gate.gain);
    // A soft square from odd sine harmonics: open (+1) for the first half of each step,
    // starting right on the step, closed for the second half. Tapered so the edges don't click.
    const n = 8;
    const real = new Float32Array(n * 2);
    const imag = new Float32Array(n * 2);
    for (let k = 1; k < n * 2; k += 2) imag[k] = (4 / (Math.PI * k)) * Math.cos((Math.PI * k) / (4 * n));
    this.gateWave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
    this.gateOsc = null;

    // Flanger: dry + (delay ← LFO, with feedback) · wet.
    this.flDry = ctx.createGain();
    this.flWet = ctx.createGain();
    this.flWet.gain.value = 0;
    this.flDelay = ctx.createDelay(0.02);
    this.flDelay.delayTime.value = 0.003;
    this.flFeedback = ctx.createGain();
    this.flFeedback.gain.value = 0;
    this.flLfo = ctx.createOscillator();
    this.flLfo.frequency.value = 0.25;
    const sweep = ctx.createGain();
    sweep.gain.value = 0.002; // ±2 ms around 3 ms
    this.flLfo.connect(sweep).connect(this.flDelay.delayTime);
    this.flLfo.start();
    this.flMix = ctx.createGain();

    // Reverb: dry + convolver · wet.
    this.rvDry = ctx.createGain();
    this.rvWet = ctx.createGain();
    this.rvWet.gain.value = 0;
    this.rv = ctx.createConvolver();
    this.rv.buffer = roomImpulse(ctx, 2.6);

    this.input.connect(this.gate);
    this.gate.connect(this.flDry).connect(this.flMix);
    this.gate.connect(this.flDelay);
    this.flDelay.connect(this.flFeedback).connect(this.flDelay);
    this.flDelay.connect(this.flWet).connect(this.flMix);
    this.flMix.connect(this.rvDry).connect(this.output);
    this.flMix.connect(this.rv).connect(this.rvWet).connect(this.output);
  }

  /** Turn an effect on or off and/or set its amount (0..1) or the gate's rate. */
  set(name, patch) {
    Object.assign(this.state[name], patch);
    this.apply();
  }

  apply() {
    const t = this.ctx.currentTime;
    const glide = (param, v) => param.setTargetAtTime(v, t, 0.03);
    const { gate, flanger, reverb } = this.state;
    const depth = gate.on ? gate.amount : 0;
    glide(this.gate.gain, 1 - depth / 2);
    glide(this.gateDepth.gain, depth / 2);
    if (gate.on && !this.gateOsc) this.syncGate();
    const fl = flanger.on ? flanger.amount : 0;
    glide(this.flWet.gain, fl * 0.8);
    glide(this.flDry.gain, 1 - fl * 0.25); // keeps the overall level even as the mix rises
    glide(this.flFeedback.gain, fl * 0.7);
    const rv = reverb.on ? reverb.amount : 0;
    glide(this.rvWet.gain, rv * 0.9);
    glide(this.rvDry.gain, 1 - rv * 0.3);
  }

  /**
   * (Re)start the gate's oscillator so it opens exactly on the next step of the
   * beat grid, at the current tempo. Called on play, seek and tempo changes.
   */
  syncGate() {
    const d = this.deck;
    const g = this.state.gate;
    if (!g.on || !d.playing || !d.bpm || d.track?.beatOffset == null) {
      if (!g.on && this.gateOsc) {
        this.gateOsc.stop(this.ctx.currentTime + 0.1); // after the depth has glided to 0
        this.gateOsc = null;
      }
      return;
    }
    const step = 60 / d.bpm / g.div; // track seconds per gate step
    const pos = d.position;
    const next = d.track.beatOffset + Math.ceil((pos - d.track.beatOffset) / step) * step;
    // The deck-fx node ahead of the gate delays the audio by 2048 samples: open on the step as heard.
    const fxDelay = d.fx ? 2048 / this.ctx.sampleRate : 0;
    const when = this.ctx.currentTime + (next - pos) / d.rate + fxDelay;
    const osc = this.ctx.createOscillator();
    osc.setPeriodicWave(this.gateWave);
    osc.frequency.value = d.rate / step; // steps per real second
    osc.connect(this.gateDepth);
    osc.start(when);
    this.gateOsc?.stop(when); // hand over exactly on the step
    this.gateOsc = osc;
  }
}

/** A decaying stereo noise burst: a simple, smooth room for the reverb. */
function roomImpulse(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      lp += 0.35 * (Math.random() * 2 - 1 - lp); // darker, less hissy
      data[i] = lp * Math.pow(1 - t, 3.2) * (i < 64 ? i / 64 : 1);
    }
  }
  return b;
}

/** Peak level in dBFS from an analyser. */
export function peakDb(analyser, scratch) {
  analyser.getFloatTimeDomainData(scratch);
  let max = 0;
  for (let i = 0; i < scratch.length; i++) {
    const v = Math.abs(scratch[i]);
    if (v > max) max = v;
  }
  return max > 0 ? 20 * Math.log10(max) : -Infinity;
}
