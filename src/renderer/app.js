// Commons DJ — UI
import { Mixer, peakDb, STEMS, AI_STEM_NAMES, XF_SIDE } from './engine.js';
import { SyncGroup } from './sync.js';
import { SOUNDS } from './sfx.js';
import { mixToMono, computeWaveform, overview, analyzeTrack, fitGridAt, detectMeter, keyName, camelot, transposeKey, detectKey, onsetEnvelope, beatSalience, ANALYSIS_VERSION, KEY_VERSION } from './analysis.js';

const api = window.cdj;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const mixer = new Mixer();
// Beat sync: every synced deck locks to one shared clock (see sync.js).
const group = new SyncGroup(mixer, { onChange: () => onSyncChange() });
window.cdjDebug = { mixer, group }; // for tests and the devtools console
const DECKS = ['A', 'B', 'C', 'D']; // all built; C and D show in 4-deck mode (Settings)
const activeDecks = () => (document.body.classList.contains('decks-4') ? DECKS : ['A', 'B']);
const otherSide = (name) => (XF_SIDE[name] === 'L' ? 'R' : 'L');

/**
 * The deck to sync / key-match to: a playing deck on the other crossfader side,
 * then any other playing deck, then the other side's main deck (A ↔ B).
 */
function partnerDeck(name) {
  const others = activeDecks().filter((n) => n !== name && mixer.decks[n].track);
  return (
    others.find((n) => XF_SIDE[n] === otherSide(name) && mixer.decks[n].playing) ||
    others.find((n) => mixer.decks[n].playing) ||
    others.find((n) => n === (otherSide(name) === 'R' ? 'B' : 'A')) ||
    others[0] ||
    (XF_SIDE[name] === 'L' ? 'B' : 'A')
  );
}
// Canvas colours. ACCENT matches --a / --b and shade matches --bg in styles.css.
const ACCENT = { A: [255, 138, 61], B: [66, 182, 255], C: [181, 123, 255], D: [163, 230, 53] };
const INK = { ink: '237,237,240', shade: '11,11,13', hi: [176, 180, 190], bands: { low: [240, 62, 98], mid: [255, 178, 82], high: [238, 238, 246] } };
const HOTCUE_COLORS = ['#ff5c6c', '#42d392', '#8b7bff', '#ffd24d'];

const state = {
  tracks: [],
  filter: '',
  waves: { A: null, B: null, C: null, D: null },
  overviewImg: { A: null, B: null, C: null, D: null },
  zoom: 110, // waveform pixels per second (tracks without a BPM)
  span: 16, // seconds shown across the scrolling waveforms (the same for every deck)
  played: new Map(), // trackId -> track (web tracks played this session, for credits)
  ccResults: [],
  jobs: new Map(), // jobId -> { el, url }
  stemJobs: new Map(), // trackId -> { done, total } while AI stems are being made
};

// ------------------------------------------------------------------ helpers

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(sec, tenths = false) {
  if (sec == null || !isFinite(sec)) return tenths ? '0:00.0' : '—';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${neg ? '−' : ''}${m}:${ss}`;
}

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? 6000 : 3200);
}

// No-gate build: tracks aren't license-checked, so anything that isn't
// clearly CC shows as UNCHECKED rather than defaulting to "CC".
function shortLicense(lic) {
  if (!lic) return 'UNCHECKED';
  if (/public\s*domain|cc0/i.test(lic)) return 'PUBLIC DOMAIN';
  if (/attribution/i.test(lic) || /cc[\s-]?by/i.test(lic)) {
    const m = lic.match(/cc[\s-]?by(?:[\s-](?:sa|nd|nc))*(?:[\s-]\d\.\d)?/i);
    return m ? m[0].toUpperCase().replace(/\s/g, '-') : 'CC BY';
  }
  if (/creative\s*commons/i.test(lic)) return 'CC';
  return 'UNCHECKED';
}

/** "8A Am" for a stored key (0–23); '' when unknown. */
function keyLabel(key) {
  return key == null || key < 0 ? '' : `${camelot(key)} ${keyName(key)}`;
}

function cleanErr(err) {
  let msg = String(err?.message || err || 'Something went wrong');
  msg = msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  if (/unable to (download|connect)|getaddrinfo|timed out|network is unreachable|proxy/i.test(msg)) {
    return 'Couldn’t reach YouTube — check your internet connection and try again.';
  }
  return msg.replace(/;?\s*please report this issue.*$/i, '').slice(0, 300);
}

function jobId() {
  return Math.random().toString(36).slice(2, 10);
}

// ------------------------------------------------------------------ knobs

class Knob {
  constructor(el, { min, max, value, reset = value, bipolar = false, onChange }) {
    Object.assign(this, { el, min, max, value, reset, bipolar, onChange });
    el.innerHTML = `
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <path class="k-track" d="${arc(-135, 135)}" fill="none" stroke-width="3.5" stroke-linecap="round"/>
        <path class="k-value" fill="none" stroke-width="3.5" stroke-linecap="round"/>
        <circle class="k-cap" cx="20" cy="20" r="11" stroke-width="1"/>
        <line class="k-ptr" x1="20" y1="20" x2="20" y2="11" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="k-label">${escapeHtml(el.dataset.label || '')}</span>`;
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', `${el.closest('[data-deck]')?.dataset.deck || ''} ${el.dataset.label || ''}`);
    this.valuePath = $('.k-value', el);
    this.ptr = $('.k-ptr', el);
    this.render();

    let startY = 0;
    let startT = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startT = this.toT(this.value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const fine = e.shiftKey ? 0.25 : 1;
      this.set(this.fromT(startT + ((startY - e.clientY) / 160) * fine));
    });
    el.addEventListener('dblclick', () => this.set(this.reset));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.set(this.fromT(this.toT(this.value) - Math.sign(e.deltaY) * 0.025));
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const nudge = (dir) => {
        this.set(this.fromT(this.toT(this.value) + dir * 0.025));
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nudge(1);
      if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nudge(-1);
    });
  }

  // Bipolar knobs put their reset value at 12 o'clock, even when the range is lopsided.
  toT(v) {
    if (!this.bipolar) return (v - this.min) / (this.max - this.min);
    return v <= this.reset ? 0.5 * ((v - this.min) / (this.reset - this.min)) : 0.5 + 0.5 * ((v - this.reset) / (this.max - this.reset));
  }

  fromT(t) {
    t = Math.min(1, Math.max(0, t));
    if (!this.bipolar) return this.min + t * (this.max - this.min);
    return t <= 0.5 ? this.min + (t / 0.5) * (this.reset - this.min) : this.reset + ((t - 0.5) / 0.5) * (this.max - this.reset);
  }

  set(v) {
    v = Math.min(this.max, Math.max(this.min, v));
    // Gentle detent at the reset point.
    if (Math.abs(this.toT(v) - this.toT(this.reset)) < 0.02) v = this.reset;
    this.value = v;
    this.render();
    this.onChange?.(v);
  }

  render() {
    const ang = -135 + this.toT(this.value) * 270;
    const from = this.bipolar ? 0 : -135;
    const [a0, a1] = ang < from ? [ang, from] : [from, ang];
    this.valuePath.setAttribute('d', a1 - a0 < 0.5 ? '' : arc(a0, a1));
    this.ptr.setAttribute('transform', `rotate(${ang} 20 20)`);
    this.el.setAttribute('aria-valuenow', this.value.toFixed(2));
    this.el.classList.toggle('kill', this.value <= this.min + 0.001 && this.min < -20);
  }
}

function arc(a0, a1, r = 16) {
  const p = (a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(20 + r * Math.cos(rad)).toFixed(2)} ${(20 + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

// ------------------------------------------------------------------ decks UI

const ui = {};

function buildDeck(name) {
  const root = $(`#deck${name}`);
  root.append($('#deckTemplate').content.cloneNode(true));
  $('.deck-badge', root).textContent = name;
  const deck = mixer.decks[name];
  const d = {
    root,
    title: $('.t-title', root),
    artist: $('.t-artist', root),
    lic: $('.lic', root),
    elapsed: $('.elapsed', root),
    remain: $('.remain', root),
    bpmEff: $('.bpm-eff', root),
    bpmTrack: $('.bpm-track', root),
    rate: $('.rate', root),
    overview: $('.overview', root),
    play: $('.play', root),
    cue: $('.cue', root),
    sync: $('.sync', root),
    tempo: $('.tempo-slider', root),
    range: $('.tempo-range', root),
    hotcues: $$('.hc', root),
    loops: $$('.lp', root),
    tap: $('.tap', root),
    keyRead: $('.key-read', root),
    keyLock: $('.key-lock', root),
    keyMatch: $('.key-match', root),
    stems: $$('.stem', root),
    stemLabel: $('.stemrow .label', root),
    meter: $('.meter', root),
    badge: $('.deck-badge', root),
    barpos: $('.barpos', root),
    vinyl: $('.vinyl', root),
    mvUrl: null, // this deck's music video (blob URL), once fetched
    mvAvailable: false, // a web track, so a video can be fetched
  };
  $('.vinyl-label', root).textContent = name;
  ui[name] = d;

  d.play.addEventListener('click', () => {
    togglePlay(name);
    markPlayed(name);
  });
  d.cue.addEventListener('click', () => deck.cue());
  d.sync.addEventListener('click', () => doSync(name));
  // Sync ratio: Auto (nearest ½ / 1 / 2) → ½× → 1× → 2×. A synced deck re-joins straight away.
  const multBtn = $('.sync-mult', root);
  multBtn.textContent = 'Auto';
  multBtn.addEventListener('click', () => {
    deck.forcedK = { null: 0.5, 0.5: 1, 1: 2, 2: null }[deck.forcedK ?? null];
    multBtn.textContent = { null: 'Auto', 0.5: '½×', 1: '1×', 2: '2×' }[deck.forcedK ?? null];
    multBtn.classList.toggle('on', deck.forcedK != null);
    if (group.has(deck)) relink(name);
  });

  const applyTempo = () => {
    const pct = (Number(d.tempo.value) / 1000) * Number(d.range.value);
    deck.setRate(1 + pct / 100);
  };
  d.tempo.addEventListener('input', applyTempo);
  d.tempo.addEventListener('dblclick', () => {
    d.tempo.value = 0;
    applyTempo();
  });
  d.range.addEventListener('change', () => {
    // Keep the current tempo when switching range: widen instead of clamping a synced deck.
    if (group.has(deck)) return syncTempoSlider(name);
    const pct = (deck.rate - 1) * 100;
    const range = Number(d.range.value);
    d.tempo.value = Math.round(Math.max(-1, Math.min(1, pct / range)) * 1000);
    applyTempo();
  });

  // Nudge buttons (hold).
  const holdBend = (btn, amt) => {
    btn.addEventListener('pointerdown', () => deck.bend(amt));
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => deck.endBend());
  };
  holdBend($('.nudge-back', root), -0.04);
  holdBend($('.nudge-fwd', root), 0.04);

  d.hotcues.forEach((btn) => {
    const i = Number(btn.dataset.i);
    btn.addEventListener('click', () => hotcue(name, i));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearHotcue(name, i);
    });
  });

  d.loops.forEach((btn) => btn.addEventListener('click', () => deck.setLoop(Number(btn.dataset.beats))));

  $('.half', root).addEventListener('click', () => scaleBpm(name, 0.5));
  $('.double', root).addEventListener('click', () => scaleBpm(name, 2));
  $('.beat-here', root).addEventListener('click', () => beatHere(name));
  d.meter.addEventListener('click', () => cycleMeter(name));
  setupTap(name);

  // Key: shift in semitones without touching tempo, key lock, match the other deck.
  $('.key-down', root).addEventListener('click', () => deck.setKeyShift(Math.round(deck.keyShift) - 1));
  $('.key-up', root).addEventListener('click', () => deck.setKeyShift(Math.round(deck.keyShift) + 1));
  d.keyRead.addEventListener('click', () => deck.setKeyShift(0));
  d.keyLock.addEventListener('click', () => deck.setKeyLock(!deck.keyLock));
  d.keyMatch.addEventListener('click', () => matchKey(name));

  // Stems: click toggles, Shift-click solos, right-click turns everything back on.
  d.stems.forEach((btn) => {
    const stem = btn.dataset.stem;
    btn.addEventListener('click', (e) => {
      if (e.shiftKey) {
        const solo = STEMS.every((s) => (s === stem ? deck.stems[s] > 0 : deck.stems[s] === 0));
        STEMS.forEach((s) => deck.setStem(s, solo || s === stem ? 1 : 0));
      } else {
        deck.setStem(stem, deck.stems[stem] > 0 ? 0 : 1);
      }
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      deck.resetStems();
    });
  });

  d.overview.addEventListener('pointerdown', (e) => {
    if (!deck.buffer) return;
    const seekTo = (ev) => {
      const r = d.overview.getBoundingClientRect();
      deck.seek(group.quantizeSeek(deck, ((ev.clientX - r.left) / r.width) * deck.duration));
    };
    seekTo(e);
    d.overview.setPointerCapture(e.pointerId);
    d.overview.classList.add('grabbing');
    const move = (ev) => seekTo(ev);
    d.overview.addEventListener('pointermove', move);
    d.overview.addEventListener('pointerup', () => {
      d.overview.removeEventListener('pointermove', move);
      d.overview.classList.remove('grabbing');
      snapDeck(name);
    }, { once: true });
  });

  let wasPlaying = false;
  deck.on((type) => {
    if (type === 'state' || type === 'load') renderDeckState(name);
    // Starting play with Snap on lands on the other deck's beat, whichever control started it.
    if (type === 'state') {
      if (deck.playing && !wasPlaying && !group.has(deck)) snapDeck(name); // synced decks start on the clock instead
      wasPlaying = deck.playing;
    }
    if (type === 'bendEnd') group.keepOffset(deck); // a nudge on a synced deck sticks
    if (type === 'load') prepareVideo(name);
    if (type === 'load') {
      root.classList.remove('just-loaded');
      void root.offsetWidth; // restart the animation
      root.classList.add('just-loaded');
    }
    if (type === 'loop' || type === 'load') d.loops.forEach((b) => b.classList.toggle('on', deck.loop?.beats === Number(b.dataset.beats)));
    if (type === 'rate' || type === 'load' || type === 'sync') renderTempo(name);
    if (type === 'rate') followTempo(name);
    if (type === 'load') {
      // Like djay, Sync stays on across loads: the new track re-joins once it's ready (see loadTrack).
      deck.resync = group.has(deck);
      group.leave(deck);
    }
    if (type === 'sync') syncTempoSlider(name);
    if (type === 'key' || type === 'rate' || type === 'load' || type === 'sync' || type === 'fx') renderKey(name);
    if (type === 'stems' || type === 'load' || type === 'fx') renderStems(name);
  });

  // Effects, djay-style: each pill is an intensity bar. Tap to switch it on or off;
  // drag across it to set the intensity (dragging switches it on). Keyboard: Enter or
  // Space toggles, arrow keys move the intensity.
  const GATE_RATES = { 1: '¼', 2: '⅛', 4: '⅟₁₆' };
  for (const box of $$('.fx', root)) {
    const fx = box.dataset.fx;
    const render = () => {
      const s = deck.fxChain.state[fx];
      const pct = Math.round(s.amount * 100);
      box.classList.toggle('on', s.on);
      box.style.setProperty('--fill', `${pct}%`);
      $('.fx-val', box).textContent = `${pct}%`;
      box.setAttribute('aria-valuenow', String(pct));
      box.setAttribute('aria-valuetext', `${pct}%, ${s.on ? 'on' : 'off'}`);
    };
    const setAmount = (v) => {
      deck.fxChain.set(fx, { amount: Math.min(1, Math.max(0, v)), on: true });
      render();
    };
    const toggle = () => {
      deck.fxChain.set(fx, { on: !deck.fxChain.state[fx].on });
      render();
    };
    let press = null;
    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.fx-rate') || e.button !== 0) return;
      try {
        box.setPointerCapture(e.pointerId);
      } catch {}
      press = { x: e.clientX, dragging: false };
    });
    box.addEventListener('pointermove', (e) => {
      if (!press) return;
      if (!press.dragging && Math.abs(e.clientX - press.x) < 4) return; // a tap, so far
      press.dragging = true;
      box.classList.add('dragging');
      const r = box.getBoundingClientRect();
      setAmount((e.clientX - r.left) / r.width);
    });
    const release = () => {
      if (!press) return;
      if (!press.dragging) toggle();
      press = null;
      box.classList.remove('dragging');
    };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', () => {
      press = null;
      box.classList.remove('dragging');
    });
    box.addEventListener('keydown', (e) => {
      const s = deck.fxChain.state[fx];
      if (e.key === 'Enter' || e.key === ' ') toggle();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setAmount(s.amount + 0.05);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setAmount(s.amount - 0.05);
      else return;
      e.preventDefault();
      e.stopPropagation(); // don't also move the crossfader or toggle playback
    });
    const rate = $('.fx-rate', box);
    rate?.addEventListener('click', () => {
      const div = { 1: 2, 2: 4, 4: 1 }[deck.fxChain.state.gate.div];
      deck.fxChain.set('gate', { div });
      deck.fxChain.syncGate();
      rate.textContent = GATE_RATES[div];
    });
    render();
  }

  setupDeckDrop(root, name);
  setupDeckDrop($(`.wave-row[data-deck="${name}"]`), name);
}

