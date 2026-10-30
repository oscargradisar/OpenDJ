// Temporary app entry: boots the real app with a throwaway data folder holding
// one real track and the AI stem model, loads it on deck A, waits for the
// separation, then checks the stems and the buttons. Env:
//   CDJ_AI_TRACK  path to an audio file (copied, never modified)
//   CDJ_AI_MODEL  path to htdemucs_fp16weights.onnx
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-ai-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

fs.mkdirSync(path.join(tmp, 'models'), { recursive: true });
fs.copyFileSync(process.env.CDJ_AI_MODEL, path.join(tmp, 'models', 'htdemucs_fp16weights.onnx'));
const track = path.join(tmp, 'track' + path.extname(process.env.CDJ_AI_TRACK));
fs.copyFileSync(process.env.CDJ_AI_TRACK, track);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks: [
  { id: 'ai1', title: 'AI test track', artist: 'test', file: track, duration: null, bpm: null, beatOffset: null, cues: [null, null, null, null], source: { kind: 'local' } },
] }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

app.on('browser-window-created', (_e, win) => {
  win.webContents.on('console-message', (e) => logs.push(`[${e.level}] ${e.message}`));
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const label = () => js(`document.querySelector('#deckA .stemrow .label').textContent`);
    const report = { tmp };
    try {
      await sleep(1000);
      await js(`document.querySelector('tr[data-id="ai1"] [data-load="A"]').click()`);
      // Wait for the track to load, then play while separation runs.
      for (let i = 0; i < 60 && !(await js(`document.querySelector('#deckA .t-title').textContent === 'AI test track' && !document.querySelector('#deckA').classList.contains('loading')`)); i++) await sleep(500);
      report.duration = await js(`document.querySelector('#deckA .remain').textContent`);
      await js(`document.querySelector('#deckA .play').click()`);
      await js(`document.querySelector('#aiChip').click()`); // new separation is explicitly requested
      const t0 = Date.now();
      report.progress = [];
      let ticks = 0;
      while (Date.now() - t0 < 900000) {
        const l = await label();
        if (report.progress[report.progress.length - 1] !== l) report.progress.push(l);
        if (l === 'Stems · AI') break;
        if (await js(`[...document.querySelectorAll('.toast.error')].some(t => /AI stems/.test(t.textContent))`)) break;
        // UI responsiveness probe while separating: the elapsed clock must keep moving.
        if (ticks++ === 10) report.clockWhileSeparating = [await js(`document.querySelector('#deckA .elapsed').textContent`)];
        if (ticks === 14) report.clockWhileSeparating.push(await js(`document.querySelector('#deckA .elapsed').textContent`));
        await sleep(1000);
      }
      report.separationSeconds = Math.round((Date.now() - t0) / 1000);
      report.finalLabel = await label();
      report.toasts = await js(`[...document.querySelectorAll('.toast')].map(t => t.textContent)`);
      const dir = path.join(tmp, 'stems', 'ai1');
      report.files = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `${f} ${(fs.statSync(path.join(dir, f)).size / 1e6).toFixed(1)} MB`) : [];
      await sleep(1500);
      report.stillPlaying = await js(`document.querySelector('#deckA .play').classList.contains('on')`);
      // Buttons with AI stems: solo vocals, then drums off, then reset.
      await js(`document.querySelector('#deckA .stem[data-stem="vocals"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`);
      await sleep(800);
      report.soloVox = await js(`[...document.querySelectorAll('#deckA .stem')].map(b => b.dataset.stem + ':' + (b.classList.contains('off') ? 'off' : 'on')).join(' ')`);
      fs.writeFileSync(path.join(outDir, 'ai-1.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#deckA .stem[data-stem="drums"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
      // Second load of the same track must use the cache (no re-separation).
      await js(`document.querySelector('#deckA .play').click()`);
      await sleep(300);
      await js(`document.querySelector('tr[data-id="ai1"] [data-load="B"]').click()`);
      const t1 = Date.now();
      let lb = '';
      for (let i = 0; i < 60; i++) {
        lb = await js(`document.querySelector('#deckB .stemrow .label').textContent`);
        if (lb === 'Stems · AI') break;
        await sleep(500);
      }
      report.cachedLoad = { label: lb, seconds: Math.round((Date.now() - t1) / 100) / 10 };
    } catch (err) {
      report.error = String((err && err.stack) || err);
    }
    report.logs = logs;
    fs.writeFileSync(path.join(outDir, 'ai-report.json'), JSON.stringify(report, null, 2));
    app.exit(0);
  });
});

require('../src/main.js');
