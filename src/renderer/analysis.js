// Track analysis: waveform peaks and tempo/beat-grid detection.
// Pure functions over raw sample data so they can be tested outside the app.

/** Mix all channels down to one Float32Array. */
export function mixToMono(channels) {
  const len = channels[0].length;
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(len);
  const scale = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < len; i++) out[i] += ch[i] * scale;
  }
  return out;
}

/**
 * Waveform data at `rate` columns per second.
 * peak: max absolute amplitude per column (0..1)
 * low / mid / high: peak level of each band (below ~200 Hz, between, above ~2.5 kHz) per
 * column (0..1), for the three-colour waveforms: kicks, snares and voices, hats and cymbals.
 */
export function computeWaveform(mono, sampleRate, rate = 150) {
  const hop = Math.max(1, Math.round(sampleRate / rate));
  const cols = Math.ceil(mono.length / hop);
  const peak = new Float32Array(cols);
  const low = new Float32Array(cols);
  const mid = new Float32Array(cols);
  const high = new Float32Array(cols);
  const a = 1 - Math.exp((-2 * Math.PI * 200) / sampleRate); // one-pole low-pass at 200 Hz
  const aHi = 1 - Math.exp((-2 * Math.PI * 2500) / sampleRate); // one-pole low-pass at 2.5 kHz
  let lp = 0;
  let lp2 = 0; // second pole: a steeper bass band, so kicks stand apart from the mids
  let lpHi = 0;
  for (let c = 0; c < cols; c++) {
    const start = c * hop;
    const end = Math.min(start + hop, mono.length);
    let max = 0;
    let pl = 0;
    let pm = 0;
    let ph = 0;
    for (let i = start; i < end; i++) {
      const s = mono[i];
      lp += a * (s - lp);
      lp2 += a * (lp - lp2);
      lpHi += aHi * (s - lpHi);
      const abs = s < 0 ? -s : s;
      if (abs > max) max = abs;
      const l = Math.abs(lp2);
      const h = Math.abs(s - lpHi);
      const m = Math.abs(lpHi - lp2);
      if (l > pl) pl = l;
      if (m > pm) pm = m;
      if (h > ph) ph = h;
    }
    peak[c] = max > 1 ? 1 : max;
    low[c] = Math.min(1, pl);
    mid[c] = Math.min(1, pm);
    high[c] = Math.min(1, ph);
  }
  return { rate: sampleRate / hop, peak, low, mid, high };
}

/** Downsample waveform peaks to a fixed number of columns (for the overview). */
export function overview(wave, columns) {
  const out = new Float32Array(columns);
  const bands = { low: new Float32Array(columns), mid: new Float32Array(columns), high: new Float32Array(columns) };
  const n = wave.peak.length;
  for (let c = 0; c < columns; c++) {
    const start = Math.floor((c * n) / columns);
    const end = Math.max(start + 1, Math.floor(((c + 1) * n) / columns));
    let max = 0;
    for (let i = start; i < end && i < n; i++) {
      if (wave.peak[i] > max) max = wave.peak[i];
      for (const k in bands) if (wave[k][i] > bands[k][c]) bands[k][c] = wave[k][i];
    }
    out[c] = max;
  }
  return { peak: out, ...bands };
}

const TARGET_ENV_RATE = 200; // onset envelope frames per second (approx.)

/** Bumped when the grid maths change, so the app knows which stored grids to re-analyse. */
export const ANALYSIS_VERSION = 2;
/** Bumped when key detection changes, so stored keys (and chroma) are found again. */
export const KEY_VERSION = 3;

// Seconds added to a measured onset so a kick's attack sample is the beat (frames are
// timestamped at their centre; the log-energy rise still peaks a little after the attack).
// Calibrated by test/analysis.test.mjs on synthetic kicks.
const ONSET_BIAS = -0.0008;

/** 1 s moving-average detrend, then half-wave rectify, so loud sections don't dominate. */
function detrend(x, win) {
  const out = new Float32Array(x.length);
  let acc = 0;
  for (let f = 0; f < x.length; f++) {
    acc += x[f];
    if (f >= win) acc -= x[f - win];
    const v = x[f] - acc / Math.min(f + 1, win);
    out[f] = v > 0 ? v : 0;
  }
  return out;
}

/**
 * Onset-strength envelopes: rectified rise in log energy. `env` mixes a low and a high
 * band (kicks, snares, hats); `bass` is below ~100 Hz only and decides which of two
 * half-beat phases carries the kick. Frame f is centred on (f + 0.5) / rate seconds.
 */
