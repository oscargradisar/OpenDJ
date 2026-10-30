import { detectTempo, fitGridAt, analyzeTrack, ANALYSIS_VERSION, detectMeter, computeWaveform, overview, mixToMono, beatPhase, detectKey, keyName, camelot, transposeKey, bestKeyShift, beatSalience, onsetEnvelope } from '../src/renderer/analysis.js';
let sr = 44100;
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
// Drum voices; each starts its attack at the given sample, so the true beat time is exact.
function voice(kind, tt) {
  if (kind === 'kick') return Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 12) * 0.9;
  if (kind === 'softkick') return Math.sin(2 * Math.PI * (45 * tt + (60 / 25) * (1 - Math.exp(-tt * 25)))) * Math.exp(-tt * 8) * Math.min(1, tt / 0.004) * 0.9;
  if (kind === 'sub') return Math.sin(2 * Math.PI * 45 * tt) * Math.exp(-tt * 4) * Math.min(1, tt / 0.01) * 0.8; // 808
  if (kind === 'snare') return rnd() * Math.exp(-tt * 25) * 0.5 + Math.sin(2*Math.PI*190*tt)*Math.exp(-tt*20)*0.3;
  if (kind === 'openhat') return rnd() * Math.exp(-tt * 12) * 0.3;
  return rnd() * Math.exp(-tt * 80) * 0.25; // closed hat
}
const LEN = { kick: 0.25, softkick: 0.3, sub: 0.4, snare: 0.18, openhat: 0.25, hat: 0.05 };
// beats: explicit beat times (for drifting tempos), else from bpm and offset.
function synth({ bpm, offset, seconds, pattern, drone = true, beats }) {
  const buf = new Float32Array(Math.round(sr * seconds));
  const add = (t, kind, gain = 1) => {
    const i0 = Math.round(t * sr);
    for (let i = 0; i < LEN[kind] * sr && i0 + i < buf.length; i++) buf[i0 + i] += voice(kind, i / sr) * gain;
  };
  // pad/bass drone so it's not pure drums
  for (let i = 0; i < buf.length; i++) buf[i] += (drone ? Math.sin(2*Math.PI*110*i/sr)*0.08 : 0) + rnd()*0.01;
  if (!beats) { beats = []; for (let b = 0; offset + b * 60 / bpm < seconds; b++) beats.push(offset + b * 60 / bpm); }
  beats.forEach((t, b) => pattern(b, t, (beats[b + 1] ?? t + 60 / bpm) - t, add));
  return buf;
}
const house = (b, t, beat, add) => { add(t, 'kick'); add(t + beat / 2, 'hat'); if (b % 2) add(t, 'snare'); };
const hiphop = (b, t, beat, add) => { if (b % 4 === 0 || b % 4 === 2) add(t, 'kick'); if (b%8===2) add(t+beat*0.75,'kick'); if (b % 2) add(t, 'snare'); add(t,'hat'); add(t+beat/2,'hat'); };
const dnb = (b, t, beat, add) => { if (b % 4 === 0) add(t, 'kick'); if (b%4===2) add(t+beat/2,'kick'); if (b % 4 === 1 || b % 4 === 3) add(t, 'snare'); add(t,'hat'); add(t+beat/2,'hat'); };
// trap at 160: syncopated 808, snare on every 4th beat (half-time feel), 16th hats with a triplet roll
const trap = (b, t, beat, add) => {
  const k = b % 8;
  if (k === 0 || k === 5) add(t, 'sub');
  if (k === 2) add(t + beat * 0.75, 'sub', 0.8);
  if (k % 4 === 2) add(t, 'snare');
  for (let s = 0; s < 4; s++) add(t + (s * beat) / 4, 'hat', s ? 0.6 : 0.9);
  if (k === 7) for (let s = 0; s < 6; s++) add(t + (s * beat) / 6, 'hat', 0.5);
};
// shuffle: hats on the 1st and 3rd triplet 8th, kick 1 & 3, snare 2 & 4
const shuffle = (b, t, beat, add) => { add(t, b % 2 ? 'snare' : 'kick'); add(t, 'hat'); add(t + (2 * beat) / 3, 'hat', 0.8); if (b % 4 === 3) add(t + beat / 3, 'hat', 0.6); };
// loud open hats on the off-beats over a soft kick (garage/house)
const openhat = (b, t, beat, add) => { add(t, 'softkick', 0.5); add(t + beat / 2, 'openhat', 1.6); if (b % 2) add(t, 'snare', 0.4); };
// 3-3-2 (Hotline Bling): kicks on 8ths 0, 3 and 6 of each bar, snare on 2 and 4
const tresillo = (b, t, beat, add) => { const k = b % 4, e = beat / 2; if (k === 0) { add(t, 'kick'); add(t + 3 * e, 'kick'); } if (k === 1) add(t + 2 * e, 'kick'); if (k % 2) add(t, 'snare'); add(t, 'hat', 0.6); add(t + e, 'hat', 0.4); };
const swing8 = (b, t, beat, add) => { add(t, b % 2 ? 'snare' : 'kick'); add(t, 'hat'); add(t + (beat * 2) / 3, 'hat', 0.8); };

