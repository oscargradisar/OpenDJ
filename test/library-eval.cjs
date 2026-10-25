// Library evaluation of the tempo/grid analysis against test/ground-truth.json.
// Runs analyzeTrack inside the real app page (its CSP), through analysis-worker.js, over the
// user's library, read-only. Hidden window, throwaway userData, no audio output:
//   node_modules/electron/dist/electron.exe --background test/library-eval.cjs
// Env: CDJ_SR (decode rate, default 48000), CDJ_BASELINE (per-track JSON of an older detector,
// default %TEMP%/cdj-eval-baseline.json), CDJ_EVAL_OUT (results file).
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SR = +(process.env.CDJ_SR || 48000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-libeval-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const real = path.join(process.env.APPDATA, 'Commons DJ NoGate', 'library.json');
const lib = JSON.parse(fs.readFileSync(real, 'utf8'));
const tracks = lib.tracks.filter((t) => fs.existsSync(t.file));
// The app reads audio through its own library; give it a copy so the real one is never written.
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ ...lib, tracks }));
setTimeout(() => { console.error('timeout'); app.exit(2); }, +(process.env.CDJ_TIMEOUT || 30 * 60 * 1000));
process.on('unhandledRejection', (e) => console.error('unhandled', e));
app.on('ready', () => console.error('ready'));

// ------------------------------------------------------------- in the app page
async function pageRun(list, SR) {
  const A = await import('./analysis.js');
  const ctx = new OfflineAudioContext(1, 1, SR);
  // The worker must load under the page's CSP from file://; if it can't, analyse in the page.
  let worker = null;
  let workerError = null;
  try {
    worker = new Worker(new URL('./analysis-worker.js', location.href), { type: 'module' });
    worker.onerror = (e) => { workerError = e.message || 'worker error'; };
  } catch (err) {
    workerError = String(err.message || err);
  }
  let nextId = 0;
  const viaWorker = (mono, sampleRate) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(workerError || 'worker timeout')), 20000);
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      clearTimeout(timer);
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    };
    worker.postMessage({ id, op: 'analyze', mono, sampleRate }, [mono.buffer]);
  });
  const rows = [];
  let workerOk = !!worker;
  for (const [i, t] of list.entries()) {
    const row = { i, id: t.id, title: t.title };
    try {
      const buf = await ctx.decodeAudioData(await window.cdj.library.readAudio(t.id));
      const ch = [];
      for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
      const mono = A.mixToMono(ch);
      row.duration = buf.duration;
      const t0 = performance.now();
      let res;
      if (workerOk) {
        // The worker takes ownership of what it is sent, so send a copy.
        try { res = await viaWorker(mono.slice(), buf.sampleRate); } catch (err) { workerOk = false; workerError = String(err.message || err); }
      }
      if (!res) res = A.analyzeTrack(mono, buf.sampleRate);
      row.ms = performance.now() - t0;
      row.where = workerOk ? 'worker' : 'page';
      Object.assign(row, res);
      // Drift: best grid shift in the first vs the last third (a wrong BPM makes them disagree).
      if (res.tempo && !res.tempo.variable) {
        const { env, rate } = A.onsetEnvelope(mono, buf.sampleRate);
        const at = (x) => { const p = x * rate - 0.5, k = Math.floor(p); return k < 0 || k + 1 >= env.length ? 0 : env[k] + (env[k + 1] - env[k]) * (p - k); };
        const P = 60 / res.tempo.bpm, end = env.length / rate, off = res.tempo.offset;
        const best = (a, b) => {
          let bs = 0, bv = -1;
          for (let s = -P / 4; s < P / 4; s += 0.001) { // ±¼ beat: a kick/snare swap in a half-time third is not drift
            let v = 0;
            for (let x = off + s + Math.ceil((a - off - s) / P) * P; x < b; x += P) v += at(x);
            if (v > bv) { bv = v; bs = s; }
          }
          return bs;
        };
        let d = best(end * 0.1, end * 0.4) - best(end * 0.6, end * 0.9);
        d -= (P / 2) * Math.round(d / (P / 2));
        row.driftMs = Math.abs(d) * 1000;
      }
    } catch (err) {
      row.error = String(err.message || err);
    }
    rows.push(row);
  }
  return { rows, worker: { used: workerOk, error: workerError } };
}