export function onsetEnvelope(mono, sampleRate) {
  const hop = Math.round(sampleRate / TARGET_ENV_RATE);
  const ENV_RATE = sampleRate / hop;
  const frames = Math.floor(mono.length / hop);
  // Normalise to RMS 0.1 so the balance of the log-compressed bands doesn't depend on loudness.
  let sq = 0;
  for (let i = 0; i < mono.length; i++) sq += mono[i] * mono[i];
  const k = (sq > 0 ? (0.01 * mono.length) / sq : 1) / hop;
  const eLow = new Float64Array(frames);
  const eHigh = new Float64Array(frames);
  const eBass = new Float64Array(frames);
  const aLow = 1 - Math.exp((-2 * Math.PI * 150) / sampleRate);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 4000) / sampleRate);
  const aBass = 1 - Math.exp((-2 * Math.PI * 100) / sampleRate);
  let lp = 0, lpH = 0, b1 = 0, b2 = 0;
  for (let f = 0; f < frames; f++) {
    let l = 0, h = 0, bs = 0;
    const start = f * hop;
    for (let i = start; i < start + hop; i++) {
      const s = mono[i];
      lp += aLow * (s - lp);
      lpH += aHigh * (s - lpH);
      b1 += aBass * (s - b1);
      b2 += aBass * (b1 - b2); // two stages: 12 dB/oct keeps snare bodies out
      l += lp * lp;
      h += (s - lpH) * (s - lpH);
      bs += b2 * b2;
    }
    eLow[f] = l;
    eHigh[f] = h;
    eBass[f] = bs;
  }
  // Low and bass energy over a 1-2-1 window of hops: a sustained bass note's sin² ripple (80-120 Hz)
  // sits near the frame rate's Nyquist and would otherwise alias into fake onsets.
  const e3 = (e, f) => 0.25 * (e[f > 0 ? f - 1 : f] + 2 * e[f] + e[f + 1 < frames ? f + 1 : f]);
  const env = new Float32Array(frames);
  const bass = new Float32Array(frames);
  let prevLow = 0, prevAll = 0, prevBass = 0;
  for (let f = 0; f < frames; f++) {
    const logLow = Math.log1p(1000 * e3(eLow, f) * k);
    const logHigh = Math.log1p(1000 * eHigh[f] * k);
    const logBass = Math.log1p(1e4 * e3(eBass, f) * k);
    const dLow = logLow - prevLow;
    const dHigh = logHigh - prevAll;
    env[f] = (dLow > 0 ? dLow : 0) * 1.0 + (dHigh > 0 ? dHigh : 0) * 0.5;
    bass[f] = logBass > prevBass ? logBass - prevBass : 0;
    prevLow = logLow;
    prevAll = logHigh;
    prevBass = logBass;
  }
  const win = Math.round(ENV_RATE);
  return { env: detrend(env, win), bass: detrend(bass, win), rate: ENV_RATE };
}

/**
 * How firmly a beat grid sits on the music: the mean of the strongest onset (bass-weighted)
 * within ±25 ms of each beat, over the mean onset level, across the middle 80% of the track.
 * A reading at the wrong level misses beats and scores lower. o = onsetEnvelope(...).
 */
export function beatSalience(o, bpm, offset) {
  const n = o.env.length;
  if (!(bpm > 0) || !n) return 0;
  const lv = (i) => (i >= 0 && i < n ? o.bass[i] + 0.5 * o.env[i] : 0);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += lv(i) / n;
  const P = 60 / bpm;
  const w = Math.round(0.025 * o.rate);
  const dur = n / o.rate;
  let s = 0;
  let k = 0;
  for (let t = offset + Math.ceil((dur * 0.1 - offset) / P) * P; t < dur * 0.9; t += P, k++) {
    const c = Math.round(t * o.rate - 0.5);
    let m = 0;
    for (let j = -w; j <= w; j++) m = Math.max(m, lv(c + j));
    s += m;
  }
  return k && mean > 0 ? s / k / mean : 0;
}

function sampleEnv(env, pos) {
  const i = Math.floor(pos);
  if (i < 0 || i + 1 >= env.length) return 0;
  const t = pos - i;
  return env[i] * (1 - t) + env[i + 1] * t;
}

// Catmull-Rom: unlike linear interpolation it has no kinks at frames, so a peak search
// between frames isn't pulled onto them.
function sampleCubic(env, pos) {
  const i = Math.floor(pos);
  if (i < 1 || i + 2 >= env.length) return sampleEnv(env, pos);
  const t = pos - i;
  const p0 = env[i - 1], p1 = env[i], p2 = env[i + 1], p3 = env[i + 2];
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

function smooth(env, sigma = 2) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  let norm = 0;
  for (let i = -radius; i <= radius; i++) {
    const k = Math.exp((-0.5 * i * i) / (sigma * sigma));
    kernel.push(k);
    norm += k;
  }
  const out = new Float32Array(env.length);
  for (let f = 0; f < env.length; f++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = f + j;
      if (idx >= 0 && idx < env.length) acc += env[idx] * kernel[j + radius];
    }
    out[f] = acc / norm;
  }
  return out;
}

/** Best phase (in frames) and its mean comb score for a given tempo over [from, to). */
function combScore(env, ENV_RATE, bpm, from, to, phaseStep) {
  const period = (60 * ENV_RATE) / bpm;
  let best = -1;
  let bestPhase = 0;
  for (let ph = 0; ph < period; ph += phaseStep) {
    let sum = 0;
    let n = 0;
    for (let p = from + ph; p < to; p += period) {
      sum += sampleEnv(env, p);
      n++;
    }
    const score = n ? sum / n : 0;
    if (score > best) {
      best = score;
      bestPhase = from + ph;
    }
  }
  return { score: best, phase: bestPhase };
}

function meanOf(x, from, to) {
  let s = 0;
  for (let f = from; f < to; f++) s += x[f];
  return to > from ? s / (to - from) : 0;
}

/** Envelopes and the analysis window shared by every tempo step, or null if too short. */
function analysisContext(mono, sampleRate) {
  const duration = mono.length / sampleRate;
  if (duration < 8) return null;
  const onset = onsetEnvelope(mono, sampleRate);
  const R = onset.rate;
  const env = smooth(onset.env, 2);
  const bass = smooth(onset.bass, 1);
  // Skip intro and outro; two minutes is plenty for the periodicity.
  const from = Math.floor(duration * 0.15 * R);
  const to = Math.floor(Math.min(duration * 0.15 + 120, duration * 0.9) * R);
  // The grid fit starts from the busiest 40 s of the window, not a breakdown.
  const w = Math.min(to - from, Math.round(40 * R));
  let acc = 0;
  for (let f = from; f < from + w; f++) acc += env[f];
  let bestAcc = acc;
  let mid = from + w / 2;
  for (let f = from + w; f < to; f++) {
    acc += env[f] - env[f - w];
    if (acc > bestAcc) {
      bestAcc = acc;
      mid = f + 1 - w / 2;
    }
  }
  return {
    env, bass, R, from, to, mid, half: w / 2,
    envMean: meanOf(env, 0, env.length),
    winEnv: meanOf(env, from, to),
    winBass: meanOf(bass, from, to),
  };
}