let fails = 0;
const check = (ok, msg) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); };
const wrap = (x, P) => { let d = ((x % P) + P) % P; if (d > P / 2) d -= P; return d; };
const fmt = (r) => r ? `${r.bpm} bpm, offset ${r.offset.toFixed(4)}, conf ${r.confidence.toFixed(2)}, rms ${r.gridRms.toFixed(1)} ms, alts ${r.alts.map((a) => a.bpm).join('/')}` : 'null';
check(ANALYSIS_VERSION === 2, 'ANALYSIS_VERSION is 2');

// --- tempo and grid: BPM within 0.005, first beat within 2 ms, at both sample rates the app
// has used. levels: accepted multiples of the true tempo (×½ only where stated).
const cases = [
  { name: 'house 124', bpm: 124, offset: 0.37, pattern: house },
  { name: 'house 128', bpm: 128, offset: 0.05, pattern: house },
  { name: 'tech 122.5', bpm: 122.5, offset: 0.2, pattern: house },
  { name: 'hiphop 92', bpm: 92, offset: 0.61, pattern: hiphop },
  { name: 'dnb 174 (half ok)', bpm: 174, offset: 0.1, pattern: dnb, levels: [1, 0.5] },
  { name: 'disco 112', bpm: 112, offset: 0.45, pattern: house },
  { name: 'house 128.00 @0.123', bpm: 128, offset: 0.123, pattern: house },
  { name: '127.95 not rounded', bpm: 127.95, offset: 0.123, pattern: house },
  { name: 'HBFS 123.45 not rounded', bpm: 123.45, offset: 0.123, pattern: house },
  { name: 'trap 160 (not 128)', bpm: 160, offset: 0.123, pattern: trap, levels: [1, 0.5] },
  { name: 'triplet-hat shuffle 150 (not 112.5)', bpm: 150, offset: 0.123, pattern: shuffle, levels: [1, 0.5] },
  { name: 'open off-beat hats, soft kick 124', bpm: 124, offset: 0.123, pattern: openhat },
  { name: 'open off-beat hats, soft kick 92', bpm: 92, offset: 0.123, pattern: openhat },
  { name: '3-3-2 at 135 (not 180)', bpm: 135, offset: 0.123, pattern: tresillo, levels: [1, 0.5] },
  { name: 'swung 8ths 100', bpm: 100, offset: 0.123, pattern: swing8 },
];
let slowest = 0;
for (const rate of [44100, 48000]) {
  sr = rate;
  for (const c of cases) {
    seed = 1;
    const mono = synth({ ...c, seconds: 150 });
    const t0 = performance.now();
    const r = detectTempo(mono, sr);
    slowest = Math.max(slowest, performance.now() - t0);
    const k = r && (c.levels ?? [1]).find((m) => Math.abs(r.bpm - c.bpm * m) <= 0.005 * m);
    // A half-tempo grid must still sit on one of the real beats.
    const ph = k ? wrap(r.offset - c.offset, 60 / c.bpm) : NaN;
    const unrounded = Number.isInteger(c.bpm * 2) || r.bpm !== Math.round(r.bpm * 2) / 2;
    check(k && Math.abs(ph) <= 0.002 && unrounded && r.variable === false,
      `${(sr / 1000).toFixed(1)}k ${c.name}: ${fmt(r)} (want ${c.bpm} @${c.offset}, phase err ${(ph * 1000).toFixed(2)} ms)`);
  }
}
sr = 44100;
check(slowest < 1000, `detectTempo slowest synthetic case ${slowest.toFixed(0)} ms`);