// ------------------------------------------------------------- scoring
const GT = JSON.parse(fs.readFileSync(path.join(__dirname, 'ground-truth.json'), 'utf8'));
const truth = new Map(GT.map((g) => [g.id, g]));
const within = (bpm, want) => Math.abs(bpm - want) / want <= 0.01;
const octave = (bpm, want) => [0.5, 1, 2].some((m) => within(bpm * m, want));
const pct = (a, n) => `${a}/${n} = ${n ? ((100 * a) / n).toFixed(1) : '-'}%`;
const quant = (xs, q) => { const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

// Scored: tracks with a confident truth, minus clearly variable songs. Even library indices
// were used to tune the thresholds; odd ones are held out.
function score(rows, bpmOf, altsOf) {
  const sets = { even: [], odd: [], all: [] };
  for (const r of rows) {
    const g = truth.get(r.id);
    if (!g || g.trueBpm == null || g.confidence === 'low' || g.variable) continue;
    const bpm = bpmOf(r) || 0;
    const ok1 = octave(bpm, g.trueBpm);
    const x = { r, g, bpm, ok1, ok0: within(bpm, g.trueBpm), altHit: !ok1 && (altsOf(r) || []).some((a) => octave(a.bpm, g.trueBpm)) };
    sets.all.push(x);
    sets[r.i % 2 ? 'odd' : 'even'].push(x);
  }
  const line = (s) => {
    const wrong = s.filter((x) => !x.ok1);
    return `Acc1 ${pct(s.filter((x) => x.ok1).length, s.length)}   Acc0 ${pct(s.filter((x) => x.ok0).length, s.length)}   truth in alts when wrong ${wrong.filter((x) => x.altHit).length}/${wrong.length}`;
  };
  return { sets, line };
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const list = tracks.map((t) => ({ id: t.id, title: t.title }));
      const { rows, worker } = await win.webContents.executeJavaScript(`(${pageRun.toString()})(${JSON.stringify(list)}, ${SR})`);
      const out = process.env.CDJ_EVAL_OUT || path.join(os.tmpdir(), `cdj-library-eval-${SR}.json`);
      fs.writeFileSync(out, JSON.stringify({ sampleRate: SR, worker, rows }, null, 1));

      const v2 = score(rows, (r) => r.tempo?.bpm, (r) => r.tempo?.alts);
      const log = (...a) => console.log(...a);
      log(`\nanalysis v2 at ${SR} Hz, ${rows.length} tracks, analysed in ${worker.used ? 'the worker' : `the page (worker failed: ${worker.error})`}`);
      const basePath = process.env.CDJ_BASELINE || path.join(os.tmpdir(), 'cdj-eval-baseline.json');
      if (fs.existsSync(basePath)) {
        const base = JSON.parse(fs.readFileSync(basePath, 'utf8'));
        const byId = new Map(base.map((b) => [b.id, b]));
        const b = score(rows, (r) => byId.get(r.id)?.bpm, () => []);
        for (const k of ['odd', 'all']) log(`baseline ${k.padEnd(4)} ${b.line(b.sets[k])}`);
      }
      for (const k of ['even', 'odd', 'all']) log(`v2       ${k.padEnd(4)} ${v2.line(v2.sets[k])}`);
      log('\nmisses (all):');
      for (const x of v2.sets.all.filter((x) => !x.ok1)) {
        const t = x.r.tempo;
        log(`  #${x.r.i} ${x.r.title.slice(0, 40).padEnd(40)} truth ${x.g.trueBpm} got ${x.bpm} (x${(x.bpm / x.g.trueBpm).toFixed(3)})` +
          ` conf ${t?.confidence?.toFixed(2)} rms ${t?.gridRms?.toFixed(1)} alts [${(t?.alts || []).map((a) => `${a.bpm}@${a.rel}`).join(' ')}]${x.altHit ? ' <- in alts' : ''}`);
      }
      const ok = rows.filter((r) => r.tempo);
      const constant = ok.filter((r) => !r.tempo.variable);
      log(`\ngridRms ms (constant grids, n=${constant.length}): median ${quant(constant.map((r) => r.tempo.gridRms), 0.5).toFixed(1)}, p90 ${quant(constant.map((r) => r.tempo.gridRms), 0.9).toFixed(1)}, max ${quant(constant.map((r) => r.tempo.gridRms), 1).toFixed(1)}`);
      log(`drift first vs last third ms: median ${quant(constant.map((r) => r.driftMs), 0.5).toFixed(1)}, p90 ${quant(constant.map((r) => r.driftMs), 0.9).toFixed(1)}, max ${quant(constant.map((r) => r.driftMs), 1).toFixed(1)}`);
      log(`variable: ${ok.filter((r) => r.tempo.variable).map((r) => r.title.slice(0, 24)).join(', ')}`);
      log(`3/4 meter: ${ok.filter((r) => r.meter?.beatsPerBar === 3).map((r) => `${r.title.slice(0, 24)} @${r.tempo.bpm}`).join(', ') || 'none'}`);
      const per4 = rows.filter((r) => r.ms).map((r) => (r.ms * 240) / r.duration);
      log(`runtime analyzeTrack per 4-min track: median ${quant(per4, 0.5).toFixed(0)} ms, max ${quant(per4, 1).toFixed(0)} ms (raw max ${quant(rows.map((r) => r.ms), 1).toFixed(0)} ms)`);
      const errors = rows.filter((r) => r.error);
      if (errors.length) log(`errors: ${errors.map((r) => `${r.title}: ${r.error}`).join('; ')}`);
      log(`results: ${out}`);
      app.exit(0);
    } catch (err) {
      console.error(err);
      app.exit(1);
    }
  });
});
require(path.join(__dirname, '..', 'src', 'main.js'));