const MIN_T = 60;
const MAX_T = 200;

/**
 * Tempo periodicity: autocorrelation of the onset envelope with its mean removed (a DC
 * term would otherwise swamp the lags and let any prior pick the level), scored on
 * powers of two of the beat only. A 3× term would let a ¾-speed reading collect the bar.
 */
function tempoScores(c) {
  const { env, R, from, to } = c;
  const n = to - from;
  const mean = meanOf(env, from, to);
  const x = new Float32Array(n);
  let e0 = 0;
  for (let i = 0; i < n; i++) {
    x[i] = env[from + i] - mean;
    e0 += x[i] * x[i];
  }
  e0 /= n;
  const maxLag = Math.min(n - 1, Math.ceil((4 * 60 * R) / MIN_T) + 2);
  const acn = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    acn[lag] = e0 > 0 ? s / (n - lag) / e0 : 0;
  }
  const at = (L) => {
    const i = Math.floor(L);
    if (i < 1 || i + 1 > maxLag) return 0;
    const t = L - i;
    return acn[i] * (1 - t) + acn[i + 1] * t;
  };
  const score = (bpm) => {
    const L = (60 * R) / bpm;
    return at(L) + 0.5 * at(2 * L) + 0.25 * at(4 * L);
  };
  const step = 0.05;
  const vals = [];
  for (let bpm = MIN_T; bpm <= MAX_T + 1e-9; bpm += step) vals.push(score(bpm));
  const peaks = [];
  for (let i = 1; i + 1 < vals.length; i++) {
    const v = vals[i];
    if (v > 0 && v > vals[i - 1] && v >= vals[i + 1]) {
      const d = vals[i - 1] - 2 * v + vals[i + 1];
      const off = d < 0 ? (0.5 * (vals[i - 1] - vals[i + 1])) / d : 0;
      peaks.push({ bpm: MIN_T + (i + off) * step, score: v });
    }
  }
  peaks.sort((a, b) => b.score - a.score);
  return { peaks: peaks.slice(0, 5), score };
}

/**
 * Constant beat grid at about `bpm`: beat phase from a double-time comb with the half
 * chosen on the bass, then 8-beat blocks each find their best shift within ±25 ms and a
 * robust weighted least-squares line t = a + n·b through them gives tempo and phase.
 * The span grows from the busiest part outwards so a slightly-off start can't slip a beat.
 * a and b are in frames; a is the beat nearest c.mid.
 */
function fitGrid(c, bpm) {
  const { env, bass, R, from, to } = c;
  const P = (60 * R) / bpm;
  // Phase from the busiest 40 s only: a 0.1% tempo error smears a longer comb.
  const { mid } = c;
  const pFrom = Math.floor(mid - c.half);
  const pTo = Math.ceil(mid + c.half);
  const comb = (e, ph) => {
    let s = 0;
    let n = 0;
    for (let p = ph; p < pTo; p += P) {
      s += sampleEnv(e, p);
      n++;
    }
    return n ? s / n : 0;
  };
  const bestPhase = (lo, hi) => {
    let ph = lo;
    let v = -1;
    for (let x = lo; x < hi; x += 0.25) {
      const y = comb(env, x);
      if (y > v) { v = y; ph = x; }
    }
    return ph;
  };
  // Lock to the double-time grid first (so a half-time reading still lands on real beats),
  // let the bass pick the half that carries the kick (open hats can outscore it in the
  // full band), then re-find the phase near there at this tempo (swung 8ths pull the
  // double-time comb off the beat).
  let a = combScore(env, R, 2 * bpm, pFrom, pTo, 0.25).phase;
  if (comb(bass, a + P / 2) > comb(bass, a)) a += P / 2;
  a = bestPhase(a - P / 8, a + P / 8);
  a += Math.round((mid - a) / P) * P;
  let b = P;
  let fit = null;
  for (const span of [24, 64, 160, Infinity]) {
    const blocks = measureBlocks(c, a, b, span);
    const f = solveGrid(blocks, a, b, 0.025 * R);
    if (!f) continue; // too few clean blocks yet (a quiet or odd section): look wider
    if (Math.abs(f.b / P - 1) > 0.01) break; // refine only, never jump levels
    a = f.a;
    b = f.b;
    fit = f;
  }
  if (!fit) fit = { a, b, rms: Infinity, inl: 0, N: 0, blocks: [] };
  // Salience: how much stronger the grid's beats are than the envelope on average.
  let se = 0, sb = 0, n = 0;
  for (let p = a + Math.ceil((from - a) / b) * b; p < to; p += b, n++) {
    se += sampleEnv(env, p);
    sb += sampleEnv(bass, p);
  }
  const sal = n ? 0.5 * (se / n / (c.winEnv || 1) + sb / n / (c.winBass || 1)) : 0;
  return { ...fit, bpm: (60 * R) / fit.b, sal, S: sal * fit.inl };
}

/**
 * Best shift within ±tol ms of the 8 beats starting at frame s, period b: { t, w, interior }.
 * w = 0 for breakdowns and silence (no vote); interior is false when the best shift is the
 * search edge, i.e. the real hit lies outside the window.
 */