function renderDeckState(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  d.play.classList.toggle('on', deck.playing);
  d.play.textContent = deck.playing ? '❚❚' : '▶';
  const t = deck.track;
  d.root.classList.toggle('has-track', !!t);
  if (t) {
    d.title.textContent = t.title || 'Untitled';
    d.artist.textContent = t.artist || (t.source?.uploader ?? '');
    if (t.source?.kind === 'web') {
      d.lic.hidden = false;
      d.lic.className = 'lic';
      d.lic.textContent = shortLicense(t.source.license);
      d.lic.title = t.source.license || '';
    } else {
      d.lic.hidden = false;
      d.lic.className = 'lic local';
      d.lic.textContent = 'LOCAL';
      d.lic.title = t.file;
    }
  }
  renderHotcues(name);
  renderLibrary();
}

function renderTempo(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const pct = (deck.rate - 1) * 100;
  d.rate.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  d.meter.textContent = `${deck.bars?.beatsPerBar || 4}/4`;
  if (deck.bpm) {
    d.bpmEff.textContent = deck.effectiveBpm.toFixed(1);
    d.bpmTrack.textContent = `${Number(deck.bpm).toFixed(1)} track`;
  } else {
    d.bpmEff.textContent = '—.—';
    d.bpmTrack.textContent = deck.track ? 'no grid' : '';
  }
}

function syncTempoSlider(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const pct = (deck.rate - 1) * 100;
  let range = Number(d.range.value);
  if (Math.abs(pct) > range) {
    range = [8, 16, 50].find((r) => r >= Math.abs(pct)) || 50;
    d.range.value = String(range);
  }
  d.tempo.value = Math.round((pct / range) * 1000);
}

// ------------------------------------------------------------------ SFX pads

/** The deck the crowd is hearing most: playing, and favoured by the crossfader. */
function leadDeck() {
  const playing = activeDecks().filter((n) => mixer.decks[n].playing && mixer.decks[n].bars);
  if (playing.length < 2) return playing[0] ? mixer.decks[playing[0]] : null;
  const side = mixer.crossfader > 0.5 ? 'R' : 'L';
  return mixer.decks[playing.find((n) => XF_SIDE[n] === side) || playing[0]];
}

function playSfx(sound, pad) {
  mixer.resume();
  const ctx = mixer.ctx;
  const deck = leadDeck();
  const beat = deck ? 60 / deck.effectiveBpm : 0.5;
  let t = ctx.currentTime + 0.01;
  if (deck && $('#sfxQuantize').checked) {
    // Next beat of the lead deck, on the audio clock.
    const p = deck.position;
    const off = deck.track.beatOffset;
    const period = 60 / deck.bpm;
    const next = off + Math.ceil((p - off) / period + 0.02) * period;
    // Decks reach the speakers through the fx node (2048 samples later); SFX don't, so wait that out too.
    t = ctx.currentTime + (next - p) / deck.speed + (deck.fx ? 2048 / ctx.sampleRate : 0);
  }
  sound.play(ctx, mixer.sfx, t, beat);
  pad.classList.remove('hit');
  setTimeout(() => {
    void pad.offsetWidth;
    pad.classList.add('hit');
  }, Math.max(0, (t - ctx.currentTime) * 1000));
}

function setupSfx() {
  $('#sfxGrid').innerHTML = SOUNDS.map((s, i) => `<button class="sfx-pad" data-i="${i}">${escapeHtml(s.label)}</button>`).join('');
  $('#sfxGrid').addEventListener('pointerdown', (e) => {
    const pad = e.target.closest('.sfx-pad');
    if (pad) playSfx(SOUNDS[pad.dataset.i], pad);
  });
  $('#sfxLevel').addEventListener('input', (e) => mixer.sfx.gain.setTargetAtTime(Number(e.target.value), mixer.ctx.currentTime, 0.01));
}

// ------------------------------------------------------------------ music videos
// One screen in the middle shows the music video of the loudest deck: playing, with
// its fader × crossfader the highest. A tie rolls a die, then sticks (no flicker);
// it only switches when another deck is clearly louder.

const mvScreen = { el: null, video: null, get: null, tag: null, deck: null };

/** After a load: fetch the cached video in the background, or remember one can be fetched. */
async function prepareVideo(name) {
  const d = ui[name];
  const t = mixer.decks[name].track;
  if (d.mvUrl) URL.revokeObjectURL(d.mvUrl);
  d.mvUrl = null;
  d.mvAvailable = false;
  if (!t) return;
  const s = await api.video.status(t.id);
  if (mixer.decks[name].track?.id !== t.id) return;
  d.mvAvailable = s.available;
  if (s.cached) getVideo(name);
}

async function getVideo(name) {
  const d = ui[name];
  const id = mixer.decks[name].track?.id;
  if (!id || d.mvFetching) return;
  d.mvFetching = true;
  try {
    const data = await api.video.get(id);
    if (mixer.decks[name].track?.id === id) d.mvUrl = URL.createObjectURL(new Blob([data]));
  } catch (err) {
    toast(`Couldn't get the music video: ${cleanErr(err)}`, 'error');
  } finally {
    d.mvFetching = false;
  }
}

const loudness = (n) => {
  const deck = mixer.decks[n];
  return deck.playing ? deck.fader.gain.value * deck.xfade.gain.value : 0;
};

/** Which deck the screen shows: the loudest with a video (or a fetchable one), tie → a die roll. */
function pickVideoDeck() {
  const options = activeDecks().filter((n) => ui[n].mvUrl || ui[n].mvAvailable);
  if (!options.length) return null;
  const cur = options.includes(mvScreen.deck) ? mvScreen.deck : null;
  const best = Math.max(...options.map(loudness));
  if (best <= 0.01) return cur || options[0]; // nothing audible: keep what's showing
  if (cur && loudness(cur) >= best - 0.08) return cur; // stay unless another is clearly louder
  const loudest = options.filter((n) => loudness(n) >= best - 0.02);
  return loudest[Math.floor(Math.random() * loudest.length)]; // equally loud: roll the die
}

/** Show the chosen deck's video and keep it with that deck: play/pause, tempo, position. */
function syncVideos() {
  const s = mvScreen;
  if (!s.el) return;
  const name = document.body.classList.contains('no-mv') ? null : pickVideoDeck();
  s.el.hidden = !name;
  if (!name) {
    if (!s.video.paused) s.video.pause();
    s.deck = null;
    return;
  }
  const d = ui[name];
  if (s.deck !== name) {
    s.deck = name;
    s.tag.textContent = name;
    s.el.dataset.deck = name;
  }
  s.el.classList.toggle('has-video', !!d.mvUrl);
  s.get.disabled = !!d.mvFetching;
  s.get.textContent = d.mvFetching ? (d.mvProgress != null ? `Getting video… ${d.mvProgress}%` : 'Getting video…') : `▶ Music video (deck ${name})`;
  if (!d.mvUrl) {
    if (s.video.getAttribute('src')) s.video.removeAttribute('src');
    return;
  }
  if (s.video.getAttribute('src') !== d.mvUrl) s.video.src = d.mvUrl;
  const v = s.video;
  if (!v.duration) return;
  const deck = mixer.decks[name];
  const target = Math.min(deck.position, v.duration - 0.05);
  v.playbackRate = Math.min(4, Math.max(0.25, deck.rate));
  if (deck.playing) {
    if (v.paused) v.play().catch(() => {});
    if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = target;
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target; // scratching / dragging moves it
  }
}

function setupVideoScreen() {
  const el = $('#mvCenter');
  Object.assign(mvScreen, { el, video: $('.mv-video', el), get: $('.mv-get', el), tag: $('.mv-tag', el) });
  mvScreen.get.addEventListener('click', () => mvScreen.deck && getVideo(mvScreen.deck));
  api.video.onProgress(({ trackId, percent }) => {
    for (const name of DECKS) if (mixer.decks[name].track?.id === trackId) ui[name].mvProgress = Math.round(percent);
  });
}

// Snap to beat (top-bar toggle): when you let go of a dragged waveform, record or
// overview, the deck lands on the nearest beat lined up with the deck it plays against.
const snapOn = () => $('#snapBtn').classList.contains('on');
// Snap lands on the nearest line of the finest grid drawn on the waveform at this zoom
// (lines closer than 5 px aren't drawn), so every line you can see is a place to land.
function snapDiv(name) {
  const deck = mixer.decks[name];
  if (!deck.bpm) return 1;
  const px = 60 / deck.bpm / secPerCssPx(deck, $(`#wave${name}`).clientWidth); // px per beat
  return [16, 8, 4, 2].find((d) => px / d >= 5) || 1;
}
function snapDeck(name) {
  const deck = mixer.decks[name];
  if (!snapOn() || !deck.buffer || state.startingTogether) return;
  const shift = deck.beatSnap(deck.position, mixer.decks[partnerDeck(name)], snapDiv(name));
  if (Math.abs(shift) < 0.002) return;
  if (deck.playing) deck.fadeSwap(() => deck.seek(deck.position + shift));
  else deck.seek(deck.pausedPos + shift);
}

