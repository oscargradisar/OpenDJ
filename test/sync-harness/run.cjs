// Two-deck heard-alignment harness (sync rebuild spec §5.2).
//
// Boots the real app hidden behind your windows with a throwaway library of synthetic click
// tracks whose grids are exact (wav.cjs), drives it only through its UI and keyboard, and
// records what each deck actually outputs: an AudioWorklet tap on each deck's channel fader
// (after key shift, key-lock stretch, EQ, filter and deck FX; before the crossfader), stamped
// with currentFrame. Click times come from template cross-correlation (measure.cjs). The
// alignment error e = follower click − nearest point of the leader's heard grid, in ms.
//
//   electron.exe --background test/sync-harness/run.cjs [--src <dir>] [--out <file.json>] [--only 1,3,steady]
//
// --src   the app's src folder (default: this repo's src). Point it at an exported tree, e.g.
//         git -C <repo> archive HEAD src package.json | tar -x -C <tmp>, to measure committed code.
// --out   result JSON (default: <os tmp>/opendj-sync-harness.json).
// --only  scenario numbers or names (comma-separated).
//
// Engine methods are never called (their API is being rewritten); state is only read through
// window.cdjDebug.mixer. A scenario whose control is missing reports 'n/a'. The harness's own
// maths is checked by `node test/sync-harness/selftest.cjs`.
'use strict';
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module');
const { TRACKS, clickWav } = require('./wav.cjs');
const { detectClick, align, gridVsHeard } = require('./measure.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const SRC = path.resolve(arg('src', path.join(REPO, 'src')));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'opendj-sync-harness.json')));
const ONLY = arg('only', '').split(',').filter(Boolean);
const SECONDS = 200; // track length: covers the 120 s run plus set-up

// An exported source tree has no node_modules next to it: resolve the repo's.
process.env.NODE_PATH = [path.join(REPO, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-sh-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The window sits behind yours: keep its timers at full speed, as when the app is in front.
for (const s of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(s);

const wavDir = path.join(tmp, 'sh-audio');
fs.mkdirSync(wavDir);
const rows = TRACKS.map((t) => {
  const file = path.join(wavDir, `${t.id}.wav`);
  fs.writeFileSync(file, clickWav(t, SECONDS));
  // gridSource 'user' as well, so a re-analysing build leaves the exact grids alone.
  return { id: t.id, title: t.title, artist: 'Sync harness', file, duration: SECONDS, bpm: t.bpm, beatOffset: t.beatOffset, beatsPerBar: t.beatsPerBar, downbeat: t.beatOffset, key: 0, cues: [null, null, null, null], source: { kind: 'local' }, gridVersion: 2, gridSource: 'user' };
});
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks: rows }));
const T = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

// Recorder: copies 10 ms before to 30 ms after each threshold crossing, posted with its start frame.
// It is a tap (fader → recorder → zero gain → destination), so the deck's own path is untouched.
const PROC = `class ShRec extends AudioWorkletProcessor {
  constructor() { super(); this.ring = new Float32Array(1 << 15); this.pre = Math.round(0.01 * sampleRate); this.post = Math.round(0.03 * sampleRate); this.until = -1; this.quiet = 0; }
  process(inputs) {
    const ch = inputs[0], len = ch[0] ? ch[0].length : 128, mask = this.ring.length - 1;
    for (let i = 0; i < len; i++) {
      const f = currentFrame + i;
      let v = 0; for (const c of ch) v += c[i]; if (ch.length) v /= ch.length;
      this.ring[f & mask] = v;
      if (this.until < 0 && f >= this.quiet && Math.abs(v) > 0.1) { this.trig = f; this.until = f + this.post; }
      if (this.until >= 0 && f >= this.until) {
        const s = this.trig - this.pre, w = new Float32Array(this.until - s);
        for (let k = 0; k < w.length; k++) w[k] = s + k < 0 ? 0 : this.ring[(s + k) & mask];
        this.port.postMessage({ f0: s, w }, [w.buffer]);
        this.quiet = this.trig + Math.round(0.15 * sampleRate); this.until = -1;
      }
    }
    return true;
  }
}
registerProcessor('sh-rec', ShRec);`;

const INJECT = `(async () => {
  const m = window.cdjDebug.mixer, ctx = m.ctx;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([${JSON.stringify(PROC)}], { type: 'text/javascript' })));
  const sink = ctx.createGain(); sink.gain.value = 0; sink.connect(ctx.destination);
  const H = (window.__sh = { on: false, wins: { A: [], B: [] }, snaps: { A: [], B: [] } });
  for (const n of ['A', 'B']) {
    const rec = new AudioWorkletNode(ctx, 'sh-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit' });
    rec.port.onmessage = (e) => { if (H.on) H.wins[n].push(e.data); };
    m.decks[n].fader.connect(rec);
    rec.connect(sink);
  }
  // Position snapshots for heard-vs-predicted; skipped if the clock ticked between the two reads.
  setInterval(() => {
    if (!H.on) return;
    for (const n of ['A', 'B']) {
      const d = m.decks[n], t = ctx.currentTime, pos = d.position;
      if (ctx.currentTime === t) H.snaps[n].push([t, pos, d.speed ?? d.rate, d.playing ? 1 : 0]);
    }
  }, 10);
  const detectClick = ${detectClick.toString()};
  H.take = () => {
    const out = {};
    for (const n of ['A', 'B']) {
      out[n] = { clicks: H.wins[n].map(({ f0, w }) => { const c = detectClick(w, ctx.sampleRate); return { t: f0 / ctx.sampleRate + c.t, peak: c.peak }; }), snaps: H.snaps[n] };
      H.wins[n] = []; H.snaps[n] = [];
    }
    return out;
  };
  return { sampleRate: ctx.sampleRate, baseLatency: ctx.baseLatency, outputLatency: ctx.outputLatency };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class NA extends Error {}

app.on('browser-window-created', (_e, win) => {
  const logs = [];
  win.webContents.on('console-message', (e) => ['error', 'warning'].includes(e.level) && logs.push(e.message));
  win.webContents.once('did-finish-load', async () => {
    win.webContents.setBackgroundThrottling(false);
    const js = (code) => win.webContents.executeJavaScript(code);
    // Run UI code in the page; returns the audio clock at that moment (null = control missing → n/a).
    const act = async (code) => {
      const t = await js(`(() => { const $ = (s) => document.querySelector(s); const M = window.cdjDebug.mixer; if ((() => { ${code} })() === false) return null; return M.ctx.currentTime; })()`);
      if (t == null) throw new NA(code.slice(0, 120));
      return t;
    };
    const click = (sel) => act(`const el = $(${JSON.stringify(sel)}); if (!el) return false; el.click();`);
    const tempo = (n, pct) => act(`const el = $('#deck${n} .tempo-slider'), r = $('#deck${n} .tempo-range'); if (!el || !r) return false;
      el.value = Math.round((${pct} / Number(r.value)) * 1000); el.dispatchEvent(new Event('input', { bubbles: true }));`);
    const space = async () => {
      await js('document.activeElement?.blur()');
      const t = await js('window.cdjDebug.mixer.ctx.currentTime');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await sleep(30);
      return t;
    };
    const deck = (n) => js(`(() => { const d = window.cdjDebug.mixer.decks.${n}, $ = (s) => document.querySelector('#deck${n} ' + s);
      return { track: d.track?.id ?? null, playing: d.playing, rate: d.rate, pos: d.position, keyLock: !!d.keyLock, loop: d.loop ? d.loop.beats ?? true : null,
        synced: !!$('.sync')?.classList.contains('on'), loading: !!document.querySelector('#deck${n}')?.classList.contains('loading') }; })()`);
    const toast = () => js(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).pop() || ''`);
    const load = async (n, id) => {
      await click(`tr[data-id="${id}"] [data-load="${n}"]`);
      for (let k = 0; k < 120; k++) {
        await sleep(250);
        const s = await deck(n);
        if (s.track === id && !s.loading && (await js(`!!window.cdjDebug.mixer.decks.${n}.buffer`))) return;
      }
      throw new Error(`deck ${n} did not load ${id}`);
    };
    const reset = async () => {
      for (const n of ['A', 'B']) if ((await deck(n)).playing) await click(`#deck${n} .play`);
      for (const n of ['A', 'B']) if ((await deck(n)).synced) await click(`#deck${n} .sync`);
      for (const n of ['A', 'B']) if ((await deck(n)).keyLock) await click(`#deck${n} .key-lock`);
      for (const n of ['A', 'B']) if ((await deck(n)).loop) await js(`document.querySelector('#deck${n} .lp.on')?.click()`);
      for (const n of ['A', 'B']) await tempo(n, 0);
      await sleep(300);
    };
    // A plays, B starts 1.37 s later (an arbitrary phase), both unlinked.
    const startPair = async (a, b) => {
      await load('A', a); await load('B', b);
      await click('#deckA .play'); await sleep(1370);
      const t = await click('#deckB .play'); await sleep(1500);
      return t;
    };
    const syncB = async (notes) => {
      const t = await click('#deckB .sync'); await sleep(400);
      if (!(await deck('B')).synced) notes.push(`Sync did not link: ${await toast()}`);
      return t;
    };
    const linkPair = async (a, b, notes) => { await startPair(a, b); const t = await syncB(notes); await sleep(1100); return t; };

    // Each returns the windows to measure (audio-clock seconds); `info` windows are reported but not in the totals.
    const SCEN = [
      ['sync-playing', 'Both playing, press Sync on B', async (w, notes) => {
        const tB = await startPair('sh128a', 'sh12737');
        const tS = await syncB(notes); w.push({ label: 'before sync', from: tB + 0.5, to: tS, info: true });
        await sleep(10100); w.push({ label: 'after sync', from: tS + 0.5, to: tS + 10.5 });
        return { A: 'sh128a', B: 'sh12737' };
      }],
      ['sync-paused-play-later', 'B paused, Sync, play B 3.7 s later', async (w, notes) => {
        await load('A', 'sh128a'); await load('B', 'sh12737');
        await click('#deckA .play'); await sleep(1500);
        await syncB(notes); await sleep(3300);
        const tP = await click('#deckB .play'); await sleep(10600);
        w.push({ label: 'after play', from: tP + 0.5, to: tP + 10.5 });
        return { A: 'sh128a', B: 'sh12737' };
      }],
      ['space-x5', 'Linked, space bar pause/resume ×5', async (w, notes) => {
        const tS = await linkPair('sh128a', 'sh128b', notes); await sleep(1500);
        w.push({ label: 'linked', from: tS + 0.5, to: tS + 2.5, info: true });
        for (let i = 0; i < 5; i++) {
          await space(); await sleep(300);
          const s = [await deck('A'), await deck('B')];
          if (s.some((d) => d.playing)) notes.push(`space ${i + 1}: still playing`);
          await sleep(900 + 170 * i);
          const tR = await space(); await sleep(3600);
          const r = [await deck('A'), await deck('B')];
          if (!r.every((d) => d.playing)) notes.push(`resume ${i + 1}: playing ${r.map((d) => d.playing)}`);
          w.push({ label: `resume ${i + 1}`, from: tR + 0.5, to: tR + 3.5 });
        }
        return { A: 'sh128a', B: 'sh128b' };
      }],
      ['tempo-sweep', 'Linked, leader tempo slider ±6% sine over 30 s', async (w, notes) => {
        await linkPair('sh128a', 'sh12737', notes);
        const t0 = await tempo('A', 0), wall = Date.now();
        for (let i = 1; i <= 300; i++) {
          await sleep(Math.max(0, wall + i * 100 - Date.now()));
          await tempo('A', 6 * Math.sin((2 * Math.PI * i) / 300));
        }
        const t1 = await tempo('A', 0); await sleep(3000);
        w.push({ label: 'sweep', from: t0, to: t1 }, { label: 'after sweep', from: t1 + 0.5, to: t1 + 3 });
        return { A: 'sh128a', B: 'sh12737' };
      }],
      ['keylock', 'Linked, key lock on B, B tempo +4.7% then back to 0%', async (w, notes) => {
        await linkPair('sh128a', 'sh12737', notes);
        const tK = await click('#deckB .key-lock'); await sleep(4000);
        if (!(await deck('B')).keyLock) notes.push('key lock did not turn on');
        w.push({ label: 'key lock on', from: tK + 1, to: tK + 4 });
        const t1 = await tempo('B', 4.7); await sleep(8000);
        notes.push(`rates at +4.7%: A ${(await deck('A')).rate.toFixed(5)}, B ${(await deck('B')).rate.toFixed(5)}`);
        w.push({ label: '+4.7%', from: t1 + 0.5, to: t1 + 8 });
        const t2 = await tempo('B', 0); await sleep(8000);
        w.push({ label: 'back to 0%', from: t2 + 0.5, to: t2 + 8 });
        return { A: 'sh128a', B: 'sh12737' };
      }],
      ['hotcue-midbeat', 'Linked, hot cue jump on B mid-beat', async (w, notes) => {
        const tS = await linkPair('sh128a', 'sh128b', notes);
        await click('#deckB .hc[data-i="0"]'); await sleep(3000); // empty pad: saves a cue
        const t = T.sh128b, P = 60 / t.bpm;
        // Press it again when B is half-way between two beats.
        const [tJ, ph] = await js(`new Promise((res) => { const M = window.cdjDebug.mixer, d = M.decks.B, el = document.querySelector('#deckB .hc[data-i="0"]');
          const tick = () => { const ph = ((((d.position - ${t.beatOffset}) / ${P}) % 1) + 1) % 1; if (ph > 0.45 && ph < 0.55) { el.click(); res([M.ctx.currentTime, ph]); } else setTimeout(tick, 1); }; tick(); })`);
        notes.push(`jumped at phase ${ph.toFixed(3)}`);
        await sleep(8000);
        w.push({ label: 'before jump', from: tS + 0.5, to: tJ, info: true }, { label: 'after jump', from: tJ + 0.5, to: tJ + 8 });
        return { A: 'sh128a', B: 'sh128b' };
      }],
      ['loop-8-4-exit', 'Linked, loop 8 beats on B, then 4, then exit', async (w, notes) => {
        await linkPair('sh128a', 'sh128b', notes); await sleep(1000);
        const t8 = await click('#deckB .lp[data-beats="8"]'); await sleep(6000);
        const t4 = await click('#deckB .lp[data-beats="4"]'); await sleep(6000);
        if ((await deck('B')).loop !== 4) notes.push(`loop after 4: ${(await deck('B')).loop}`);
        const tX = await click('#deckB .lp[data-beats="4"]'); await sleep(6000);
        if ((await deck('B')).loop) notes.push('loop did not exit');
        w.push({ label: 'loop 8', from: t8 + 0.5, to: t4 }, { label: 'loop 4', from: t4 + 0.5, to: tX }, { label: 'exited', from: tX + 0.5, to: tX + 6 });
        return { A: 'sh128a', B: 'sh128b' };
      }],
      ['steady-120s', 'Linked 128.00 vs 127.37, 120 s steady run (drift)', async (w, notes) => {
        const tS = await linkPair('sh128a', 'sh12737', notes);
        await sleep(120000);
        w.push({ label: '120 s', from: tS + 1.5, to: tS + 121 });
        return { A: 'sh128a', B: 'sh12737' };
      }],
      ['half-time', '128 (A) vs 64 (B), Sync on B', async (w, notes) => {
        await startPair('sh128a', 'sh64');
        const tS = await syncB(notes); await sleep(15100);
        notes.push(`B rate ${(await deck('B')).rate.toFixed(5)}`);
        w.push({ label: 'after sync', from: tS + 0.5, to: tS + 15 });
        return { A: 'sh128a', B: 'sh64' };
      }],
      ['three-four', '4/4 at 128 (A) vs 3/4 at 120 (B), Sync on B (beat sync)', async (w, notes) => {
        await startPair('sh128a', 'sh120w');
        const tS = await syncB(notes); await sleep(15100);
        notes.push(`B rate ${(await deck('B')).rate.toFixed(5)}; toast: ${await toast()}`);
        w.push({ label: 'after sync', from: tS + 0.5, to: tS + 15 });
        return { A: 'sh128a', B: 'sh120w' };
      }],
    ];

    const result = { src: SRC, started: new Date().toISOString(), electron: process.versions.electron, scenarios: [] };
    const finish = (code) => {
      // One line per scenario, also printed, for a quick read.
      result.table = result.scenarios.map((s) => {
        const a = s.align, g = s.gridVsHeard;
        return `${String(s.id).padStart(2)} ${s.name.padEnd(24)} ` + (s.status || (s.error ? 'error' : a?.n ? `n=${a.n} p50=${a.p50} p95=${a.p95} max=${a.max} mean=${a.mean} slope=${a.slope}ms/min heard-pred A=${g.A.medianMs} B=${g.B.medianMs}` : 'no clicks'));
      });
      console.log(result.table.join('\n'));
      result.logs = logs.slice(0, 50);
      result.libraryAfter = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8')).tracks.map((t) => ({ id: t.id, bpm: t.bpm, beatOffset: t.beatOffset, cues: t.cues }));
      fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
      try { fs.rmSync(wavDir, { recursive: true, force: true }); } catch {} // ~100 MB of WAVs per run
      app.exit(code);
    };
    setTimeout(() => { result.error = 'timed out'; finish(2); }, 20 * 60 * 1000);
    try {
      for (let k = 0; k < 100 && !(await js(`!!document.querySelector('tr[data-id="sh128a"] [data-load="A"]') && !!window.cdjDebug`)); k++) await sleep(200);
      result.audio = await js(INJECT);
      for (const [i, [name, desc, fn]] of SCEN.entries()) {
        if (ONLY.length && !ONLY.includes(String(i + 1)) && !ONLY.includes(name)) continue;
        const r = { id: i + 1, name, desc, notes: [] };
        result.scenarios.push(r);
        try {
          await reset();
          await js('window.__sh.take(); window.__sh.on = true');
          const windows = [];
          const decks = await fn(windows, r.notes);
          await js('window.__sh.on = false');
          const rec = await js('window.__sh.take()');
          r.tracks = decks;
          r.clicks = { A: rec.A.clicks.length, B: rec.B.clicks.length };
          r.align = align(rec.A.clicks, rec.B.clicks, windows);
          r.gridVsHeard = { A: gridVsHeard(rec.A.clicks, rec.A.snaps, T[decks.A]), B: gridVsHeard(rec.B.clicks, rec.B.snaps, T[decks.B]) };
        } catch (e) {
          await js('window.__sh.on = false');
          if (e instanceof NA) { r.status = 'n/a'; r.reason = `control missing: ${e.message}`; } else r.error = String(e.stack || e);
        }
      }
      result.audio.outputLatencyAtEnd = await js('window.cdjDebug.mixer.ctx.outputLatency');
    } catch (e) { result.error = String(e.stack || e); }
    finish(0);
  });
});

require(path.join(SRC, 'main.js'));