function measureBlock(c, s, b, tol = 25) {
  const { env, R } = c;
  const step = 0.001 * R;
  const steps = tol;
  const blockMean = meanOf(env, Math.max(0, Math.floor(s)), Math.min(env.length, Math.floor(s + 8 * b)));
  if (blockMean < 0.3 * c.envMean) return { t: s, w: 0, interior: false };
  const v = new Float64Array(2 * steps + 1);
  let bi = 0;
  for (let k = 0; k <= 2 * steps; k++) {
    const d = (k - steps) * step;
    let sum = 0;
    for (let j = 0; j < 8; j++) sum += sampleEnv(env, s + j * b + d);
    v[k] = sum;
    if (sum > v[bi]) bi = k;
  }
  let d = (bi - steps) * step;
  const interior = bi > 0 && bi < 2 * steps;
  if (interior) {
    // Sub-ms refinement on the smooth interpolant (linear has kinks at frames).
    let bv = -Infinity;
    let bd = d;
    for (let x = d - step; x <= d + step + 1e-9; x += step / 10) {
      let sum = 0;
      for (let j = 0; j < 8; j++) sum += sampleCubic(env, s + j * b + x);
      if (sum > bv) { bv = sum; bd = x; }
    }
    d = bd;
  }
  return { t: s + d, w: v[bi] / 8, interior };
}

/** Every 8-beat block within `span` beats of beat 0 of the grid a + n·b. */
function measureBlocks(c, a, b, span) {
  const out = [];
  const nMin = Math.max(-span, Math.ceil(-a / b / 8) * 8);
  for (let n = nMin; n + 8 <= span && a + (n + 8) * b < c.env.length; n += 8) out.push({ n, ...measureBlock(c, a + n * b, b) });
  return out;
}

/**
 * Follow the beat block by block outwards from the constant fit's inlier nearest beat 0,
 * each block searching ±40 ms around where the previous one predicts it and ±2% in
 * period (a drifting block smears at a fixed period), for tempos that drift.
 */
function trackBlocks(c, g) {
  if (!g.blocks.length) return [];
  const start = g.blocks.reduce((x, y) => (y.w > x.w ? y : x));
  const out = [];
  for (const dir of [1, -1]) {
    let t = start.t;
    let per = g.b;
    let wRef = start.w;
    for (let n = dir > 0 ? start.n : start.n - 8; ; n += 8 * dir) {
      const s = dir > 0 ? t : t - 8 * per;
      if (s < 0 || s + 8 * per >= c.env.length) break;
      const search = (tol) => {
        let best = null;
        for (let e = -0.02; e <= 0.0201; e += 0.0025) {
          const q = per * (1 + e);
          // Going backwards the block is anchored at its end, where the last one started.
          const x = measureBlock(c, dir > 0 ? s : s + 8 * (per - q), q, tol);
          if (!best || x.w > best.w) best = { ...x, per: q };
        }
        return best;
      };
      let m = search(40);
      // Much weaker than the chain so far: it slid onto off-beats; re-find the beat.
      if (m.w < 0.5 * wRef) {
        const wide = search(Math.round((500 * per) / c.R));
        if (wide.w > m.w) m = { ...wide, interior: true };
      }
      const ok = m.w > 0 && m.interior;
      const mp = m.per;
      if (ok) {
        per = mp;
        wRef = 0.8 * wRef + 0.2 * m.w;
      }
      t = ok ? m.t : s;
      if (dir > 0) t += 8 * per;
      out.push({ n, ...m });
    }
  }
  // A drifting tempo smears the constant fit's half-beat choice: redo it on the chain.
  let on = 0, off = 0;
  for (const k of out) {
    for (let j = 0; j < 8; j++) {
      on += sampleEnv(c.bass, k.t + j * k.per);
      off += sampleEnv(c.bass, k.t + (j + 0.5) * k.per);
    }
  }
  if (off > on) for (const k of out) k.t += k.per / 2;
  return out.sort((x, y) => x.n - y.n);
}

/**
 * For grids that fit loosely: track the beat, fit a line through the tracked blocks and
 * keep the deviation from it when that explains the misfit and leaves the ±25 ms band
 * (a live drummer). Returns null or { a, b, blocks, dev } with dev in frames per block.
 */
function driftGrid(c, g) {
  const blocks = trackBlocks(c, g).filter((k) => k.w > 0 && k.interior);
  if (blocks.length < 8) return null;
  let sw = 0, sn = 0, st = 0, snn = 0, snt = 0;
  for (const k of blocks) {
    sw += k.w; sn += k.w * k.n; st += k.w * k.t; snn += k.w * k.n * k.n; snt += k.w * k.n * k.t;
  }
  const b = (sw * snt - sn * st) / (sw * snn - sn * sn);
  const a = (st - b * sn) / sw;
  const res = blocks.map((k) => k.t - a - k.n * b);
  const dev = res.map((_, j) => [res[Math.max(0, j - 1)], res[j], res[Math.min(res.length - 1, j + 1)]].sort((x, y) => x - y)[1]);
  let sr = 0, peak = 0;
  blocks.forEach((k, j) => {
    sr += k.w * (res[j] - dev[j]) ** 2;
    peak = Math.max(peak, Math.abs(dev[j]));
  });
  if (Math.sqrt(sr / sw) > 0.5 * g.rms || peak < 0.025 * c.R) return null;
  return { a, b, blocks, dev };
}