// The SYNC lights, tempo sliders and readouts follow the group.
function onSyncChange() {
  for (const n of DECKS) {
    const deck = mixer.decks[n];
    ui[n].sync.classList.toggle('on', group.has(deck));
    const tempoOnly = group.members.get(deck)?.tempoOnly;
    ui[n].sync.textContent = tempoOnly ? 'TEMPO' : 'SYNC';
    ui[n].sync.setAttribute('aria-pressed', String(group.has(deck)));
    ui[n].sync.title = tempoOnly ? 'Tempo linked; beat alignment lost. Press twice to retry Sync, or adjust the beat grid.' : 'Link tempo and beats to another deck. Press again to unlink.';
    if (group.has(deck)) {
      syncTempoSlider(n);
      renderTempo(n);
      renderKey(n);
    }
  }
}

/** Play / pause. A synced deck starts on the clock: at its cue point, on the next matching beat. */
function togglePlay(name) {
  const deck = mixer.decks[name];
  if (deck.playing || !group.has(deck)) return deck.toggle();
  deck.play(group.startPlan(deck) || {});
}

// A tempo move on a synced deck moves the clock; the other members follow.
function followTempo(name) {
  for (const { deck } of group.setTempoFrom(mixer.decks[name])) {
    syncTempoSlider(deck.name);
  }
}

// Which tempo reading to sync on. Besides its tempo, the analyser keeps the other readings it
// found (bpmAlts: ×4⁄3, ×¾, ×5⁄4 … of it, each with its own fitted grid and how well the audio
// supports it). A triplet or half-time feel read at the wrong level shows up as a large stretch
// against the other deck, so Sync weighs every reading by how far it would have to stretch
// the track against how firmly its grid sits on the track's actual hits (beatSalience), and
// switches only when another reading saves a clear amount. Grids set by hand stay.
const ALT_COST = Math.log(1.04); // an alternative reading must save over ~4% of stretch ...
const FIT_COST = 0.5; // ... plus half its loss in fit (log of main / alternative salience)
const WEAK_ALT_COST = Math.log(1.08); // without onsets yet: up to 8% more the weaker the analyser found it
const stretchTo = (bpm, target) => Math.min(...[0.5, 1, 2].map((k) => Math.abs(Math.log((target * k) / bpm))));
function pickReading(deck, other) {
  const groupBpm = group.members.size ? group.bpm : null;
  // With a group running only the joining deck can change; a new pair may switch either track.
  const sides = groupBpm ? [[deck, groupBpm]] : other.playing ? [[deck, other.bpm * other.rate]] : [[deck, other.bpm * other.rate], [other, deck.bpm * deck.rate]];
  let best = { cost: stretchTo(deck.bpm, sides[0][1]) };
  for (const [d, target] of sides) {
    if (d.track.gridSource === 'user') continue;
    const main = d.onsets && beatSalience(d.onsets, d.bpm, d.track.beatOffset);
    for (const alt of d.track.bpmAlts || []) {
      const fit = main && alt.offset != null ? FIT_COST * Math.log(main / Math.max(beatSalience(d.onsets, alt.bpm, alt.offset), 1e-9)) : WEAK_ALT_COST * Math.max(0, 1 - (alt.rel ?? 0));
      const cost = stretchTo(alt.bpm, target) + ALT_COST + Math.max(0, fit);
      if (cost < best.cost) best = { cost, d, alt };
    }
  }
  if (best.alt) useReading(best.d, best.alt);
}

function useReading(d, alt) {
  const was = d.bpm;
  const t = d.track;
  const patch = { bpm: Math.round(alt.bpm * 1000) / 1000 };
  if (alt.offset != null) {
    // The alternative's own grid: keep the bar start on its nearest new beat.
    const p = 60 / patch.bpm;
    const old = t.downbeat ?? alt.offset;
    patch.beatOffset = alt.offset;
    patch.downbeat = alt.offset + Math.round((old - alt.offset) / p) * p;
  }
  if (t.beatsPerBar === 3 && alt.bpm / was > 1.2) patch.beatsPerBar = 4; // 3 slow beats were one 4/4 bar
  // Keep the other readings, with the old one among them, so a later sync can switch back.
  const r = Math.max(alt.rel ?? 1, 0.01); // supports were relative to the old reading
  patch.bpmAlts = [{ bpm: was, offset: t.beatOffset, rel: 1 / r }, ...(t.bpmAlts || []).filter((x) => x !== alt).map((x) => ({ ...x, rel: (x.rel ?? 0) / r }))];
  saveTrack(t, patch);
  renderTempo(d.name);
  renderLibrary();
  toast(`Deck ${d.name}: using its ${patch.bpm} BPM reading instead of ${was} — the beats fit the other deck with far less stretching.`);
}

/** The deck a new sync should lock to: a group member if there is a group, else the partner. */
function syncPartner(name) {
  const deck = mixer.decks[name];
  const members = [...group.members.keys()].filter((d) => d !== deck);
  return members.find((d) => d.playing) || members[0] || mixer.decks[partnerDeck(name)];
}

function doSync(name) {
  const deck = mixer.decks[name];
  if (group.has(deck)) return group.leave(deck); // pressed again: unlink, keeping the current tempo
  const other = syncPartner(name);
  if (!deck.track || !other.track) return toast('Load a track on another deck to sync to.');
  if (!deck.bpm || !other.bpm) return toast('Both tracks need a BPM — try TAP to set one.');
  if (deck.forcedK == null) pickReading(deck, other); // a forced ratio means you've chosen the reading yourself
  const res = group.join(deck, other, { forcedK: deck.forcedK });
  if (!res.ok) return toast(res.reason);
  listenAndTell(name);
  if (deck.bars && other.bars && deck.bars.beatsPerBar !== other.bars.beatsPerBar)
    toast(`Synced beats only — deck ${name} is in ${deck.bars.beatsPerBar}/4, deck ${other.name} in ${other.bars.beatsPerBar}/4.`);
}

/** After a grid or ratio change on a synced deck: join again so tempo and phase use the new grid. */
function relink(name) {
  const deck = mixer.decks[name];
  if (!group.has(deck)) return;
  const others = [...group.members.keys()].filter((d) => d !== deck);
  group.leave(deck);
  const res = group.join(deck, others.find((d) => d.playing) || others[0], { forcedK: deck.forcedK });
  if (!res.ok) return toast(res.reason, 'error');
  listenAndTell(name);
}

/** After a join: check by ear that the beats really meet, and say so if Sync had to move them. */
function listenAndTell(name) {
  let deck = mixer.decks[name];
  if (deck.playing) deck = [...group.members.keys()].find((d) => d !== deck && !d.playing) || deck;
  const r = group.listen(deck);
  if (r) toast(`Deck ${deck.name}: moved ${Math.round(Math.abs(r.sec) * 1000)} ms ${r.sec > 0 ? 'later' : 'earlier'} so its beats land on the other deck's — its grid sat off the music.`);
}