// --- live drift: 106 → 113 BPM over 150 s. Flagged variable; the deviation curve brings
// the beats back within 5 ms rms.
for (const rate of [44100, 48000]) {
  sr = rate;
  seed = 1;
  const beats = [];
  for (let t = 0.123; t < 150; t += 60 / (106 + (7 * t) / 150)) beats.push(t);
  const r = detectTempo(synth({ seconds: 150, pattern: house, beats }), sr);
  let rms = NaN;
  if (r?.dev) {
    const P = 60 / r.bpm, d = r.dev.d;
    const devAt = (k) => { const x = k / r.dev.step, i = Math.max(0, Math.min(d.length - 2, Math.floor(x))), u = Math.max(0, Math.min(1, x - i)); return (d[i] * (1 - u) + d[i + 1] * u) / 1000; };
    const err = beats.filter((t) => t > 2 && t < 148).map((t) => {
      let k = Math.round((t - r.offset) / P);
      for (let it = 0; it < 3; it++) k = Math.round((t - r.offset - devAt(k)) / P);
      return t - (r.offset + k * P + devAt(k));
    });
    rms = Math.sqrt(err.reduce((s, e) => s + e * e, 0) / err.length) * 1000;
  }
  check(r?.variable === true && rms <= 5, `${(sr / 1000).toFixed(1)}k drift 106→113: variable ${r?.variable}, ${r?.bpm} bpm, beat rms after dev ${rms.toFixed(2)} ms`);
}
sr = 44100;

// --- forced tempo levels (×4/3 of a ¾-speed reading, /2, ×2): fitGridAt re-fits the phase,
// the halving keeps the kick, and the meter at the corrected tempo is 4/4.
{
  seed = 1;
  const mono = synth({ bpm: 150, offset: 0.123, seconds: 150, pattern: hiphop });
  const f = fitGridAt(mono, sr, 112.5 * 4 / 3);
  const m = f && detectMeter(mono, sr, f.bpm, f.offset);
  check(f && Math.abs(f.bpm - 150) <= 0.005 && Math.abs(wrap(f.offset - 0.123, 0.4)) <= 0.002 && m?.beatsPerBar === 4,
    `fitGridAt 4/3 of 112.5: ${f?.bpm} bpm, offset ${f?.offset.toFixed(4)} (want 0.123), meter ${m?.beatsPerBar}/4`);
  const h = fitGridAt(mono, sr, 75); // kicks are on beats 1 and 3: the slow grid must take those
  check(h && Math.abs(h.bpm - 75) <= 0.005 && Math.abs(wrap(h.offset - 0.123, 0.8)) <= 0.002, `fitGridAt /2: ${h?.bpm} bpm, offset ${h?.offset.toFixed(4)} (want 0.123 mod 0.8)`);
  const d = fitGridAt(mono, sr, 300);
  check(d && Math.abs(d.bpm - 300) <= 0.01 && Math.abs(wrap(d.offset - 0.123, 0.2)) <= 0.002, `fitGridAt x2: ${d?.bpm} bpm, offset ${d?.offset.toFixed(4)}`);
  const all = analyzeTrack(mono, sr);
  check(all.tempo && all.meter?.beatsPerBar === 4 && 'key' in all, `analyzeTrack: tempo ${all.tempo?.bpm}, meter ${all.meter?.beatsPerBar}/4, key ${all.key ? keyName(all.key.key) : 'none'}`);
  check(detectTempo(new Float32Array(sr * 5), sr) === null && detectTempo(new Float32Array(sr * 30), sr) === null, 'too short or silent → null');
}