/** Robust weighted LS of block times: 3 passes, dropping |residual| > tol. */
function solveGrid(blocks, a0, b0, tol) {
  const voters = blocks.filter((k) => k.w > 0);
  let use = voters.filter((k) => k.interior);
  let a = a0, b = b0;
  for (let pass = 0; pass < 3; pass++) {
    if (use.length < 3) return null;
    let sw = 0, sn = 0, st = 0, snn = 0, snt = 0;
    for (const k of use) {
      sw += k.w; sn += k.w * k.n; st += k.w * k.t; snn += k.w * k.n * k.n; snt += k.w * k.n * k.t;
    }
    const den = sw * snn - sn * sn;
    if (!(den > 0)) return null;
    b = (sw * snt - sn * st) / den;
    a = (st - b * sn) / sw;
    use = voters.filter((k) => k.interior && Math.abs(k.t - a - k.n * b) <= tol);
  }
  if (use.length < 3) return null;
  let sw = 0, sr = 0, wAll = 0, nLo = Infinity, nHi = -Infinity;
  for (const k of voters) wAll += k.w;
  for (const k of use) {
    const r = k.t - a - k.n * b;
    sw += k.w;
    sr += k.w * r * r;
    nLo = Math.min(nLo, k.n);
    nHi = Math.max(nHi, k.n + 8);
  }
  return { a, b, rms: Math.sqrt(sr / sw), inl: sw / wAll, N: nHi - nLo, blocks: use };
}

/**
 * Grid fit → stored values: round to a whole (then half) BPM only when that keeps the
 * slip over the inlier span within 10 ms, re-centre the phase on the measured blocks.
 */
function finishGrid(c, g) {
  const { R } = c;
  let bpm = (60 * R) / g.b;
  let a = g.a;
  for (const f of [1, 2]) {
    const Tr = Math.round(bpm * f) / f;
    if (Math.abs(60 / Tr - 60 / bpm) * g.N <= 0.01) {
      const P = (60 * R) / Tr;
      let sw = 0, st = 0;
      for (const k of g.blocks) {
        sw += k.w;
        st += k.w * (k.t - k.n * P);
      }
      if (sw > 0) a = st / sw;
      bpm = Tr;
      break;
    }
  }
  bpm = Math.round(bpm * 1e4) / 1e4;
  const period = 60 / bpm;
  const t = (a + 0.5) / R + ONSET_BIAS;
  return { bpm, offset: ((t % period) + period) % period, gridRms: (g.rms / R) * 1000 };
}

/**
 * A drifting track's stored grid: its average tempo (never rounded) and first beat, plus
 * dev = { step: 8, d } — ms by which beat 8·i (counted from offset) is late against it.
 */
function driftResult(c, { a, b, blocks, dev }) {
  const { R } = c;
  const bpm = Math.round(((60 * R) / b) * 1e4) / 1e4;
  const period = 60 / bpm;
  const t = (a + 0.5) / R + ONSET_BIAS;
  const offset = ((t % period) + period) % period;
  const n0 = Math.round((t - offset) / period); // beat index of block n = 0
  const xs = blocks.map((k) => k.n + n0); // each tracked block is timed at its first beat
  const count = Math.floor((c.env.length / R - offset) / period / 8) + 1;
  const d = [];
  // Linear between tracked blocks, extrapolated past the first and last one.
  for (let i = 0, j = 0; i < count; i++) {
    const x = 8 * i;
    while (j + 2 < xs.length && xs[j + 1] < x) j++;
    const u = (x - xs[j]) / (xs[j + 1] - xs[j]);
    d.push(Math.round(((dev[j] + (dev[j + 1] - dev[j]) * u) / R) * 1000));
  }
  return { bpm, offset, dev: { step: 8, d } };
}

const RELATIVES = [2, 0.5, 3 / 2, 2 / 3, 4 / 3, 3 / 4, 5 / 4, 4 / 5];
const sameOctave = (x, y) => {
  const l = Math.abs(Math.log2(x / y));
  return Math.abs(l - Math.round(l)) < 0.0144; // within 1% of a power of two
};
// Weak preference for the octave around 120 (librosa's prior shape).
const octavePrior = (bpm) => Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);

/**
 * Detect tempo and beat grid. Returns null for too-short or pulseless audio, else
 * { bpm, offset, confidence, gridRms, inliers, variable, dev, alts: [{ bpm, offset, rel }] }
 * with offset the first beat in seconds (0 ≤ offset < 60/bpm), gridRms in ms, dev null or
 * { step: 8, d: ms[] } (see driftResult), and alts the next two non-octave tempo levels
 * (×4/3, ×3/4, ×5/4, ×4/5) for the user to pick when ours is wrong.
 */