const fmtSemis = (s) => {
  const r = Math.round(s * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r) % 1 ? Math.abs(r).toFixed(1) : Math.abs(r)}`;
};

function renderKey(name) {
  const deck = mixer.decks[name];
  const d = ui[name];
  const key = deck.track?.key;
  const offset = deck.keyOffset;
  const shifted = Math.abs(offset) >= 0.05;
  d.keyLock.classList.toggle('on', deck.keyLock);
  d.keyRead.classList.toggle('shifted', shifted);
  d.keyRead.classList.toggle('unknown', key == null || key < 0);
  const noFx = !deck.fx;
  if (key == null || key < 0) {
    d.keyRead.textContent = deck.track ? (shifted ? `? ${fmtSemis(offset)}` : 'no key') : '—';
    d.keyRead.title = deck.track ? 'No clear key found in this track.' : '';
  } else if (!shifted) {
    d.keyRead.innerHTML = `${escapeHtml(camelot(key))} <span class="dim">${escapeHtml(keyName(key))}</span>`;
    d.keyRead.title = `Track key ${keyName(key)} (${camelot(key)}).`;
  } else {
    // The key you hear: rounded to the nearest semitone, with the exact shift alongside.
    const heard = transposeKey(key, offset);
    const off = Math.abs(offset - Math.round(offset)) >= 0.25 ? '~' : '';
    d.keyRead.textContent = `${off}${camelot(heard)} ${keyName(heard)} ${fmtSemis(offset)}`;
    d.keyRead.title = `Track key ${keyName(key)} (${camelot(key)}), playing ${fmtSemis(offset)} semitones → ${keyName(heard)} (${camelot(heard)}).` +
      (deck.keyLock ? '' : ' Includes the pitch change from the tempo slider (key lock is off).') + ' Click to reset the key shift.';
  }
  if (noFx) d.keyRead.title = 'Key shift is still loading…';
}

function renderStems(name) {
  const deck = mixer.decks[name];
  ui[name].stems.forEach((btn) => {
    btn.classList.toggle('off', deck.stems[btn.dataset.stem] === 0);
    btn.disabled = !deck.fx;
  });
  const label = ui[name].stemLabel;
  const job = state.stemJobs.get(deck.track?.id);
  label.classList.toggle('ai', !!deck.aiStems);
  if (deck.aiStems) {
    label.textContent = 'Stems · AI';
    label.title = 'Using AI-separated stems for this track (HT-Demucs).';
  } else if (job) {
    label.textContent = job.total ? `AI ${Math.round((100 * job.done) / job.total)}%` : 'AI …';
    label.title = 'Separating this track with AI in the background — the quick DSP stems work meanwhile.';
  } else {
    label.textContent = 'Stems';
    label.title = 'Real-time DSP stems.';
  }
}

// ------------------------------------------------------------------ AI stems (prototype)

async function loadAiStems(name, trackId) {
  const deck = mixer.decks[name];
  const buffers = {};
  for (const n of AI_STEM_NAMES) {
    const data = await api.stems.read(trackId, n);
    buffers[n] = await mixer.ctx.decodeAudioData(data);
  }
  if (deck.track?.id === trackId) deck.setAiStems(buffers);
}

/** Resample to 44.1 kHz stereo for the model. */
async function toModelPcm(buffer) {
  const len = Math.ceil(buffer.duration * 44100);
  const off = new OfflineAudioContext(2, len, 44100);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  return [r.getChannelData(0), r.getChannelData(1)];
}

/** After a track loads: use cached AI stems, or separate it once in the background. */
async function prepareAiStems(name, track, buffer) {
  try {
    const st = await api.stems.status(track.id);
    if (!st.available) return; // not installed: DSP stems only
    if (st.ready) return await loadAiStems(name, track.id);
    if (state.stemJobs.has(track.id)) return;
    state.stemJobs.set(track.id, { done: 0, total: 0 });
    DECKS.forEach(renderStems);
    const [left, right] = await toModelPcm(buffer);
    await api.stems.separate(track.id, left, right);
    state.stemJobs.delete(track.id);
    for (const n of DECKS) if (mixer.decks[n].track?.id === track.id) await loadAiStems(n, track.id);
    toast(`AI stems ready for “${track.title}”.`);
  } catch (err) {
    state.stemJobs.delete(track.id);
    console.error(err);
    toast(`AI stems failed: ${cleanErr(err)} — using DSP stems.`, 'error');
  } finally {
    DECKS.forEach(renderStems);
  }
}

function matchKey(name) {
  const deck = mixer.decks[name];
  const other = mixer.decks[partnerDeck(name)];
  if (!deck.track || !other.track) return toast('Load a track on another deck to match keys with.');
  const s = deck.matchKeyTo(other);
  if (s == null) return toast('Both tracks need a detected key to match.');
  toast(`Deck ${name}: key shift ${fmtSemis(s)} semitones to blend with deck ${other.name}. Key lock is on.`);
  ui[name].keyMatch.classList.add('on');
  setTimeout(() => ui[name].keyMatch.classList.remove('on'), 500);
}

function markPlayed(name) {
  const t = mixer.decks[name].track;
  if (t?.source?.kind === 'web' && mixer.decks[name].playing) {
    state.played.set(t.id, t);
    $('#creditsCount').textContent = state.played.size;
  }
}

// ------------------------------------------------------------------ hot cues & grid

async function saveTrack(track, patch) {
  Object.assign(track, patch);
  const updated = await api.library.update(track.id, patch);
  if (updated) {
    const i = state.tracks.findIndex((t) => t.id === track.id);
    if (i !== -1) state.tracks[i] = Object.assign(state.tracks[i], patch);
  }
}

function renderHotcues(name) {
  const t = mixer.decks[name].track;
  ui[name].hotcues.forEach((btn, i) => {
    const set = t?.cues?.[i] != null;
    btn.classList.toggle('set', set);
    btn.textContent = set ? `${i + 1} · ${fmtTime(t.cues[i], true)}` : String(i + 1); // the marker's spot in the track
    btn.title = set ? `Hot cue ${i + 1} at ${fmtTime(t.cues[i], true)} (right-click to clear)` : `Set hot cue ${i + 1}`;
  });
}

function hotcue(name, i) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t) return;
  const cues = Array.isArray(t.cues) ? [...t.cues] : [null, null, null, null];
  if (cues[i] == null) {
    cues[i] = deck.snapToBeat(deck.position);
    saveTrack(t, { cues });
    renderHotcues(name);
  } else {
    deck.seek(deck.playing ? group.quantizeSeek(deck, cues[i]) : cues[i]);
    if (!deck.playing) deck.cuePoint = cues[i];
  }
}

function clearHotcue(name, i) {
  const t = mixer.decks[name].track;
  if (!t?.cues?.[i] && t?.cues?.[i] !== 0) return;
  const cues = [...t.cues];
  cues[i] = null;
  saveTrack(t, { cues });
  renderHotcues(name);
}

async function scaleBpm(name, k) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t?.bpm || !deck.buffer) return;
  const bpm = Math.round(t.bpm * k * 1000) / 1000;
  if (bpm < 40 || bpm > 300) return;
  const ch = [];
  for (let c = 0; c < deck.buffer.numberOfChannels; c++) ch.push(deck.buffer.getChannelData(c));
  const mono = mixToMono(ch);
  const fit = await analyse('fitAt', mono, deck.buffer.sampleRate, bpm).catch(() => null);
  if (deck.track !== t) return; // another track was loaded meanwhile
  const patch = { bpm: fit?.bpm ?? bpm, gridSource: 'user' };
  if (fit?.offset != null) {
    const meter = detectMeter(mono, deck.buffer.sampleRate, patch.bpm, fit.offset);
    Object.assign(patch, { beatOffset: fit.offset, beatsPerBar: meter?.beatsPerBar ?? 4, downbeat: meter ? meter.downbeat : fit.offset });
  }
  saveTrack(t, patch);
  renderTempo(name);
  renderLibrary();
  relink(name);
}

/** Track position you're hearing right now: what's rendered minus the fx node's and the device's delay. */
function heardPosition(deck) {
  const ctx = mixer.ctx;
  return Math.max(0, deck.position - (2048 / ctx.sampleRate + (ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * deck.speed);
}

function beatHere(name) {
  const deck = mixer.decks[name];
  const t = deck.track;
  if (!t?.bpm) return toast('Set a BPM first (TAP along with the beat).');
  const period = 60 / t.bpm;
  const heard = heardPosition(deck);
  const offset = ((heard % period) + period) % period;
  saveTrack(t, { beatOffset: offset, downbeat: heard, gridSource: 'user' });
  toast(`Deck ${name}: the playhead is now beat 1 of the bar.`);
  relink(name);
}

function cycleMeter(name) {
  const t = mixer.decks[name].track;
  if (!t?.bpm) return;
  saveTrack(t, { beatsPerBar: (t.beatsPerBar || 4) === 4 ? 3 : 4 });
  renderTempo(name);
}

function setupTap(name) {
  const btn = ui[name].tap;
  let taps = [];
  let timer = null;
  const tap = () => {
    const deck = mixer.decks[name];
    if (!deck.track) return;
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    btn.classList.add('tapping');
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('tapping');
      taps = [];
    }, 2200);
    if (taps.length >= 4) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = intervals.slice(-8).reduce((a, b) => a + b, 0) / Math.min(8, intervals.length);
      const tapped = 60000 / avg; // tempo as heard (includes current pitch)
      const bpm = Math.round((tapped / deck.rate) * 1000) / 1000;
      const period = 60 / bpm;
      const heard = heardPosition(deck);
      const offset = ((heard % period) + period) % period;
      // Taps mark beats, not beat 1: keep the old bar start, moved onto the nearest new beat.
      const old = deck.track.downbeat ?? offset;
      saveTrack(deck.track, { bpm, beatOffset: offset, downbeat: offset + Math.round((old - offset) / period) * period, gridSource: 'user' });
      renderTempo(name);
      renderLibrary();
      relink(name);
    }
  };
  btn.addEventListener('pointerdown', tap);
  ui[name].tapFn = tap;
}

// ------------------------------------------------------------------ loading tracks

// Analysis runs in a worker so loading never stalls the decks; the main thread is the fallback.
let analysisWorker = null;
let analysisSeq = 0;
const analysisWaiting = new Map();
try {
  analysisWorker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
  analysisWorker.onmessage = ({ data }) => {
    const job = analysisWaiting.get(data.id);
    analysisWaiting.delete(data.id);
    if (data.error) job?.reject(new Error(data.error));
    else job?.resolve(data.result);
  };
  analysisWorker.onerror = (event) => {
    event.preventDefault();
    analysisWorker.terminate();
    analysisWorker = null;
    for (const job of analysisWaiting.values()) job.reject(new Error('Track analysis stopped. Try loading the track again.'));
    analysisWaiting.clear();
  };
} catch (err) {
  console.error('Analysis worker unavailable, analysing on the main thread:', err);
}
/** op 'analyze' (tempo, meter, key), 'key', 'onsets' or 'fitAt' (re-fit the grid at a given BPM). mono is copied, not consumed. */
function analyse(op, mono, sampleRate, bpm) {
  if (!analysisWorker) {
    const run = { analyze: analyzeTrack, key: detectKey, onsets: onsetEnvelope, fitAt: fitGridAt }[op];
    return Promise.resolve(run(mono, sampleRate, bpm));
  }
  return new Promise((resolve, reject) => {
    const id = ++analysisSeq;
    analysisWaiting.set(id, { resolve, reject });
    const copy = mono.slice();
    try {
      analysisWorker.postMessage({ id, op, mono: copy, sampleRate, bpm }, [copy.buffer]);
    } catch (err) {
      analysisWaiting.delete(id);
      reject(err);
    }
  });
}
// Grids made by an older analyser are redone on load, unless you set them by hand (TAP, Beat 1, ÷2, ×2 ...).
const needsAnalysis = (t) => t.bpm == null || (t.gridVersion !== ANALYSIS_VERSION && t.gridSource !== 'user');
// Keys found by an older detector are found again.
const needsKey = (t) => t.key == null || t.keyVersion !== KEY_VERSION;

async function loadToDeck(name, trackId) {
  const deck = mixer.decks[name];
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  if (track.missing) return toast('That file is missing — it may have been moved or deleted.', 'error');

  const d = ui[name];
  const request = Symbol();
  deck.loadRequest = request;
  d.root.classList.add('loading');
  d.title.textContent = track.title;
  d.artist.textContent = 'Loading…';
  try {
    await mixer.resume();
    if (deck.loadRequest !== request) return;
    const data = await api.library.readAudio(track.id);
    if (deck.loadRequest !== request) return;
    const buffer = await mixer.ctx.decodeAudioData(data);
    if (deck.loadRequest !== request) return;
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    const mono = mixToMono(channels);
    const wave = computeWaveform(mono, buffer.sampleRate, 300);

    const patch = {};
    if (!track.duration) patch.duration = buffer.duration;
    if (needsAnalysis(track)) {
      d.artist.textContent = 'Finding the beat…';
      const { tempo, meter, key } = await analyse('analyze', mono, buffer.sampleRate);
      if (deck.loadRequest !== request) return;
      if (track.bpm) patch.gridPrev = { bpm: track.bpm, beatOffset: track.beatOffset, beatsPerBar: track.beatsPerBar, downbeat: track.downbeat };
      Object.assign(patch, { gridVersion: ANALYSIS_VERSION, gridSource: 'auto' });
      if (tempo) {
        Object.assign(patch, {
          bpm: tempo.bpm,
          beatOffset: tempo.offset,
          beatsPerBar: meter?.beatsPerBar ?? 4,
          downbeat: meter ? meter.downbeat : tempo.offset,
          bpmConfidence: tempo.confidence,
          gridRms: tempo.gridRms,
          variable: tempo.variable,
          bpmAlts: tempo.alts,
        });
      } else {
        patch.bpm = 0; // analysed, no clear beat
      }
      if (needsKey(track)) Object.assign(patch, { key: key ? key.key : -1, chroma: key?.chroma ?? null, tuning: key?.tuning ?? 0, keyVersion: KEY_VERSION }); // -1: analysed, no clear key
    } else if (needsKey(track)) {
      d.artist.textContent = 'Finding the key…';
      const key = await analyse('key', mono, buffer.sampleRate);
      if (deck.loadRequest !== request) return;
      Object.assign(patch, { key: key ? key.key : -1, chroma: key?.chroma ?? null, tuning: key?.tuning ?? 0, keyVersion: KEY_VERSION });
    }
    if (Object.keys(patch).length) await saveTrack(track, patch);
    if (deck.loadRequest !== request) return;

    state.waves[name] = wave;
    state.overviewImg[name] = null;
    deck.load(buffer, track);
    deck.onsets = null;
    // The hits Sync listens to: in the background, ready a moment after the track.
    analyse('onsets', mono, buffer.sampleRate).then((o) => {
      if (deck.track !== track || deck.loadRequest !== request) return;
      deck.onsets = o;
      // Synced before its hits were ready (Sync stays on across loads): listen now, unless it's on air.
      const quiet = !deck.playing || deck.fader.gain.value * deck.xfade.gain.value < 0.1;
      if (group.has(deck) && quiet) listenAndTell(name);
    }).catch((err) => console.error('Onsets unavailable:', err));
    state.knobs[name].forEach((k) => k.set(k.reset)); // gain, EQ and filter back to 12 o'clock
    // A fresh load starts at normal speed; keep the slider in step.
    d.tempo.value = 0;
    deck.setRate(1);
    if (deck.resync && deck.bpm) doSync(name);
    prepareAiStems(name, track, buffer); // background; DSP stems work meanwhile
  } catch (err) {
    if (deck.loadRequest !== request) return;
    console.error(err);
    toast(`Couldn't load “${track.title}”: ${cleanErr(err)}`, 'error');
    d.title.textContent = deck.track?.title || 'No track loaded';
    d.artist.textContent = deck.track?.artist || '';
  } finally {
    if (deck.loadRequest === request) {
      d.root.classList.remove('loading');
      renderDeckState(name);
    }
  }
}

function setupDeckDrop(el, name) {
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/x-cdj-track') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      el.classList.add('drag-over');
    }
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (e) => {
    el.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/x-cdj-track');
    if (id) {
      e.preventDefault();
      e.stopPropagation();
      loadToDeck(name, id);
      return;
    }
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      hideDropOverlay();
      const added = await importFiles(e.dataTransfer.files);
      if (added[0]) loadToDeck(name, added[0].id);
    }
  });
}

// ------------------------------------------------------------------ mixer UI

function buildMixer() {
  state.knobs = {};
  for (const name of DECKS) {
    const deck = mixer.decks[name];
    const strip = $(`.strip[data-deck="${name}"]`);
    $(`#deck${name} .deck-body`).append(strip); // each deck carries its own channel strip, facing the centre
    state.knobs[name] = [];
    for (const el of $$('.knob', strip)) {
      const p = el.dataset.param;
      if (p === 'trim') state.knobs[name].push(new Knob(el, { min: -12, max: 12, value: 0, bipolar: true, onChange: (v) => deck.setTrim(v) }));
      else if (p === 'filter') state.knobs[name].push(new Knob(el, { min: -1, max: 1, value: 0, bipolar: true, onChange: (v) => deck.setFilter(v) }));
      else state.knobs[name].push(new Knob(el, { min: -26, max: 6, value: 0, bipolar: true, onChange: (v) => deck.setEq(p, v) }));
    }
    const fader = $('.channel-fader', strip);
    fader.addEventListener('input', () => deck.setFader(Number(fader.value)));
  }
  const xf = $('#crossfader');
  xf.addEventListener('input', () => mixer.setCrossfader(Number(xf.value)));
  xf.addEventListener('dblclick', () => {
    xf.value = 0.5;
    mixer.setCrossfader(0.5);
  });
  const snap = $('#snapBtn');
  const setSnap = (on) => {
    snap.classList.toggle('on', on);
    snap.setAttribute('aria-pressed', String(on));
    try {
      localStorage.setItem('snap', on ? 'on' : 'off');
    } catch {}
  };
  snap.addEventListener('click', () => setSnap(!snapOn()));
  try {
    setSnap(!['off', '0'].includes(localStorage.getItem('snap')));
  } catch {}

  // 4-deck XY pad: x = left (A, C) to right (B, D), y = top (A, B) to bottom (C, D).
  const pad = $('#xyPad');
  const puck = $('.xy-puck', pad);
  let padY = 0.5;
  const placePuck = () => {
    puck.style.left = `${Number(xf.value) * 100}%`;
    puck.style.top = `${padY * 100}%`;
  };
  const setPad = (x, y) => {
    xf.value = x;
    padY = Math.min(1, Math.max(0, y));
    mixer.setCrossfader(Number(xf.value));
    mixer.setCrossfaderY(document.body.classList.contains('decks-4') ? padY : null);
    placePuck();
  };
  const fromPointer = (e) => {
    const r = pad.getBoundingClientRect();
    setPad(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), (e.clientY - r.top) / r.height);
  };
  let padDrag = false;
  pad.addEventListener('pointerdown', (e) => {
    padDrag = true;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('grabbing');
    fromPointer(e);
  });
  pad.addEventListener('pointermove', (e) => padDrag && fromPointer(e));
  const endPad = () => {
    padDrag = false;
    pad.classList.remove('grabbing');
  };
  pad.addEventListener('pointerup', endPad);
  pad.addEventListener('pointercancel', endPad);
  pad.addEventListener('dblclick', () => setPad(0.5, 0.5));
  xf.addEventListener('input', placePuck); // the arrow keys move x; keep the puck with it
  state.applyXY = () => setPad(Number(xf.value), padY);
  placePuck();

  const mv = $('#masterVol');
  mv.addEventListener('input', () => mixer.setMasterVolume(Number(mv.value)));
  mixer.setMasterVolume(Number(mv.value));

  $$('#curveSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#curveSeg button').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-checked', String(x === b));
      });
      mixer.setCurve(b.dataset.curve);
    }),
  );
}

