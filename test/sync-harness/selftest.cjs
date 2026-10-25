// Checks the harness's own maths without Electron: node test/sync-harness/selftest.cjs
'use strict';
const assert = require('node:assert');
const { detectClick, align, gridVsHeard } = require('./measure.cjs');
const { SR, TRACKS, beats, clickWav } = require('./wav.cjs');

// 1. Clicks from the WAV, resampled to 192 kHz at rate 1.05 (as a deck would play them),
//    are found within 20 µs of beat / rate.
const t = TRACKS[1], wav = clickWav(t, 6);
const pcm = new Float32Array((wav.length - 44) / 2).map((_, i) => wav.readInt16LE(44 + i * 2) / 32767);
const out = 192000, rate = 1.05;
const y = new Float32Array(Math.floor((pcm.length / SR / rate) * out)).map((_, i) => {
  const p = (i / out) * rate * SR, k = Math.floor(p);
  return (pcm[k] || 0) + ((pcm[k + 1] || 0) - (pcm[k] || 0)) * (p - k);
});
for (const b of beats(t, 5.9)) {
  const h = b.t / rate, s = Math.round((h - 0.01) * out); // window starts 10 ms before, like the recorder
  const c = detectClick(y.subarray(Math.max(0, s), s + 0.04 * out), out);
  assert(Math.abs(Math.max(0, s) / out + c.t - h) < 20e-6, `click at ${h}: off by ${(Math.max(0, s) / out + c.t - h) * 1e6} µs`);
  assert(b.down ? c.peak > 0.7 : c.peak < 0.5, 'downbeats are louder');
}

// 2. Alignment: follower 3 ms late, drifting +1 ms/min, against a leader with a ½-tempo follower too.
const P = 60 / 128, L = [], F = [], H = [];
for (let k = 0; k < 400; k++) L.push({ t: k * P, peak: k % 4 ? 0.5 : 0.9 });
for (let k = 0; k < 400; k++) F.push({ t: k * P + 0.003 + (k * P) / 60000, peak: k % 4 ? 0.5 : 0.9 });
for (let k = 0; k < 200; k++) H.push({ t: 2 * k * P + 0.002, peak: k % 4 ? 0.5 : 0.9 });
const all = [{ label: 'all', from: 0, to: 1e9 }];
const a = align(L, F, all);
assert(Math.abs(a.mean - 3 - (199.5 * P) / 60) < 0.05 && Math.abs(a.slope - 1) < 1e-3 && a.barMatch === 1, JSON.stringify(a));
const h = align(L, H, all);
assert(Math.abs(h.p50 - 2) < 1e-6 && h.max < 2.001, JSON.stringify(h));
const d = align(H.map((c) => ({ ...c, t: c.t - 0.002 })), F, all); // double-time follower: off-beats count too
assert(d.n > 390 && Math.abs(d.mean - a.mean) < 0.05 && d.barMatch === 0.5, JSON.stringify(d)); // its downbeats fall on every other leader bar

// 3. Heard vs predicted: clicks 10.67 ms after where position says.
const snaps = [], heard = [];
for (let s = 0; s < 10; s += 0.01) snaps.push([s, 0.05 + s * 1.01, 1.01, 1]);
for (const b of beats(t, 9)) heard.push({ t: (b.t - 0.05) / 1.01 + 0.01067 });
const g = gridVsHeard(heard, snaps, t);
assert(Math.abs(g.medianMs - 10.67) < 1e-6 && g.p95DevMs < 1e-6, JSON.stringify(g));

console.log('sync-harness selftest ok');