// --- key detection: chord progressions (triads + bass, with harmonics) over a house beat
const midiHz = (m) => 440 * 2 ** ((m - 69) / 12);
function progression(chords, { seconds = 60, bpm = 124, tuning = 0 } = {}) {
  const buf = synth({ bpm, offset: 0.1, seconds, pattern: house, drone: false });
  const bar = (4 * 60) / bpm;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const ch = chords[Math.floor(t / bar) % chords.length];
    let s = 0;
    ch.forEach((m, j) => {
      const f = midiHz((j === 0 ? m - 12 : m) + tuning); // first note an octave down as the bass
      for (let h = 1; h <= 4; h++) s += (Math.sin(2 * Math.PI * f * h * t) * 0.06) / h;
    });
    buf[i] += s;
  }
  return buf;
}
// chords as MIDI notes: [bass/root, triad...]
const C = 48, D = 50, Eb = 51, E = 52, F = 53, Fs = 54, G = 55, Ab = 56, A = 57, Bb = 58, B = 59;
const maj = (r) => [r, r + 12, r + 16, r + 19];
const min = (r) => [r, r + 12, r + 15, r + 19];
const keyCases = [
  { name: 'C major (C F G C)', want: 'C', chords: [maj(C), maj(F), maj(G), maj(C)] },
  { name: 'A minor (Am F C G)', want: 'Am', chords: [min(A), maj(F), maj(C), maj(G), min(A), min(D), maj(E), min(A)] },
  { name: 'F# minor (F#m D A E)', want: 'F#m', chords: [min(Fs), maj(D), maj(A), maj(E), min(Fs), min(B), maj(Cs()), min(Fs)] },
  { name: 'Eb major (Eb Ab Bb Eb)', want: 'Eb', chords: [maj(Eb), maj(Ab), maj(Bb), maj(Eb)] },
  { name: 'D minor (Dm Gm A Dm)', want: 'Dm', chords: [min(D), min(G), maj(A), min(D)] },
];
function Cs() { return 49; }
for (const c of keyCases) {
  const mono = progression(c.chords);
  const t0 = performance.now();
  const r = detectKey(mono, sr);
  const ms = performance.now() - t0;
  const got = r ? keyName(r.key) : 'none';
  const ok = got === c.want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} key ${c.name}: got ${got} (${r ? camelot(r.key) : ''}), conf ${r ? r.confidence.toFixed(2) : '-'}, ${ms.toFixed(0)}ms`);
}
{
  const drumsOnly = synth({ bpm: 124, offset: 0.1, seconds: 30, pattern: house, drone: false });
  const r = detectKey(drumsOnly, sr);
  console.log(`INFO key of drums only: ${r ? keyName(r.key) + ' conf ' + r.confidence.toFixed(2) : 'none'} (any answer here is a guess; low confidence expected)`);
}
{
  // Match by ear: Eb major against C major should move down 3 (or up to the relative key,
  // never further); against the other deck playing +0.3 detuned, the fine part follows.
  const ch = (chords) => detectKey(progression(chords), sr).chroma;
  const cMaj = ch(keyCases[0].chords), ebMaj = ch(keyCases[3].chords), aMin = ch(keyCases[1].chords);
  const r1 = bestKeyShift(ebMaj, cMaj);
  const r2 = bestKeyShift(aMin, cMaj);
  const r3 = bestKeyShift(ebMaj, cMaj, 0.3);
  const ok = r1.shift === -3 && r1.fit > r1.fitNow && r2.shift === 0 && Math.abs(r3.shift + 2.7) < 1e-9;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} key match by chroma: Eb→C ${r1.shift} (fit ${r1.fit.toFixed(2)}, was ${r1.fitNow.toFixed(2)}), Am→C ${r2.shift}, detuned ${r3.shift.toFixed(2)}`);
}
{
  // Beat salience: the true grid sits firmer than a ⅔-speed or a shifted one.
  const m = synth({ bpm: 126, offset: 0.1, seconds: 40, pattern: house, drone: false });
  const o = onsetEnvelope(m, sr);
  const t = beatSalience(o, 126, 0.1), slow = beatSalience(o, 84, 0.1), off = beatSalience(o, 126, 0.1 + 30 / 126);
  const ok = t > slow * 1.1 && t > off * 1.5;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} beat salience: true ${t.toFixed(2)}, ⅔ speed ${slow.toFixed(2)}, ¼ beat off ${off.toFixed(2)}`);
}
for (const tuning of [-0.3, 0.25]) {
  const r = detectKey(progression(keyCases[0].chords, { seconds: 30, tuning }), sr);
  check(r?.key === 0 && Math.abs(r.tuning - tuning) < 0.04, `C major detuned ${tuning}: measured ${r?.tuning.toFixed(3)} semitones`);
}
{
  const tonal = [1, 0, 0.1, 0, 0.8, 0.2, 0, 0.7, 0, 0.2, 0, 0.1];
  for (const invalid of [[], Array(11).fill(1), Array(12).fill(0), Array(12).fill(1), [NaN, ...tonal.slice(1)], [-1, ...tonal.slice(1)]]) {
    check(bestKeyShift(invalid, tonal) === null, 'invalid/atonal chroma is not matched');
  }
  for (let shift = -6; shift < 6; shift++) {
    const moved = tonal.map((_, i) => tonal[((i - shift) % 12 + 12) % 12]);
    const r = bestKeyShift(moved, tonal, 0.2);
    check(Math.abs(wrap(r.shift + shift - 0.2, 12)) < 1e-9, `chroma match reverses transposition ${shift} and follows detune`);
  }
}
const camelotChecks = [[0, '8B'], [9 + 12, '8A'], [7, '9B'], [4 + 12, '9A'], [5, '7B'], [6 + 12, '11A'], [3, '5B']];
for (const [k, want] of camelotChecks) {
  const ok = camelot(k) === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} camelot ${keyName(k)} = ${camelot(k)} (want ${want})`);
}
{
  const ok = keyName(transposeKey(9 + 12, 2)) === 'Bm' && keyName(transposeKey(0, -1)) === 'B';
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} transpose Am +2 = ${keyName(transposeKey(21, 2))}, C -1 = ${keyName(transposeKey(0, -1))}`);
}

// --- time signature / downbeat: bass line moves on beat 1, kick a bit harder on beat 1
function barTrack({ bpm, offset, meter, barStart, seconds = 120 }) {
  const notes = [41, 36, 43, 38]; // bass notes, one per bar (MIDI)
  const buf = synth({
    bpm, offset, seconds, drone: false,
    pattern: (b, t, beat, add) => {
      const inBar = (((b - barStart) % meter) + meter) % meter;
      if (meter === 4) { add(t, 'kick'); add(t + beat / 2, 'hat'); if (inBar % 2) add(t, 'snare'); }
      else { if (inBar === 0) add(t, 'kick'); else add(t, 'snare'); add(t + beat / 2, 'hat'); }
      if (inBar === 0) add(t, 'kick');
    },
  });
  const beat = 60 / bpm;
  for (let i = 0; i < buf.length; i++) {
    const t = i / sr;
    const b = Math.floor((t - offset) / beat);
    if (b < 0) continue;
    const barIdx = Math.floor((b - barStart) / meter);
    buf[i] += Math.sin(2 * Math.PI * midiHz(notes[((barIdx % 4) + 4) % 4]) * t) * 0.15;
  }
  return buf;
}
const meterCases = [
  { name: '4/4, bar on beat 1', bpm: 124, offset: 0.2, meter: 4, barStart: 0 },
  { name: '4/4, bar on beat 3', bpm: 126, offset: 0.1, meter: 4, barStart: 2 },
  { name: '4/4, bar on beat 2', bpm: 120, offset: 0.3, meter: 4, barStart: 1 },
  { name: '3/4 waltz', bpm: 132, offset: 0.15, meter: 3, barStart: 1 },
];
for (const c of meterCases) {
  const r = detectMeter(barTrack(c), sr, c.bpm, c.offset);
  const bar = (c.meter * 60) / c.bpm;
  const want = (((c.offset + c.barStart * 60 / c.bpm) % bar) + bar) % bar;
  const ok = r && r.beatsPerBar === c.meter && Math.abs(r.downbeat - want) < 0.02;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} meter ${c.name}: got ${r ? `${r.beatsPerBar}/4, downbeat ${r.downbeat.toFixed(3)} (want ${want.toFixed(3)}), conf ${r.confidence.toFixed(2)}` : 'none'}`);
}

const mono = mixToMono([new Float32Array(sr*10).fill(0.5), new Float32Array(sr*10).fill(-0.5)]);
const w = computeWaveform(mono, sr); const o = overview(w, 500);
{
  // Three-band peaks: a 60 Hz tone lands in low, a 6 kHz tone in high.
  const tone = (f) => Float32Array.from({ length: sr * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / sr));
  const lo = computeWaveform(tone(60), sr), hi = computeWaveform(tone(6000), sr);
  const avg = (x) => x.slice(20, -20).reduce((s, v) => s + v, 0) / (x.length - 40);
  const ok = avg(lo.low) > 3 * avg(lo.high) && avg(hi.high) > 3 * avg(hi.low) && o.low.length === 500;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} waveform bands: 60 Hz low ${avg(lo.low).toFixed(2)} / high ${avg(lo.high).toFixed(2)}, 6 kHz low ${avg(hi.low).toFixed(2)} / high ${avg(hi.high).toFixed(2)}`);
}
console.log('waveform cols', w.peak.length, 'rate', w.rate.toFixed(1), 'overview', o.peak.length, 'phase', beatPhase(1.0, 120, 0.25).toFixed(2));
process.exit(fails ? 1 : 0);