// ------------------------------------------------------------------ drawing

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

// Three-colour waveforms (as in djay / Serato): bass, mids and highs each in their own
// colour over a faint full-signal outline. In each pixel column the loudest band is drawn
// at the back and the quietest in front (judged over a few pixels, so the order doesn't
// flicker where two bands are close), so all three always show: a kick reads as a red
// burst, a snare or voice as amber, hats as a bright core.
const BANDS = ['low', 'mid', 'high'];

/**
 * Draw a waveform across W device pixels. span(x) gives the wave columns under pixel x as
 * fractional [from, to); zoomed in past one column per pixel, levels are interpolated.
 */
function drawBands(ctx, wave, W, mid, half, span) {
  const n = wave.peak.length;
  const peak = new Path2D();
  const layers = [0, 1, 2].map(() => ({ low: new Path2D(), mid: new Path2D(), high: new Path2D() })); // back to front
  const lv = { peak: new Float32Array(W), low: new Float32Array(W), mid: new Float32Array(W), high: new Float32Array(W) };
  const v = { peak: 0, low: 0, mid: 0, high: 0 };
  for (let x = 0; x < W; x++) {
    const r = span(x);
    if (!r || r[1] <= 0 || r[0] >= n - 1) continue;
    if (r[1] - r[0] < 1) {
      const p = Math.max(0, (r[0] + r[1]) / 2 - 0.5);
      const i = Math.min(n - 2, Math.floor(p));
      const f = p - i;
      for (const k in v) v[k] = wave[k][i] + (wave[k][i + 1] - wave[k][i]) * f;
    } else {
      for (const k in v) v[k] = 0;
      for (let c = Math.max(0, Math.floor(r[0])); c < Math.min(n, Math.ceil(r[1])); c++) {
        for (const k in v) if (wave[k][c] > v[k]) v[k] = wave[k][c];
      }
    }
    for (const k in v) lv[k][x] = v[k];
  }
  const R = 4; // ordering window: ±4 px
  const sum = { low: 0, mid: 0, high: 0 };
  for (let x = -R; x < W; x++) {
    for (const b of BANDS) sum[b] += (lv[b][x + R] || 0) - (lv[b][x - R - 1] || 0);
    if (x < 0) continue;
    const hp = lv.peak[x] * half;
    if (hp >= 0.5) peak.rect(x, mid - hp, 1, hp * 2);
    BANDS.slice().sort((a, b) => sum[b] - sum[a]).forEach((band, rank) => {
      const h = lv[band][x] * half;
      if (h >= 0.5) layers[rank][band].rect(x, mid - h, 1, h * 2);
    });
  }
  ctx.fillStyle = `rgba(${INK.ink},0.1)`;
  ctx.fill(peak);
  for (const layer of layers) {
    for (const band of BANDS) {
      ctx.fillStyle = `rgb(${INK.bands[band].join(',')})`;
      ctx.fill(layer[band]);
    }
  }
}

function drawScrolling(name) {
  const canvas = $(`#wave${name}`);
  fitCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, W, H);
  const deck = mixer.decks[name];
  const wave = state.waves[name];
  const mid = H / 2;
  const cx = Math.round(W / 2);

  if (wave && deck.buffer) {
    const pos = deck.position;
    const pps = dpr / secPerCssPx(deck, canvas.clientWidth); // device pixels per track-second
    const t0 = pos - cx / pps;

    // Loop region
    if (deck.loop) {
      const x0 = cx + (deck.loop.start - pos) * pps;
      const x1 = cx + (deck.loop.end - pos) * pps;
      ctx.fillStyle = 'rgba(66,211,146,0.12)';
      ctx.fillRect(x0, 0, x1 - x0, H);
    }

    drawBands(ctx, wave, W, mid, H / 2 - 3 * dpr, (x) => [(t0 + x / pps) * wave.rate, (t0 + (x + 1) / pps) * wave.rate]);

    // Beat grid
    const t = deck.track;
    if (t?.bpm && t.beatOffset != null) {
      // Ruler: [length px, opacity] for bar, beat, ½, ¼, ⅛, ⅟₁₆ lines.
      const LEVELS = [[14, 0.6], [10, 0.38], [7, 0.26], [5, 0.19], [3.5, 0.14], [2.5, 0.1]];
      const period = 60 / t.bpm;
      const step = period / 16;
      const tEnd = t0 + W / pps;
      const bars = deck.bars;
      const minGap = 5 * dpr; // hide a level when its lines would crowd closer than this
      let n = Math.ceil((t0 - t.beatOffset) / step);
      for (; t.beatOffset + n * step < tEnd; n++) {
        const st = t.beatOffset + n * step;
        if (st < 0) continue;
        const sub = ((n % 16) + 16) % 16;
        let level = sub === 0 ? 1 : sub % 8 === 0 ? 2 : sub % 4 === 0 ? 3 : sub % 2 === 0 ? 4 : 5;
        if (level === 1 && Math.round((st - bars.downbeat) / period) % bars.beatsPerBar === 0) level = 0;
        if (level > 1 && pps * period * [0, 0, 0.5, 0.25, 0.125, 0.0625][level] < minGap) continue;
        const [len, alpha] = LEVELS[level];
        const x = Math.round(cx + (st - pos) * pps) + 0.5;
        ctx.fillStyle = `rgba(${INK.ink},${alpha})`;
        ctx.fillRect(x, 0, dpr, len * dpr);
        ctx.fillRect(x, H - len * dpr, dpr, len * dpr);
      }
    }

    // Cue + hot cues
    const marker = (time, color) => {
      const x = Math.round(cx + (time - pos) * pps);
      if (x < -10 || x > W + 10) return;
      ctx.fillStyle = color;
      ctx.fillRect(x, 0, 2 * dpr, H);
      ctx.beginPath();
      ctx.moveTo(x - 5 * dpr, 0);
      ctx.lineTo(x + 7 * dpr, 0);
      ctx.lineTo(x + dpr, 7 * dpr);
      ctx.fill();
    };
    (t?.cues || []).forEach((c, i) => c != null && marker(c, HOTCUE_COLORS[i]));
    marker(deck.cuePoint, `rgb(${INK.ink})`);

    // Shade the past.
    ctx.fillStyle = INK.light ? `rgba(${INK.ink},0.14)` : `rgba(${INK.shade},0.45)`;
    ctx.fillRect(0, 0, cx, H);
  } else {
    ctx.fillStyle = `rgba(${INK.ink},0.2)`;
    ctx.fillRect(0, mid, W, 1);
  }

  // Playhead: the deck's colour and thicker while you're dragging the track.
  const grabbed = canvas.classList.contains('grabbing');
  ctx.fillStyle = grabbed ? `rgb(${ACCENT[name].join(',')})` : `rgb(${INK.ink})`;
  ctx.fillRect(cx - (grabbed ? 2 : 1) * dpr, 0, (grabbed ? 4 : 2) * dpr, H);
}

function buildOverviewImage(name) {
  const canvas = ui[name].overview;
  const wave = state.waves[name];
  if (!wave) return null;
  const W = canvas.width;
  const H = canvas.height;
  const img = document.createElement('canvas');
  img.width = W;
  img.height = H;
  const ctx = img.getContext('2d');
  drawBands(ctx, overview(wave, W), W, H / 2, H / 2 - 2, (x) => [x, x + 1]);
  return img;
}

function drawOverview(name) {
  const canvas = ui[name].overview;
  const resized = fitCanvas(canvas);
  const deck = mixer.decks[name];
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!deck.buffer || !state.waves[name]) return;
  if (resized || !state.overviewImg[name]) state.overviewImg[name] = buildOverviewImage(name);
  ctx.drawImage(state.overviewImg[name], 0, 0);
  const dpr = window.devicePixelRatio || 1;
  const px = (t) => (t / deck.duration) * W;
  const x = px(deck.position);
  ctx.fillStyle = INK.light ? `rgba(${INK.ink},0.18)` : `rgba(${INK.shade},0.55)`;
  ctx.fillRect(0, 0, x, H);
  if (deck.loop) {
    ctx.fillStyle = 'rgba(66,211,146,0.25)';
    ctx.fillRect(px(deck.loop.start), 0, Math.max(2, px(deck.loop.end) - px(deck.loop.start)), H);
  }
  (deck.track?.cues || []).forEach((c, i) => {
    if (c == null) return;
    ctx.fillStyle = HOTCUE_COLORS[i];
    ctx.fillRect(px(c), 0, 2 * dpr, H);
  });
  ctx.fillStyle = `rgb(${INK.ink})`;
  ctx.fillRect(px(deck.cuePoint), 0, dpr, 6 * dpr);
  const grabbed = canvas.classList.contains('grabbing');
  if (grabbed) ctx.fillStyle = `rgb(${ACCENT[name].join(',')})`;
  ctx.fillRect(x - (grabbed ? 1.5 : 0.5) * dpr, 0, (grabbed ? 3 : 2) * dpr, H);
}

const meterScratch = new Float32Array(1024);
const meterPeaks = { A: -60, B: -60, C: -60, D: -60, M: -60 };

function setMeter(el, db, key) {
  const pct = Math.max(0, Math.min(1, (db + 48) / 48));
  meterPeaks[key] = Math.max(db, meterPeaks[key] - 0.6);
  const peakPct = Math.max(0, Math.min(1, (meterPeaks[key] + 48) / 48));
  const fill = $('.meter-fill', el);
  const peak = $('.meter-peak', el);
  if (el.classList.contains('meter-h')) {
    fill.style.clipPath = `inset(0 ${(1 - pct) * 100}% 0 0)`;
    peak.style.left = `calc(${peakPct * 100}% - 2px)`;
  } else {
    fill.style.clipPath = `inset(${(1 - pct) * 100}% 0 0 0)`;
    peak.style.bottom = `calc(${peakPct * 100}% - 2px)`;
  }
}

const SECONDS_PER_TURN = 60 / (100 / 3);

