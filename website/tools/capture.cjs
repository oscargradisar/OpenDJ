// Marketing screenshots of the real app, into website/img/.
// Run from the repo root:  npx electron website/tools/capture.cjs --background
// Uses a throwaway userData dir: the real library (%APPDATA%/Commons DJ NoGate) is only read.
const { app } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const out = path.join(__dirname, '..', 'img'); fs.mkdirSync(out, { recursive: true });
// The running app keeps its profile locked, so each run clears the previous runs' profiles instead.
for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('cdj-shots-')) try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch {}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdj-shots-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const real = path.join(process.env.APPDATA, 'Commons DJ NoGate');
const lib = JSON.parse(fs.readFileSync(path.join(real, 'library.json'), 'utf8'));
const vids = new Set(fs.readdirSync(path.join(real, 'videos')).filter((f) => f.endsWith('.mp4')).map((f) => f.slice(0, -4)));
// Decks: A/B close in tempo for the synced hero shot, C/D for 4-deck mode. All have cached videos.
const want = ['fbed8c08e105d028', '8f28890f0ea571e7', '73cbff68da16c16f', '29db7279a0f924e1'];
const byId = new Map(lib.tracks.map((t) => [t.id, t]));
const decks = want.filter((id) => byId.has(id) && vids.has(id));
if (decks.length < 4) throw new Error('missing tracks/videos for: ' + want.filter((id) => !decks.includes(id)).join(', '));
// The library list: web tracks only (they have thumbnails), video tracks first, no cue history.
const web = lib.tracks.filter((t) => t.source?.kind === 'web');
const list = [...web.filter((t) => vids.has(t.id)), ...web.filter((t) => !vids.has(t.id))].slice(0, 14).map((t) => ({ ...t, cues: [] }));
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks: list }));
fs.mkdirSync(path.join(tmp, 'videos'), { recursive: true });
for (const id of decks) fs.copyFileSync(path.join(real, 'videos', id + '.mp4'), path.join(tmp, 'videos', id + '.mp4'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1440, H = 900;

app.on('browser-window-created', (_e, win) => {
  const logs = [];
  win.webContents.on('console-message', (e) => ['error', 'warning'].includes(e.level) && logs.push(e.message));
  win.webContents.once('did-finish-load', async () => {
    const js = (c) => win.webContents.executeJavaScript(c);
    const M = 'window.cdjDebug.mixer';
    const rect = (sel) => js(`(() => { const b = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
    // Device pixels -> CSS size, so PNGs stay small on high-DPI screens.
    const shot = async (name, r) => {
      let img = await win.webContents.capturePage(r);
      const w = r ? r.width : W;
      if (img.getSize().width > w) img = img.resize({ width: w, quality: 'best' });
      fs.writeFileSync(path.join(out, name), img.toPNG());
      res.files.push(name);
    };
    const load = async (id, d) => {
      await js(`document.querySelector('tr[data-id="${id}"] [data-load="${d}"]').click()`);
      for (let k = 0; k < 60 && !(await js(`${M}.decks.${d}.buffer ? 1 : 0`)); k++) await sleep(500);
    };
    const setDecks = (n) => js(`document.querySelector('#deckCountSeg [data-decks="${n}"]').click()`);
    const theme = (t) => js(`document.querySelector('.theme-card[data-theme="${t}"]').click()`);
    const res = { files: [] };
    try {
      win.setContentSize(W, H); await sleep(1500);
      await theme('dark'); await setDecks(2); await sleep(500);
      await load(decks[0], 'A'); await load(decks[1], 'B');
      await js(`document.querySelector('#deckA .play').click()`); await sleep(1500);
      await js(`document.querySelector('#deckB .play').click()`); await sleep(800);
      await js(`document.querySelector('#deckB .sync').click()`);
      // A few hot cues and effects, so the deck crop shows them in use.
      for (const i of [0, 1, 2]) { await js(`document.querySelector('#deckA .hc[data-i="${i}"]').click()`); await sleep(900); }
      await js(`document.querySelector('#deckB .hc[data-i="0"]').click()`);
      const fxOn = (d, fx) => js(`document.querySelector('#deck${d} .fx[data-fx="${fx}"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await fxOn('A', 'gate'); await fxOn('A', 'reverb'); await fxOn('B', 'flanger');
      await sleep(2500);
      res.synced = await js(`[${M}.decks.A.playing, ${M}.decks.B.playing]`);
      await shot('hero.png');
      await js(`document.querySelector('#settingsDialog').showModal()`); await sleep(600);
      await shot('settings.png');
      await js(`document.querySelector('#settingsDialog').close()`);

      await theme('aloe'); await sleep(1200);
      await shot('theme-aloe.png');
      await theme('mist'); await sleep(1200);
      await shot('theme-mist.png');
      await theme('dark');

      // Videos off for the crop (a real setting), so the centre panel doesn't overlap the deck's edge.
      const mv = (v) => js(`document.querySelector('#mvSeg [data-mv="${v}"]').click()`);
      await mv('off'); await sleep(800);
      // The app zooms its page to fit the window: CSS px -> window px for capturePage.
      const z = win.webContents.getZoomFactor(), a = await rect('#deckA');
      await shot('deck-closeup.png', { x: Math.floor(a.x * z), y: Math.floor(a.y * z), width: Math.ceil(a.width * z), height: Math.ceil(a.height * z) });
      await mv('on'); await sleep(1200);

      await setDecks(4); await sleep(600);
      await load(decks[2], 'C'); await load(decks[3], 'D');
      await js(`document.querySelector('#deckC .play').click(); document.querySelector('#deckD .play').click()`);
      await sleep(2500);
      res.mv4 = await rect('#mvCenter');
      await shot('four-decks.png');
      await setDecks(2); // leave the throwaway profile as found
    } catch (e) { res.error = String(e.stack || e); }
    res.logs = logs;
    console.log(JSON.stringify(res, null, 2));
    app.exit(res.error ? 1 : 0);
  });
});
require(path.join(__dirname, '..', '..', 'src', 'main.js'));