export function detectTempo(mono, sampleRate, { minBpm = 70, maxBpm = 190 } = {}) {
  const c = analysisContext(mono, sampleRate);
  if (!c) return null;
  const { peaks, score } = tempoScores(c);
  if (!peaks.length) return null;

  const cands = [];
  const fits = new Map();
  const cand = (bpm) => {
    let x = cands.find((k) => Math.abs(k.bpm / bpm - 1) < 0.01);
    if (!x) {
      x = { bpm, score: score(bpm) };
      cands.push(x);
    }
    if (!fits.has(x)) fits.set(x, fitGrid(c, x.bpm));
    return x;
  };
  const S = (x) => fits.get(x).S;
  for (const p of peaks) cand(p.bpm);
  for (const p of peaks) for (const r of RELATIVES) if (p.bpm * r >= MIN_T && p.bpm * r <= MAX_T) cand(p.bpm * r);
  for (const x of [...cands]) for (const f of [2, 0.5]) if (x.bpm * f >= MIN_T && x.bpm * f <= MAX_T) cand(x.bpm * f);

  // Each tempo level is represented by its best octave in range (weakly preferring ~120).
  const inRange = (bpm) => bpm >= minBpm && bpm <= maxBpm;
  const octaveOf = (x) => {
    let pick = null;
    for (const f of [1, 2, 0.5, 4, 0.25]) {
      const bpm = x.bpm * f;
      if (bpm < MIN_T || bpm > MAX_T || !inRange(bpm)) continue;
      const y = cand(bpm);
      if (!pick || S(y) * octavePrior(y.bpm) > S(pick) * octavePrior(pick.bpm)) pick = y;
    }
    return pick;
  };
  // Levels compare on S·√(T/120): a slower grid can sit on only the strongest hits, which
  // inflates its mean salience.
  const levelS = (x) => {
    const y = octaveOf(x);
    return y ? S(y) * Math.sqrt(fits.get(y).bpm / 120) : 0;
  };
  const classScore = (x) => Math.max(...cands.filter((k) => sameOctave(k.bpm, x.bpm)).map((k) => k.score));
  // Level: the strongest periodicity, unless another level's grid clearly lands on more
  // and stronger onsets and its periodicity isn't much weaker (tuned on the library's
  // even-indexed tracks, see test/library-eval.cjs).
  const top = cand(peaks[0].bpm);
  let best = top;
  for (const x of cands) {
    if (sameOctave(x.bpm, top.bpm)) continue;
    if (levelS(x) >= 1.2 * levelS(top) && classScore(x) >= 0.4 * classScore(top) && levelS(x) > levelS(best)) best = x;
  }
  const chosen = octaveOf(best) || best;
  const g = fits.get(chosen);
  if (!(g.inl > 0)) return null;
  let grid = finishGrid(c, g);
  const drift = g.rms > 0.009 * c.R || g.inl < 0.75 ? driftGrid(c, g) : null;
  if (drift) grid = { ...driftResult(c, drift), gridRms: grid.gridRms };

  // Alternatives: the non-octave ratios a periodicity method confuses (triplet feels, 3-3-2,
  // dotted rhythms), strongest first, each offered as that ratio of ours (×4/3, not ×2/3).
  const levels = [];
  for (const r of [4 / 3, 3 / 4, 5 / 4, 4 / 5]) {
    let bpm = chosen.bpm * r;
    while (bpm > maxBpm) bpm /= 2;
    while (bpm < minBpm) bpm *= 2;
    const y = cand(bpm);
    if (fits.get(y).inl > 0) levels.push(y);
  }
  levels.sort((x, y) => levelS(y) - levelS(x));
  const Sb = levelS(chosen) || 1e-9;
  const alts = levels.slice(0, 2).map((x) => {
    const a = finishGrid(c, fits.get(x));
    return { bpm: a.bpm, offset: a.offset, rel: Math.round((levelS(x) / Sb) * 1000) / 1000 };
  });
  const S2 = levels.length ? levelS(levels[0]) : 0;
  const confidence = g.inl * Math.max(0, Math.min(1, (Sb - S2) / Sb));

  return {
    bpm: grid.bpm,
    offset: grid.offset,
    confidence,
    gridRms: grid.gridRms,
    inliers: g.inl,
    // A loose constant fit (live band, tempo changes) even when no deviation curve could be
    // trusted; with a curve the average tempo is stored and dev follows the drift.
    variable: !!drift || g.inl < 0.7,
    dev: grid.dev || null,
    alts,
  };
}

/**
 * Re-fit the grid at a tempo the user forced (×2, /2, an alternative, TAP): fine tempo
 * near `bpm` and the phase, with the half-beat choice on the kick.
 * Returns { bpm, offset, gridRms } or null.
 */
export function fitGridAt(mono, sampleRate, bpm) {
  const c = analysisContext(mono, sampleRate);
  if (!c || !(bpm > 0)) return null;
  const g = fitGrid(c, bpm);
  if (g.inl > 0) return finishGrid(c, g);
  // Nothing to fit to (beatless audio): keep the user's tempo, phase from the comb.
  const period = 60 / bpm;
  const t = (g.a + 0.5) / c.R + ONSET_BIAS;
  return { bpm: Math.round(bpm * 1e4) / 1e4, offset: ((t % period) + period) % period, gridRms: null };
}

// ------------------------------------------------------------------ key

export const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Key profiles (major, minor), tonic first: Faraldo's EDMA profiles, measured on electronic
// dance music (what Essentia uses for it), which read pop, rock and game music best here too.
// They describe which notes a key uses; audio also carries each note's overtones (the 3rd
// harmonic is a fifth up, the 5th a major third up), which drags a raw chroma toward the
// dominant. So, as in Gómez's audio key-finding, the profiles get the same overtones
// folded in before they're compared with the audio.
const KK_MAJOR = [0.1652, 0.0475, 0.0829, 0.0669, 0.0999, 0.0927, 0.0529, 0.1316, 0.0522, 0.0744, 0.0694, 0.0643];
const KK_MINOR = [0.1724, 0.04, 0.0761, 0.121, 0.0507, 0.0888, 0.0488, 0.1272, 0.087, 0.0518, 0.0761, 0.0598];
const HARMONIC_INTERVALS = [0, 0, 7, 0, 4, 7]; // harmonics 1–6, in semitones above the note (mod 12)
function withOvertones(profile, decay = 0.6) {
  const out = new Array(12).fill(0);
  for (let pc = 0; pc < 12; pc++) {
    HARMONIC_INTERVALS.forEach((iv, h) => {
      out[(pc + iv) % 12] += profile[pc] * decay ** h;
    });
  }
  return out;
}
const MAJOR_PROFILE = withOvertones(KK_MAJOR);
const MINOR_PROFILE = withOvertones(KK_MINOR);

/**
 * Keys are numbers 0–23: tonic pitch class (C = 0) + 12 for minor.
 * keyName(9 + 12) → 'Am', camelot(9 + 12) → '8A'.
 */
export function keyName(key) {
  if (key == null || key < 0) return '';
  return PITCH_NAMES[key % 12] + (key >= 12 ? 'm' : '');
}