function frame() {
  for (const name of activeDecks()) {
    const deck = mixer.decks[name];
    const d = ui[name];
    drawScrolling(name);
    drawOverview(name);
    if (deck.buffer) {
      const pos = deck.position;
      const remain = (deck.duration - pos) / deck.rate;
      d.elapsed.textContent = fmtTime(pos, true);
      d.remain.textContent = fmtTime(-remain, true);
      d.remain.classList.toggle('ending', deck.playing && remain < 30);
      // 33⅓ rpm: one turn of the record is 1.8 s of track, so it spins with the tempo.
      d.vinyl.style.transform = `rotate(${((pos / SECONDS_PER_TURN) % 1) * 360}deg)`;
      const bars = deck.bars;
      if (bars) {
        const beats = Math.floor((pos - bars.downbeat) / (60 / deck.bpm) + 1e-6);
        const n = bars.beatsPerBar;
        d.barpos.textContent = `bar ${Math.floor(beats / n) + 1} · ${'●'.repeat(((beats % n) + n) % n + 1)}${'○'.repeat(n - 1 - (((beats % n) + n) % n))}`;
      } else d.barpos.textContent = '';
    } else {
      d.elapsed.textContent = '0:00.0';
      d.remain.textContent = '−0:00.0';
      d.remain.classList.remove('ending');
    }
    d.cue.classList.toggle('on', !deck.playing && deck.buffer && Math.abs(deck.position - deck.cuePoint) < 0.02);
    setMeter($(`.strip[data-deck="${name}"] .meter`), peakDb(deck.analyser, meterScratch), name);
  }
  setMeter($('#masterMeter'), peakDb(mixer.masterAnalyser, meterScratch), 'M');
  syncVideos();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ library

async function refreshLibrary() {
  state.tracks = await api.library.list();
  renderLibrary();
}

function renderLibrary() {
  const q = state.filter.trim().toLowerCase();
  const rows = q
    ? state.tracks.filter((t) => `${t.title} ${t.artist} ${t.source?.uploader || ''} ${keyLabel(t.key)}`.toLowerCase().includes(q))
    : state.tracks;
  const loadedOn = (t) => activeDecks().filter((n) => mixer.decks[n].track?.id === t.id).map((n) => `on-${n.toLowerCase()}`);
  $('#libCount').textContent = state.tracks.length;
  $('#libEmpty').hidden = state.tracks.length > 0;
  $('#libBody').innerHTML = rows
    .map((t) => {
      const web = t.source?.kind === 'web';
      const src = web
        ? `<span class="src cc" title="${escapeHtml(t.source.license || '')}">${escapeHtml(shortLicense(t.source.license))} · ${escapeHtml(t.source.extractor || 'web')}</span>`
        : '<span class="src local">Local file</span>';
      const cls = [t.missing ? 'missing' : '', ...loadedOn(t)].join(' ');
      return `<tr draggable="true" data-id="${t.id}" class="${cls}">
        <td>${DECKS.map((n) => `<button class="load-btn ${n.toLowerCase()}" data-load="${n}" title="Load to deck ${n}">${n}</button>`).join('')}</td>
        <td title="${escapeHtml(t.title)}"><span class="lib-thumb">${trackThumb(t) ? `<img src="${escapeHtml(trackThumb(t))}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}</span>${escapeHtml(t.title)}</td>
        <td title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</td>
        <td class="num">${t.bpm ? Number(t.bpm).toFixed(1) : ''}</td>
        <td class="c-key" title="${escapeHtml(keyName(t.key))}">${escapeHtml(camelot(t.key))} <span class="dim">${escapeHtml(keyName(t.key))}</span></td>
        <td class="num">${fmtTime(t.duration)}</td>
        <td>${src}</td>
        <td>${web ? '<button class="row-act" data-act="credit" title="Copy attribution">credit</button>' : ''}<button class="row-act" data-act="remove" title="Remove from library">✕</button></td>
      </tr>`;
    })
    .join('');
}

/** A web track's thumbnail: the one saved at download, else YouTube's standard one for the video. */
function trackThumb(t) {
  const s = t.source || {};
  if (s.kind !== 'web') return null;
  if (s.thumbnail) return s.thumbnail;
  return /youtube/i.test(s.extractor || '') && /^[\w-]{6,}$/.test(s.id || '') ? `https://i.ytimg.com/vi/${s.id}/mqdefault.jpg` : null;
}

async function removeTrack(id) {
  const t = state.tracks.find((x) => x.id === id);
  if (!t) return;
  if (DECKS.some((n) => mixer.decks[n].track?.id === id)) {
    return toast('That track is loaded on a deck.', 'error');
  }
  const web = t.source?.kind === 'web';
  const ok = confirm(web ? `Remove “${t.title}” and delete its downloaded audio?` : `Remove “${t.title}” from the library? (The file itself stays where it is.)`);
  if (!ok) return;
  await api.library.remove(id, { deleteFile: web });
  state.tracks = state.tracks.filter((x) => x.id !== id);
  renderLibrary();
}

function attribution(t) {
  const s = t.source || {};
  const by = s.uploader || t.artist || 'unknown creator';
  return `“${t.title}” by ${by} — ${s.url || ''} — ${s.license || 'license not checked'}`;
}

function setupLibrary() {
  const body = $('#libBody');
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    const load = e.target.closest('[data-load]');
    if (load) return loadToDeck(load.dataset.load, id);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'remove') return removeTrack(id);
    if (act === 'credit') {
      const t = state.tracks.find((x) => x.id === id);
      navigator.clipboard.writeText(attribution(t)).then(() => toast('Attribution copied.'));
    }
  });
  body.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr || e.target.closest('button')) return;
    // Double-click loads onto the first deck that's stopped (A, B, then C, D).
    const target = activeDecks().find((n) => !mixer.decks[n].playing);
    if (target) loadToDeck(target, tr.dataset.id);
    else toast('Every deck is playing.', 'error');
  });
  body.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    e.dataTransfer.setData('text/x-cdj-track', tr.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  const filter = $('#libFilter');
  filter.addEventListener('input', () => {
    state.filter = filter.value;
    renderLibrary();
  });

  $('#addFiles').addEventListener('click', async () => {
    const added = await api.library.importDialog();
    if (added.length) {
      await refreshLibrary();
      toast(`Added ${added.length} track${added.length > 1 ? 's' : ''}.`);
    }
  });
  $('#openFolder').addEventListener('click', () => api.library.openFolder());
}

async function importFiles(files) {
  const added = await api.library.importFiles(files);
  if (added.length) {
    await refreshLibrary();
    toast(`Added ${added.length} track${added.length > 1 ? 's' : ''}.`);
  } else if (files.length) {
    toast('Nothing new to add (unsupported or already in library).');
  }
  return added;
}

// Window-wide file drop.
let dragDepth = 0;
function hideDropOverlay() {
  dragDepth = 0;
  $('#dropOverlay').hidden = true;
}
function setupWindowDrop() {
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    $('#dropOverlay').hidden = false;
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropOverlay').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    hideDropOverlay();
    importFiles(e.dataTransfer.files);
  });
}

// ------------------------------------------------------------------ Creative Commons search

function setCcStatus(text, error = false) {
  const el = $('#ccStatus');
  el.hidden = !text;
  el.textContent = text || '';
  el.classList.toggle('error', error);
}

// Over this, a result is probably a mix rather than a single track.
const LONG_RESULT_SECONDS = 20 * 60;

function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// What exactly was searched, and what came back — so a missing video can be
// traced to the query, the result limit, or the app dropping it.
function renderCcInfo(s) {
  const el = $('#ccInfo');
  if (!s) {
    el.hidden = true;
    return;
  }
  const long = s.results.filter((r) => r.duration > LONG_RESULT_SECONDS).length;
  const live = s.results.filter((r) => !r.duration).length;
  el.innerHTML = `
    <div class="row">
      <span>“<b>${escapeHtml(s.query)}</b>” on ${state.source === 'spotify' ? 'Spotify' : 'YouTube'}</span>
      <span>showing <b>${s.results.length}</b> of <b>${s.received}</b> returned (limit ${s.limit})</span>
      ${long ? `<span class="warn">${long} over 20 min</span>` : ''}
      ${live ? `<span class="warn">${live} live / no length</span>` : ''}
      ${s.dropped.length ? `<span class="warn">${s.dropped.length} hidden</span>` : ''}
      <span>${(s.ms / 1000).toFixed(1)}s</span>
      <a class="open" data-url="${escapeHtml(s.url)}">Open on ${state.source === 'spotify' ? 'Spotify' : 'YouTube'} to compare</a>
    </div>
    <details>
      <summary>Details</summary>
      <div class="row">Filter: <b>${escapeHtml(s.filter)}</b></div>
      <div class="row"><code>${escapeHtml(s.url)}</code></div>
      ${s.dropped.map((d) => `<div class="row warn">Hidden: ${escapeHtml(d.title || d.id)} — ${escapeHtml(d.reason)}</div>`).join('')}
    </details>`;
  el.hidden = false;
}

function renderCcResults() {
  $('#ccResults').innerHTML = state.ccResults
    .map((r, i) => `
      <div class="cc-item" data-vid="${escapeHtml(r.id)}" data-i="${i}">
        <div class="thumb-wrap">
          ${r.thumbnail ? `<img src="${escapeHtml(r.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<div class="thumb"></div>'}
          ${r.rank ? `<span class="rank">#${r.rank}</span>` : ''}
          ${r.duration ? `<span class="dur ${r.duration > LONG_RESULT_SECONDS ? 'long' : ''}">${fmtDuration(r.duration)}</span>` : ''}
        </div>
        <div class="meta">
          <div class="ttl" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</div>
          <div class="sub">${escapeHtml(r.channel)} · <a class="open" data-url="${escapeHtml(r.url)}">open</a></div>
          <div class="vid">${escapeHtml(r.album || r.id)}</div>
          <div class="msg"></div>
        </div>
        <button class="btn ${r.inLibrary ? '' : 'primary'}" data-get="${escapeHtml(r.url)}" ${r.inLibrary ? 'disabled' : ''}>${r.inLibrary ? 'In library' : 'Add'}</button>
        <div class="bar"></div>
      </div>`)
    .join('');
}

// `target` is a link (YouTube etc.) or a Spotify search result, which gets matched to a YouTube upload.
async function startDownload(target, itemEl) {
  const id = jobId();
  const btn = itemEl ? $('[data-get]', itemEl) : null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Fetching…';
  }
  state.jobs.set(id, { el: itemEl, url: target.url || target });
  try {
    await (typeof target === 'string' ? api.cc.download(target, id) : api.spotify.download(target, id));
  } catch {
    // progress handler already reported the error
  } finally {
    state.jobs.delete(id);
  }
}

function onDownloadProgress(p) {
  const job = state.jobs.get(p.jobId);
  const el = job?.el;
  if (el) {
    const btn = $('[data-get]', el);
    const msg = $('.msg', el);
    const bar = $('.bar', el);
    if (p.stage === 'downloading') {
      btn.textContent = p.percent != null ? `${Math.round(p.percent)}%` : '…';
      bar.style.width = `${p.percent || 0}%`;
    } else if (p.stage === 'done') {
      btn.textContent = 'In library';
      btn.classList.remove('primary');
      bar.style.width = '100%';
      msg.textContent = '';
    } else if (p.stage === 'error') {
      btn.disabled = false;
      btn.textContent = 'Retry';
      bar.style.width = '0';
      msg.textContent = p.message;
      msg.classList.add('error');
    } else {
      btn.textContent = p.stage === 'setup' ? 'Setting up…' : 'Fetching…';
      msg.textContent = p.message || '';
      msg.classList.remove('error');
    }
  } else {
    // A pasted link (no result card): use the status line.
    if (p.stage === 'downloading') setCcStatus(`Downloading… ${p.percent != null ? Math.round(p.percent) + '%' : ''}`);
    else if (p.stage === 'error') setCcStatus(p.message, true);
    else if (p.stage === 'done') setCcStatus(`${p.message}: “${p.track?.title}”`);
    else setCcStatus(p.message || 'Working…');
  }
  if (p.stage === 'done' && p.track) {
    const isNew = !state.tracks.some((t) => t.id === p.track.id);
    if (isNew) state.tracks.unshift(p.track);
    renderLibrary();
    toast(isNew ? `Added “${p.track.title}”.` : `“${p.track.title}” is already in your library.`);
  } else if (p.stage === 'error' && !el) {
    toast(p.message, 'error');
  }
}

const SPOTIFY_TRACK_LINK = /^(https?:\/\/open\.spotify\.com\/(intl-[a-z-]+\/)?track\/|spotify:track:)/;

async function setSource(source) {
  state.source = source;
  $$('#sourceSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.source === source);
    b.setAttribute('aria-checked', String(b.dataset.source === source));
  });
  const sp = source === 'spotify';
  $('#ccQuery').placeholder = sp ? 'Search Spotify — song, artist or album' : 'Search YouTube — try “lofi beat”, “house loop”, “funk breakbeat”';
  $('#spotifyKeys').hidden = !sp || (await api.spotify.hasKeys());
  state.ccResults = [];
  renderCcResults();
  renderCcInfo(null);
  setCcStatus('');
  try {
    localStorage.setItem('searchSource', source);
  } catch {}
}

function setupCc() {
  api.cc.onProgress(onDownloadProgress);

  $('#sourceSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-source]');
    if (b && b.dataset.source !== state.source) setSource(b.dataset.source);
  });
  let saved = 'youtube';
  try {
    saved = localStorage.getItem('searchSource') === 'spotify' ? 'spotify' : 'youtube';
  } catch {}
  setSource(saved);

  $('#spotifyKeys').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.spotify.setKeys($('#spClientId').value, $('#spClientSecret').value);
      $('#spClientSecret').value = '';
      $('#spotifyKeys').hidden = true;
      toast('Spotify key saved.');
    } catch (err) {
      toast(cleanErr(err), 'error');
    }
  });
  $('#spotifyKeys').addEventListener('click', (e) => {
    const open = e.target.closest('a.open');
    if (open) api.openExternal(open.dataset.url);
  });

  $('#ccSearchForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#ccQuery').value.trim();
    if (!q) return;
    const sp = state.source === 'spotify';
    setCcStatus(`Searching ${sp ? 'Spotify' : 'YouTube'} for “${q}”…`);
    $('#ccResults').innerHTML = '';
    renderCcInfo(null);
    try {
      const search = await (sp ? api.spotify.search(q) : api.cc.search(q));
      state.ccResults = search.results;
      setCcStatus(state.ccResults.length ? '' : 'No results. Try broader words.');
      renderCcInfo(search);
      renderCcResults();
    } catch (err) {
      setCcStatus(`Search failed: ${cleanErr(err)}`, true);
    }
    refreshYtdlpChip?.();
  });

  $('#ccLinkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#ccLink').value.trim();
    if (!url) return;
    $('#ccLink').value = '';
    if (SPOTIFY_TRACK_LINK.test(url)) {
      // Show the Spotify track as a result card; its Add button does the YouTube match.
      setSource('spotify').then(() => {
        $('#ccQuery').value = url;
        $('#ccSearchForm').requestSubmit();
      });
      return;
    }
    setCcStatus('Fetching video info…');
    startDownload(url, null);
  });

  $('#ccResults').addEventListener('click', (e) => {
    const get = e.target.closest('[data-get]');
    if (get && !get.disabled) {
      const item = get.closest('.cc-item');
      return startDownload(state.source === 'spotify' ? state.ccResults[item.dataset.i] : get.dataset.get, item);
    }
    const open = e.target.closest('a.open');
    if (open) api.openExternal(open.dataset.url);
  });

  $('#ccInfo').addEventListener('click', (e) => {
    const open = e.target.closest('a.open');
    if (open) api.openExternal(open.dataset.url);
  });
}

// ------------------------------------------------------------------ top bar & dialogs

let refreshYtdlpChip = null;

async function setupYtdlpChip() {
  const chip = $('#ytdlpChip');
  const refresh = (refreshYtdlpChip = async () => {
    chip.textContent = 'yt-dlp …';
    chip.className = 'chip';
    const s = await api.ytdlp.status();
    if (s.installed) {
      chip.textContent = `yt-dlp ${s.version}`;
      chip.className = 'chip ok';
      chip.title = 'Click to check for a yt-dlp update';
    } else {
      chip.textContent = 'yt-dlp not set up';
      chip.className = 'chip warn';
      chip.title = s.error || 'It will be downloaded the first time you search.';
    }
  });
  chip.addEventListener('click', async () => {
    chip.textContent = 'Updating…';
    try {
      const msg = await api.ytdlp.update();
      toast(msg || 'yt-dlp is up to date.');
    } catch (err) {
      toast(`yt-dlp update failed: ${cleanErr(err)}`, 'error');
    }
    refresh();
  });
  refresh();
}

// AI stems: one click downloads the separation model; after that every track
// is separated once in the background and the stem buttons switch to it.
async function setupAiChip() {
  const chip = $('#aiChip');
  const render = async () => {
    const s = await api.stems.setup();
    chip.hidden = !s.runtime;
    if (s.model) {
      chip.className = 'chip ok';
      chip.textContent = `AI stems${s.provider === 'cuda' || s.provider === 'dml' ? ' · GPU' : s.provider === 'cpu' ? ' · CPU' : ''}`;
      chip.title = s.gpuModel
        ? `Studio-grade AI stems on your graphics card: ${s.gpuModel}. Each track is separated once, in the background, then cached.`
        : 'Clean AI stem separation is on. Each track is separated once, in the background, then cached.';
    } else if (!s.downloading) {
      chip.className = 'chip warn';
      chip.textContent = 'Get AI stems';
      chip.title = 'Download the HT-Demucs separation model (158 MB, from Hugging Face) for much cleaner vocals / drums / instruments.';
    }
    return s;
  };
  api.stems.onModelProgress(({ got, total }) => {
    chip.textContent = `AI stems ${Math.round((got / total) * 100)}%`;
  });
  chip.addEventListener('click', async () => {
    const s = await render();
    if (s.model || s.downloading) return;
    chip.className = 'chip';
    chip.textContent = 'AI stems 0%';
    try {
      await api.stems.downloadModel();
      toast('AI stems model installed — separating the loaded tracks.');
      for (const n of DECKS) {
        const deck = mixer.decks[n];
        if (deck.track && deck.buffer) prepareAiStems(n, deck.track, deck.buffer);
      }
    } catch (err) {
      toast(`Couldn't get the AI stems model: ${cleanErr(err)}`, 'error');
    }
    render();
  });
  state.renderAiChip = render;
  render();
}

