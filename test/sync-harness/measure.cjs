// Measurement maths for the sync harness. Pure functions, no Electron: run.cjs uses them
// in the main process, and injects detectClick into the renderer via toString().
'use strict';

/**
 * Centre of one click (a 1 ms Hann-windowed burst) in a captured window, in seconds from
 * the window start. Cross-correlates the window's energy with the burst's envelope energy
 * (carrier-free, so resampling and key-lock phase changes don't pull it to a neighbouring
 * cycle), then refines the peak by parabolic interpolation.
 */
function detectClick(x, sr) {
  const n = Math.round(0.001 * sr);
  const tpl = new Float32Array(n);
  for (let j = 0; j < n; j++) tpl[j] = (0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (n - 1))) ** 2;
  let im = 0, peak = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > peak) { peak = Math.abs(x[i]); im = i; }
  const corr = (lag) => { let s = 0; for (let j = 0; j < n; j++) { const v = x[lag + j] || 0; s += v * v * tpl[j]; } return s; };
  const lo = Math.max(0, im - 2 * n), hi = Math.min(x.length - n, im + n);
  let best = lo, bv = -1;
  for (let l = lo; l <= hi; l++) { const v = corr(l); if (v > bv) { bv = v; best = l; } }
  const a = best > 0 ? corr(best - 1) : bv, c = corr(best + 1);
  const den = a - 2 * bv + c;
  const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { t: (best + d + (n - 1) / 2) / sr, peak };
}

const quant = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/** n, p50/p95/max |e| (ms), signed mean and drift slope (ms/min, least squares of e over time). */
function stats(pts) {
  if (!pts.length) return { n: 0 };
  const abs = pts.map((p) => Math.abs(p.e)).sort((a, b) => a - b);
  const mt = pts.reduce((s, p) => s + p.t, 0) / pts.length, me = pts.reduce((s, p) => s + p.e, 0) / pts.length;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.t - mt) * (p.e - me); sxx += (p.t - mt) ** 2; }
  return { n: pts.length, p50: r3(quant(abs, 0.5)), p95: r3(quant(abs, 0.95)), max: r3(abs[abs.length - 1]), mean: r3(me), slope: sxx > 0 ? r3((sxy / sxx) * 60) : null };
}

/**
 * Alignment error of each follower click against the leader's grid in heard time (ms,
 * + = follower late). The leader grid between two of its clicks is the interval split
 * into q steps, q = how many follower beats fit in one leader beat (1 for equal or
 * half tempo), so a double-time follower is measured against the leader's off-beats too.
 * Also reports how many follower downbeats (loud clicks) land on a leader downbeat.
 */
function align(leader, follower, windows) {
  const L = leader.map((c) => c.t), out = [];
  const loud = (cs) => { const p = cs.map((c) => c.peak).sort((a, b) => a - b); const med = quant(p, 0.5) || 0; return (c) => c.peak > 1.35 * med; };
  const lLoud = loud(leader), fLoud = loud(follower);
  const F = follower.map((c) => c.t);
  let m = 0;
  for (let i = 0; i < follower.length; i++) {
    const f = follower[i];
    if (!windows.some((w) => f.t >= w.from && f.t <= w.to)) continue;
    while (m + 1 < L.length && L[m + 1] <= f.t) m++;
    if (m + 1 >= L.length || L[m] > f.t) continue;
    const gap = L[m + 1] - L[m];
    const lPrev = m > 0 ? L[m] - L[m - 1] : gap;
    if (gap > 1.6 * lPrev) continue; // leader stopped or paused here: nothing to compare with
    // The longer neighbouring interval: a jump makes one interval short, never both.
    const fi = F.length < 2 ? gap : Math.max(i > 0 ? F[i] - F[i - 1] : 0, i + 1 < F.length ? F[i + 1] - F[i] : 0);
    const q = Math.max(1, Math.round(gap / fi));
    const step = gap / q, j = Math.round((f.t - L[m]) / step);
    const e = f.t - (L[m] + j * step);
    const onBeat = j === 0 ? m : j === q ? m + 1 : -1;
    out.push({ t: f.t, e: e * 1000, down: fLoud(f), onDown: onBeat >= 0 && lLoud(leader[onBeat]) });
  }
  // Totals over the measured windows; `info` windows (e.g. before Sync) are only listed.
  const main = out.filter((p) => windows.some((w) => !w.info && p.t >= w.from && p.t <= w.to));
  const res = stats(main);
  const downs = main.filter((p) => p.down);
  if (downs.length) res.barMatch = r3(downs.filter((p) => p.onDown).length / downs.length);
  res.windows = windows.map((w) => ({ label: w.label, ...(w.info && { info: true }), ...stats(out.filter((p) => p.t >= w.from && p.t <= w.to)) }));
  return res;
}

/**
 * Heard minus position-predicted time for each click (ms): the deck's position snapshot
 * just before the click, extrapolated at its speed to the nearest grid beat. A constant
 * (the fx worklet's 2048-sample delay) is expected; spread or a per-deck difference means
 * the audio is scheduled differently from what `position` claims.
 */
function gridVsHeard(clicks, snaps, grid) {
  const P = 60 / grid.bpm, d = [];
  let s = 0;
  for (const c of clicks) {
    while (s + 1 < snaps.length && snaps[s + 1][0] <= c.t - 0.003) s++;
    const [t, pos, speed, playing] = snaps[s] || [];
    if (!playing || t > c.t - 0.003 || c.t - t > 0.06 || !speed) continue;
    const est = pos + (c.t - t) * speed;
    const beat = grid.beatOffset + Math.round((est - grid.beatOffset) / P) * P;
    d.push((c.t - (t + (beat - pos) / speed)) * 1000);
  }
  if (!d.length) return { n: 0 };
  const sorted = [...d].sort((a, b) => a - b), med = quant(sorted, 0.5);
  const dev = d.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return { n: d.length, medianMs: r3(med), p95DevMs: r3(quant(dev, 0.95)), maxDevMs: r3(dev[dev.length - 1]) };
}

module.exports = { detectClick, stats, align, gridVsHeard };