export function camelot(key) {
  if (key == null || key < 0) return '';
  const minor = key >= 12;
  const tonic = key % 12;
  const relMajor = minor ? (tonic + 3) % 12 : tonic; // A minor ↔ C major
  return `${(((relMajor * 7) % 12) + 7) % 12 + 1}${minor ? 'A' : 'B'}`;
}

/** Key moved by a number of semitones (rounded). */
export function transposeKey(key, semitones) {
  if (key == null || key < 0) return key;
  const tonic = (((key % 12) + Math.round(semitones)) % 12 + 12) % 12;
  return tonic + (key >= 12 ? 12 : 0);
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/**
 * 12-bin chroma (pitch-class energy) summed over the track. Spectral peaks are placed by
 * interpolation, the track's tuning (records are often a few cents off A440) is measured
 * from them first, and each peak counts at its plain magnitude: log-squashing the peaks let
 * the hiss and overtones of dense mixes flatten the chroma until neighbouring keys tied.
 */
export function chromagram(mono, sampleRate, { maxFrames = 600 } = {}) {
  // Work at ~11 kHz: plenty for 55 Hz–2 kHz, and 4× less to transform.
  const dec = Math.max(1, Math.round(sampleRate / 11025));
  const sr = sampleRate / dec;
  const len = Math.floor(mono.length / dec);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let j = 0; j < dec; j++) s += mono[i * dec + j];
    x[i] = s / dec;
  }

  const N = 8192; // ~1.3 Hz bins at 11 kHz: resolves semitones down to ~55 Hz
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const frames = Math.max(0, Math.floor((len - N) / (N / 4)) + 1);
  const step = Math.max(1, Math.ceil(frames / maxFrames));
  const lo = Math.ceil((55 * N) / sr);
  const hi = Math.min(N / 2 - 2, Math.floor((2000 * N) / sr));

  // Pass 1: every spectral peak as (fractional MIDI note, magnitude, frame).
  const peaks = [];
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(N / 2);
  let frame = 0;
  for (let f = 0; f < frames; f += step, frame++) {
    const off = f * (N / 4);
    let energy = 0;
    for (let i = 0; i < N; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
      energy += re[i] * re[i];
    }
    if (energy < 1e-6) continue; // silence
    fftInPlace(re, im);
    for (let k = lo - 1; k <= hi + 1; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let k = lo; k <= hi; k++) {
      const m = mag[k];
      if (!(m > mag[k - 1] && m >= mag[k + 1])) continue;
      const a = Math.log(mag[k - 1] + 1e-12);
      const b = Math.log(m + 1e-12);
      const c = Math.log(mag[k + 1] + 1e-12);
      const d = (0.5 * (a - c)) / (a - 2 * b + c || -1e-12); // parabolic peak position
      peaks.push(69 + 12 * Math.log2(((k + d) * sr) / N / 440), m, frame);
    }
  }

  // Tuning: magnitude-weighted circular mean of how far the peaks sit from the semitones.
  let cs = 0;
  let sn = 0;
  for (let i = 0; i < peaks.length; i += 3) {
    const ph = 2 * Math.PI * (peaks[i] - Math.round(peaks[i]));
    cs += peaks[i + 1] * Math.cos(ph);
    sn += peaks[i + 1] * Math.sin(ph);
  }
  const tuning = Math.atan2(sn, cs) / (2 * Math.PI); // semitones

  // Pass 2: fold the peaks into pitch classes, each frame normalised so loud bars don't dominate.
  const chroma = new Float64Array(12);
  const frameChroma = new Float64Array(12);
  const flush = () => {
    let total = 0;
    for (let c = 0; c < 12; c++) total += frameChroma[c];
    if (total > 0) for (let c = 0; c < 12; c++) chroma[c] += frameChroma[c] / total;
    frameChroma.fill(0);
  };
  let cur = -1;
  for (let i = 0; i < peaks.length; i += 3) {
    if (peaks[i + 2] !== cur) {
      flush();
      cur = peaks[i + 2];
    }
    const midi = peaks[i] - tuning;
    const nearest = Math.round(midi);
    const d = Math.abs(midi - nearest);
    if (d < 0.4) frameChroma[((nearest % 12) + 12) % 12] += peaks[i + 1] * Math.cos((d / 0.4) * (Math.PI / 2)) ** 2;
  }
  flush();
  return chroma;
}

function correlate(a, b) {
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < 12; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= 12;
  mb /= 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/**
 * Detect the musical key. Returns { key, confidence, scores, chroma } with key 0–23
 * (see keyName / camelot) and chroma the track's 12 pitch-class shares (C first), or null
 * when there's no clear tonal content.
 */
export function detectKey(mono, sampleRate) {
  if (mono.length / sampleRate < 5) return null;
  const chroma = chromagram(mono, sampleRate);
  if (chroma.every((v) => v === 0)) return null;
  const scores = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [[0, MAJOR_PROFILE], [12, MINOR_PROFILE]]) {
      const rotated = new Array(12);
      for (let i = 0; i < 12; i++) rotated[(i + tonic) % 12] = profile[i];
      scores.push({ key: tonic + mode, r: correlate(chroma, rotated) });
    }
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  if (best.r < 0.3) return null;
  // Confidence: margin over the runner-up that isn't the relative major/minor
  // (those share a scale and are near-ties by nature, and mix fine anyway).
  const runnerUp = scores.find((s) => s.key !== best.key && camelot(s.key).slice(0, -1) !== camelot(best.key).slice(0, -1));
  const confidence = Math.max(0, Math.min(1, (best.r - (runnerUp?.r ?? 0)) * 4));
  let total = 0;
  for (const v of chroma) total += v;
  return { key: best.key, confidence, scores: scores.slice(0, 4), chroma: Array.from(chroma, (v) => Math.round((v / total) * 1e4) / 1e4) };
}