function setupDialogs() {
  const help = $('#helpDialog');
  $('#helpBtn').addEventListener('click', () => help.showModal());
  const credits = $('#creditsDialog');
  $('#creditsBtn').addEventListener('click', () => {
    const lines = [...state.played.values()].map(attribution);
    $('#creditsText').value = lines.length ? `Music credits\n\n${lines.join('\n')}` : 'Play a Creative Commons track and it will show up here.';
    credits.showModal();
  });
  $('#copyCredits').addEventListener('click', () =>
    navigator.clipboard.writeText($('#creditsText').value).then(() => toast('Credits copied.')),
  );
}

function setupTabs() {
  $$('.tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => {
        t.classList.toggle('on', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      $$('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === tab.dataset.tab));
      $('.tab-tools[data-for="library"]').hidden = tab.dataset.tab !== 'library';
      if (tab.dataset.tab === 'cc') $('#ccQuery').focus();
    }),
  );

  // Expand: the library / search panel covers the decks. Esc goes back.
  const max = $('#browseMax');
  const setMax = (on) => {
    document.body.classList.toggle('browse-max', on);
    max.textContent = on ? 'Collapse ⤡' : 'Expand ⤢';
  };
  max.addEventListener('click', () => setMax(!document.body.classList.contains('browse-max')));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('browse-max') && !e.target.closest?.('input, textarea, select, dialog')) setMax(false);
  });
}

/**
 * Track-seconds per CSS pixel of a scrolling waveform. With a BPM, each deck shows
 * the same number of its own beats, so synced decks line up beat for beat.
 */
function secPerCssPx(deck, cssWidth) {
  return (state.span * deck.rate) / Math.max(1, cssWidth); // real time is the same for every deck: same scroll speed
}

function setupZoom() {
  // Zoom = seconds shown across the waveforms (same for every deck); eases instead of jumping.
  let target = state.span;
  const ease = () => {
    state.span += (target - state.span) * 0.25;
    if (Math.abs(target - state.span) > 0.02) requestAnimationFrame(ease);
    else state.span = target;
  };
  const setSpan = (s) => {
    const settled = Math.abs(target - state.span) <= 0.02;
    target = Math.max(2, Math.min(64, s));
    $$('#beatsSeg button').forEach((x) => x.classList.toggle('on', Number(x.dataset.span) === target));
    try {
      localStorage.setItem('secondsShown', String(target));
    } catch {}
    if (settled) requestAnimationFrame(ease);
  };
  const zoomBy = (f) => setSpan(Math.round(target / f));
  $$('#beatsSeg button').forEach((b) => b.addEventListener('click', () => setSpan(Number(b.dataset.span))));
  try {
    const saved = Number(localStorage.getItem('secondsShown'));
    if (saved) setSpan(saved);
  } catch {}
  $('#zoomIn').addEventListener('click', () => zoomBy(2)); // half the time across
  $('#zoomOut').addEventListener('click', () => zoomBy(1 / 2));

  // Grab a waveform or a record to scratch: playback stops under your hand, the
  // track plays at the speed and direction you move it, and picks up where you
  // let go. A paused deck keeps gliding after a flick.
  // Wheel / trackpad scrolls the track; Ctrl + wheel zooms.
  DECKS.forEach((name) => {
    const canvas = $(`#wave${name}`);
    const deck = mixer.decks[name];
    const secPerPx = () => secPerCssPx(deck, canvas.clientWidth);

    // Shared hand: `toPos(e)` maps a pointer event to a track position.
    const grabbable = (el, start, toPos) => {
      let drag = null;
      let glide = 0;
      el.addEventListener('pointerdown', (e) => {
        if (!deck.buffer || e.button !== 0) return;
        cancelAnimationFrame(glide);
        el.setPointerCapture(e.pointerId);
        mixer.resume();
        drag = { ...start(e), wasPlaying: deck.scratchStart(), v: 0, t: e.timeStamp, last: deck.position };
        el.classList.add('grabbing');
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const pos = toPos(e, drag);
        const dt = Math.max(1, e.timeStamp - drag.t);
        drag.v = 0.7 * drag.v + 0.3 * ((pos - drag.last) / dt); // track-seconds per ms, smoothed
        drag.t = e.timeStamp;
        drag.last = pos;
        deck.scratchTo(pos);
      });
      const release = (e) => {
        if (!drag) return;
        const { wasPlaying, v, t } = drag;
        drag = null;
        el.classList.remove('grabbing');
        // Flick on a paused deck: keep moving with friction. Holding still before letting go means no glide.
        let vel = wasPlaying || e.timeStamp - t > 80 ? 0 : v * 16; // track-seconds per frame
        const step = () => {
          vel *= 0.92;
          if (Math.abs(vel) < 0.002 || deck.playing || !deck.scratching) {
            deck.scratchEnd(false);
            return snapDeck(name);
          }
          deck.scratchTo(deck.position + vel);
          glide = requestAnimationFrame(step);
        };
        if (vel) glide = requestAnimationFrame(step);
        else {
          // Snap while still held, so a playing deck comes back in on the beat with no extra jump.
          if (snapOn()) deck.scratchTo(deck.pausedPos + deck.beatSnap(deck.pausedPos, mixer.decks[partnerDeck(name)], snapDiv(name)));
          deck.scratchEnd(wasPlaying);
        }
      };
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
    };

    // Waveform: the track moves with your hand, left = forwards.
    grabbable(canvas, (e) => ({ x: e.clientX, pos: deck.position }), (e, d) => d.pos - (e.clientX - d.x) * secPerPx());

    // Record: turning it clockwise plays forwards, one turn = 1.8 s of track (33⅓ rpm).
    const platter = $(`#deck${name} .platter`);
    const angle = (e) => {
      const r = platter.getBoundingClientRect();
      return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
    };
    grabbable(
      platter,
      (e) => ({ a: angle(e), turned: 0, pos: deck.position }),
      (e, d) => {
        const a = angle(e);
        let da = a - d.a;
        if (da > Math.PI) da -= 2 * Math.PI; // unwrap across ±180°
        if (da < -Math.PI) da += 2 * Math.PI;
        d.a = a;
        d.turned += da;
        return d.pos + (d.turned / (2 * Math.PI)) * SECONDS_PER_TURN;
      },
    );

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) return zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25);
      if (!deck.buffer) return;
      const px = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      deck.seek(deck.position + px * secPerPx());
    }, { passive: false });
  });
}

// ------------------------------------------------------------------ keyboard

function setupKeyboard() {
  const held = new Set();
  // Any text box (inputs without a type attribute too, like the Spotify key fields).
  const typing = (e) => e.target.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select');
  let spacePaused = []; // decks the space bar stopped, so the next press brings back just those
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape' && typing(e)) e.target.blur();
      return;
    }
    const k = e.key.toLowerCase();
    const A = mixer.decks.A;
    const B = mixer.decks.B;
    const xf = $('#crossfader');
    const setXf = (v) => {
      xf.value = v;
      mixer.setCrossfader(v);
      state.applyXY?.(); // keeps the 4-deck puck in step
    };
    const hotA = { '1': 0, '2': 1, '3': 2, '4': 3 };
    const hotB = { '7': 0, '8': 1, '9': 2, '0': 3 };
    let handled = true;
    if (e.code === 'Space') {
      if (e.repeat) return e.preventDefault();
      // Space: pause everything that's playing. Press again to start the decks it paused,
      // plus every tempo-locked (synced) deck, all in the same instant so they start in step.
      const playing = DECKS.filter((n) => mixer.decks[n].playing);
      if (playing.length) {
        playing.forEach((n) => mixer.decks[n].pause());
        spacePaused = playing;
      } else {
        // They're already in step: skip snap-on-play, which would nudge the first one before the rest start.
        // Synced decks start through the clock (the first one re-anchors it, the rest land on its beat).
        state.startingTogether = true;
        const synced = DECKS.filter((n) => group.has(mixer.decks[n]));
        const start = [...new Set([...spacePaused, ...synced])].filter((n) => mixer.decks[n].buffer && activeDecks().includes(n));
        start.sort((x, y) => spacePaused.includes(y) - spacePaused.includes(x)); // the decks that were playing lead
        start.forEach((n) => {
          togglePlay(n);
          markPlayed(n);
        });
        state.startingTogether = false;
        spacePaused = [];
      }
      return e.preventDefault();
    }
    if (k === 'x') { togglePlay('A'); markPlayed('A'); }
    else if (k === 'z') A.cue();
    else if (k === 'c') doSync('A');
    else if (k === ',') { togglePlay('B'); markPlayed('B'); }
    else if (k === 'm') B.cue();
    else if (k === '.') doSync('B');
    else if (e.code.startsWith('Digit') && e.code.slice(5) in hotA && !e.shiftKey) hotcue('A', hotA[e.code.slice(5)]);
    else if (e.code.startsWith('Digit') && e.code.slice(5) in hotA && e.shiftKey) clearHotcue('A', hotA[e.code.slice(5)]);
    else if (e.code.startsWith('Digit') && e.code.slice(5) in hotB) (e.shiftKey ? clearHotcue : hotcue)('B', hotB[e.code.slice(5)]);
    else if (['q', 'w', 'o', 'p'].includes(k)) {
      if (!held.has(k)) {
        held.add(k);
        const deck = k === 'q' || k === 'w' ? A : B;
        deck.bend(k === 'q' || k === 'o' ? -0.04 : 0.04);
      }
    } else if (e.key === 'ArrowLeft') setXf(e.shiftKey ? 0 : Math.max(0, Number(xf.value) - 0.05));
    else if (e.key === 'ArrowRight') setXf(e.shiftKey ? 1 : Math.min(1, Number(xf.value) + 0.05));
    else if (e.key === '/') { $$('.tab')[0].click(); $('#libFilter').focus(); }
    else if (e.key === '?') $('#helpDialog').showModal();
    else handled = false;
    if (handled) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (held.has(k)) {
      held.delete(k);
      (k === 'q' || k === 'w' ? mixer.decks.A : mixer.decks.B).endBend();
    }
  });
  window.addEventListener('blur', () => {
    held.clear();
    for (const d of Object.values(mixer.decks)) d.endBend();
  });
}