/** Chroma moved up by s semitones. */
const rotateChroma = (ch, s) => Array.from({ length: 12 }, (_, i) => ch[(((i - s) % 12) + 12) % 12]);

/**
 * The key shift that makes one track's notes sit best with another's, by comparing what
 * the two actually play (their chroma), not their key names. `theirOffset` is how far the
 * other deck already plays from its own key (semitones, may be fractional); the answer
 * matches its fine detune too. Small moves win ties: each semitone costs 0.01 in fit.
 * Returns { shift, fit, fitNow } (fit = chroma correlation, -1…1) or null.
 */
export function bestKeyShift(mine, theirs, theirOffset = 0, myOffset = 0) {
  if (!mine?.length || !theirs?.length) return null;
  const whole = Math.round(theirOffset);
  const heard = rotateChroma(theirs, whole);
  let best = null;
  for (let s = -6; s <= 6; s++) {
    const fit = correlate(rotateChroma(mine, s), heard);
    if (!best || fit - 0.01 * Math.abs(s) > best.fit - 0.01 * Math.abs(best.shift)) best = { shift: s, fit };
  }
  return { shift: best.shift + (theirOffset - whole), fit: best.fit, fitNow: correlate(rotateChroma(mine, Math.round(myOffset)), heard) };
}

/**
 * Time signature and downbeat, given a beat grid. Each beat gets two cues for
 * "this is beat 1": how hard the low end hits (kicks, crashes, bass entries)
 * and how much the bass note changes (bass lines usually move on the bar).
 * Returns { beatsPerBar: 3 | 4, downbeat, confidence }, downbeat being the
 * first bar start in seconds, or null when the track is too short to tell.
 */
export function detectMeter(mono, sampleRate, bpm, offset) {
  if (!bpm) return null;
  const period = 60 / bpm;
  const duration = mono.length / sampleRate;
  const start = Math.min(30, duration * 0.15);
  const first = Math.ceil((start - offset) / period);
  const count = Math.min(Math.floor((Math.min(duration, start + 180) - offset) / period) - first, 256);
  if (count < 24) return null;

  // Bass only (two one-pole stages at 120 Hz), so snares and hats on 2 and 4 don't count.
  const aLow = 1 - Math.exp((-2 * Math.PI * 120) / sampleRate);
  const accent = new Float64Array(count); // rise in bass energy at the beat
  const pitch = new Float64Array(count); // bass zero-crossing rate over the beat ≈ bass note
  const w = Math.round(0.06 * sampleRate);
  for (let j = 0; j < count; j++) {
    const t = offset + (first + j) * period;
    const i0 = Math.max(0, Math.round(t * sampleRate) - w);
    const i1 = Math.min(mono.length, Math.round((t + period * 0.75) * sampleRate));
    let lp1 = 0;
    let lp2 = 0;
    let prev = 0;
    let zc = 0;
    let before = 0;
    let after = 0;
    for (let i = i0; i < i1; i++) {
      lp1 += aLow * (mono[i] - lp1);
      lp2 += aLow * (lp1 - lp2);
      const k = i - i0;
      if (k < w) before += lp2 * lp2;
      else if (k < 2 * w) after += lp2 * lp2;
      if (k > 2 * w) {
        if ((lp2 >= 0) !== (prev >= 0)) zc++;
      }
      prev = lp2;
    }
    accent[j] = Math.max(0, Math.log1p(1e4 * after / w) - Math.log1p(1e4 * before / w));
    pitch[j] = zc;
  }
  const change = new Float64Array(count);
  for (let j = 1; j < count; j++) change[j] = Math.abs(Math.log((pitch[j] + 1) / (pitch[j - 1] + 1)));
  const norm = (a) => {
    let m = 0;
    for (const v of a) m += v;
    m /= a.length;
    return m > 0 ? a.map((v) => v / m) : a;
  };
  const a = norm(accent);
  const c = norm(change);

  // For each meter, the phase whose beats stand out most from the rest.
  const contrast = (m) => {
    let best = { k: 0, score: -Infinity };
    const mean = (k) => {
      let s = 0;
      let n = 0;
      for (let j = k; j < count; j += m) {
        s += a[j] + c[j];
        n++;
      }
      return n ? s / n : 0;
    };
    const means = Array.from({ length: m }, (_, k) => mean(k));
    for (let k = 0; k < m; k++) {
      const others = (means.reduce((x, y) => x + y, 0) - means[k]) / (m - 1);
      const score = means[k] - others;
      if (score > best.score) best = { k, score };
    }
    return best;
  };
  const four = contrast(4);
  const three = contrast(3);
  // Most dance music is 4/4: 3/4 has to win clearly.
  const useThree = three.score > four.score * 1.3 && three.score > 0.15;
  const m = useThree ? 3 : 4;
  const win = useThree ? three : four;
  const bar = m * period;
  let downbeat = offset + (first + win.k) * period;
  downbeat = ((downbeat % bar) + bar) % bar;
  return { beatsPerBar: m, downbeat, confidence: Math.max(0, Math.min(1, win.score / 1.5)) };
}

/** Beat phase (0..1) at a given track position. */
export function beatPhase(position, bpm, offset) {
  const period = 60 / bpm;
  const p = (position - offset) / period;
  return p - Math.floor(p);
}

/** Everything the app stores for a track, in one call (what analysis-worker.js runs). */
export function analyzeTrack(mono, sampleRate) {
  const tempo = detectTempo(mono, sampleRate);
  const meter = tempo ? detectMeter(mono, sampleRate, tempo.bpm, tempo.offset) : null;
  return { tempo, meter, key: detectKey(mono, sampleRate) };
}