// ------------------------------------------------------------------ boot

// Themes. Canvas colours here must match each theme's --a / --b / --bg in styles.css.
const THEMES = {
  dark: { A: [255, 138, 61], B: [66, 182, 255], C: [181, 123, 255], D: [163, 230, 53], ink: '237,237,240', shade: '11,11,13', hi: [176, 180, 190],
    bands: { low: [240, 62, 98], mid: [255, 178, 82], high: [238, 238, 246] } },
  aloe: { light: true, A: [228, 87, 46], B: [28, 127, 196], C: [123, 79, 214], D: [77, 143, 16], ink: '18,48,28', shade: '251,254,251', hi: [96, 130, 108],
    bands: { low: [208, 36, 72], mid: [226, 142, 30], high: [52, 60, 72] } },
  mist: { light: true, A: [212, 98, 47], B: [47, 109, 176], C: [118, 86, 194], D: [79, 132, 32], ink: '30,37,45', shade: '231,233,236', hi: [104, 112, 122],
    bands: { low: [196, 42, 76], mid: [212, 134, 34], high: [44, 52, 62] } },
  cherry: { A: [255, 59, 92], B: [255, 163, 192], C: [201, 160, 255], D: [255, 209, 102], ink: '253,238,242', shade: '39,16,26', hi: [214, 168, 182],
    bands: { low: [255, 59, 92], mid: [255, 196, 120], high: [255, 225, 235] } },
};
function setTheme(name) {
  const t = THEMES[name] ? name : 'dark';
  document.body.dataset.theme = t;
  for (const n of DECKS) ACCENT[n] = THEMES[t][n];
  Object.assign(INK, { ink: THEMES[t].ink, shade: THEMES[t].shade, hi: THEMES[t].hi, bands: THEMES[t].bands, light: !!THEMES[t].light });
  DECKS.forEach((n) => (state.overviewImg[n] = null)); // redraw overviews in the new colours
  $$('.theme-card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.theme === t)));
  try {
    localStorage.setItem('theme', t);
    localStorage.removeItem('bg'); // old background-picture setting (could be MBs)
  } catch {}
}
/** 2 or 4 decks. Going back to 2 stops C and D (they'd keep playing out of sight). */
/**
 * Scale the whole UI with the window: one page zoom factor, so a small window
 * shrinks everything to fit (nothing gets cut off) and a big one enlarges it.
 * The reference layout is about 1340×930 (2 decks) or 1340×1090 (4 decks) at 100%.
 */
// The middle (video, crossfader / XY pad) sits over the decks' inner edges: every deck
// row it overlaps gives way on that side, so nothing hides under it.
const roundRect = (x1, y1, x2, y2, r) =>
  `M${x1 + r} ${y1}H${x2 - r}A${r} ${r} 0 0 1 ${x2} ${y1 + r}V${y2 - r}A${r} ${r} 0 0 1 ${x2 - r} ${y2}H${x1 + r}A${r} ${r} 0 0 1 ${x1} ${y2 - r}V${y1 + r}A${r} ${r} 0 0 1 ${x1 + r} ${y1}Z`;
function fitNotch() {
  const g = 8; // gap between the middle panel and the decks
  const b = $('.mixer').getBoundingClientRect();
  const m = { left: b.left - g, right: b.right + g, top: b.top - g, bottom: b.bottom + g };
  for (const deck of $$('.console > .deck')) {
    const left = deck.dataset.deck === 'A' || deck.dataset.deck === 'C';
    // Cut the middle panel's footprint (plus the gap) out of the deck itself.
    const d = deck.getBoundingClientRect();
    const x1 = Math.max(-30, m.left - d.left), x2 = Math.min(d.width + 30, m.right - d.left);
    const y1 = Math.max(-30, m.top - d.top), y2 = Math.min(d.height + 30, m.bottom - d.top);
    deck.style.clipPath = x2 > x1 && y2 > y1 && deck.offsetParent
      ? `path(evenodd, 'M-40 -40H${d.width + 40}V${d.height + 40}H-40Z ${roundRect(x1, y1, x2, y2, 22)}')`
      : '';
    for (const row of [deck.querySelector('.deck-head'), ...deck.querySelector('.deck-main').children]) {
      row.style.marginLeft = row.style.marginRight = row.style.maxWidth = '';
      if (deck.offsetParent === null) continue;
      const r = row.getBoundingClientRect();
      const give = r.bottom > m.top && r.top < m.bottom ? (left ? r.right - m.left : m.right - r.left) : 0;
      if (give <= 0) continue;
      row.style[left ? 'marginRight' : 'marginLeft'] = give + 'px';
      row.style.maxWidth = `calc(100% - ${give}px)`; // the overview canvas is width: 100%
    }
  }
}
{
  let queued = false;
  const ro = new ResizeObserver(() => {
    if (!queued) requestAnimationFrame(() => ((queued = false), fitNotch()));
    queued = true;
  });
  ro.observe($('.console'));
  ro.observe($('.mixer'));
}

function fitToWindow() {
  const z = api.zoom.get();
  const w = window.innerWidth * z; // window size in unzoomed pixels
  const h = window.innerHeight * z;
  // Decks and mixer need ~670 px (830 with 4 decks); the library / search list gets state.browserH on top.
  const tall = (document.body.classList.contains('decks-4') ? 902 : 764) + state.browserH;
  const f = Math.max(0.55, Math.min(1.6, w / 1340, h / tall));
  if (Math.abs(f - z) > 0.01) api.zoom.set(Math.round(f * 100) / 100);
}
window.addEventListener('resize', () => requestAnimationFrame(fitToWindow));

// The grip on top of the library / search: drag up for a longer list (the rest scales down to fit).
state.browserH = 330;
try {
  state.browserH = Math.min(560, Math.max(200, Number(localStorage.getItem('browserH')) || 330));
} catch {}
document.documentElement.style.setProperty('--browser-h', state.browserH + 'px');
{
  const grip = $('.browser-grip');
  const setH = (h) => {
    state.browserH = Math.round(Math.min(560, Math.max(200, h)));
    document.documentElement.style.setProperty('--browser-h', state.browserH + 'px');
    fitToWindow();
    try {
      localStorage.setItem('browserH', String(state.browserH));
    } catch {}
  };
  let from = null;
  grip.addEventListener('pointerdown', (e) => {
    grip.setPointerCapture(e.pointerId);
    from = { y: e.clientY * api.zoom.get(), h: state.browserH }; // window pixels: stable while the zoom changes
    grip.classList.add('grabbing');
  });
  // Moves and release are watched on the window, so a fast drag that leaves the thin grip still counts.
  window.addEventListener('pointermove', (e) => from && setH(from.h + (from.y - e.clientY * api.zoom.get()) / api.zoom.get()));
  const end = () => {
    if (!from) return;
    from = null;
    grip.classList.remove('grabbing');
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => setH(330));
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      setH(state.browserH + (e.key === 'ArrowUp' ? 40 : -40));
    }
  });
}

function setDeckCount(n) {
  const four = n === 4;
  document.body.classList.toggle('decks-4', four);
  $$('#deckCountSeg button').forEach((b) => {
    const on = Number(b.dataset.decks) === (four ? 4 : 2);
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  if (!four) for (const name of ['C', 'D']) {
    if (mixer.decks[name].playing) mixer.decks[name].pause();
    group.leave(mixer.decks[name]);
  }
  state.applyXY?.(); // up/down only counts with four decks
  fitToWindow(); // 4 decks need more height
  renderLibrary();
  try {
    localStorage.setItem('deckCount', four ? '4' : '2');
  } catch {}
}

/** Font setting: Arial (default), Segoe UI, Playfair Display, Dancing Script, monospace. */
function setFont(name) {
  const f = ['arial', 'segoe', 'playfair', 'script', 'mono'].includes(name) ? name : 'arial';
  if (f === 'arial') delete document.body.dataset.font;
  else document.body.dataset.font = f;
  $$('.font-card').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.font === f)));
  try {
    localStorage.setItem('font', f);
  } catch {}
}

function setupSettings() {
  const dlg = $('#settingsDialog');
  $$('.font-card').forEach((b) => b.addEventListener('click', () => setFont(b.dataset.font)));
  // Music videos: Show / Hide (hiding also pauses them).
  const setMv = (on) => {
    document.body.classList.toggle('no-mv', !on);
    $$('#mvSeg button').forEach((b) => {
      b.classList.toggle('on', (b.dataset.mv === 'on') === on);
      b.setAttribute('aria-checked', String((b.dataset.mv === 'on') === on));
    });
    if (!on) mvScreen.video?.pause();
    try {
      localStorage.setItem('musicVideos', on ? 'on' : 'off');
    } catch {}
  };
  $$('#mvSeg button').forEach((b) => b.addEventListener('click', () => setMv(b.dataset.mv === 'on')));
  try {
    setMv(localStorage.getItem('musicVideos') !== 'off');
  } catch {
    setMv(true);
  }
  try {
    setFont(localStorage.getItem('font') || 'arial');
  } catch {
    setFont('arial');
  }
  $('#settingsBtn').addEventListener('click', () => dlg.showModal());
  $$('.theme-card').forEach((c) => c.addEventListener('click', () => setTheme(c.dataset.theme)));
  $$('#deckCountSeg button').forEach((b) => b.addEventListener('click', () => setDeckCount(Number(b.dataset.decks))));

  // Master volume: the same value as the top-bar slider, kept in step both ways.
  const top = $('#masterVol');
  const vol = $('#setVolume');
  vol.value = top.value;
  vol.addEventListener('input', () => {
    top.value = vol.value;
    top.dispatchEvent(new Event('input'));
  });
  top.addEventListener('input', () => (vol.value = top.value));

  // Fullscreen (also F11).
  const fs = $('#setFullscreen');
  const toggleFs = async () => {
    const full = await api.toggleFullscreen();
    fs.textContent = full ? 'Exit fullscreen (F11)' : 'Enter fullscreen (F11)';
  };
  fs.addEventListener('click', toggleFs);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFs();
    }
  });

  // Output device: AudioContext.setSinkId routes the whole mix (decks + SFX).
  const out = $('#setOutput');
  const listOutputs = async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const current = out.value;
    out.innerHTML = '<option value="">System default</option>' + devices.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Output ${i + 1}`)}</option>`).join('');
    out.value = [...out.options].some((o) => o.value === current) ? current : '';
  };
  const useOutput = async (id) => {
    try {
      await mixer.ctx.setSinkId(id);
      localStorage.setItem('outputDevice', id);
    } catch (err) {
      toast(`Couldn't switch output: ${cleanErr(err)}`, 'error');
      out.value = '';
    }
  };
  out.addEventListener('change', () => useOutput(out.value));
  navigator.mediaDevices.addEventListener('devicechange', listOutputs);
  $('#settingsBtn').addEventListener('click', listOutputs);
  listOutputs().then(() => {
    let saved = '';
    try {
      saved = localStorage.getItem('outputDevice') || '';
    } catch {}
    if (saved && [...out.options].some((o) => o.value === saved)) {
      out.value = saved;
      useOutput(saved);
    }
  });
  try {
    setDeckCount(localStorage.getItem('deckCount') === '4' ? 4 : 2);
  } catch {
    setDeckCount(2);
  }
  let saved = 'dark';
  try {
    saved = localStorage.getItem('theme') || 'dark';
  } catch {}
  setTheme(saved);
}

DECKS.forEach(buildDeck);
buildMixer();
setupLibrary();
setupWindowDrop();
setupCc();
setupDialogs();
setupTabs();
setupZoom();
setupKeyboard();
setupYtdlpChip();
setupAiChip();
setupVideoScreen();
setupSettings();
setupSfx();
DECKS.forEach((n) => {
  renderTempo(n);
  renderHotcues(n);
  renderKey(n);
  renderStems(n);
});
api.stems.onProgress(({ trackId, done, total }) => {
  if (!state.stemJobs.has(trackId)) return;
  state.stemJobs.set(trackId, { done, total });
  DECKS.forEach(renderStems);
  if (done === 1) state.renderAiChip?.(); // shows GPU / CPU once the model is running
});
mixer.fxReady.then((ok) => {
  if (!ok) toast('Key shift and stems couldn’t start on this computer — decks still play normally.', 'error');
});
refreshLibrary();
requestAnimationFrame(frame);

// Browsers start audio suspended until a user gesture.
window.addEventListener('pointerdown', () => mixer.resume(), { once: true });
window.addEventListener('keydown', () => mixer.resume(), { once: true });
