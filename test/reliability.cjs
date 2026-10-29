// Real renderer/IPC checks with a disposable library; never opens the user's library.
const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TRACKS, clickWav } = require('./sync-harness/wav.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-reliability-'));
const out = path.resolve(__dirname, '../out');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const file = path.join(tmp, 'click.wav');
fs.writeFileSync(file, clickWav(TRACKS[0], 40));
const chroma = [1, 0, 0.1, 0, 0.8, 0.2, 0, 0.7, 0, 0.2, 0, 0.1];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks:
  ['slow', 'fast', 'other'].map(id => ({ id, file, title: id, artist: 'Test', duration: 40,
    bpm: 128, beatOffset: 0, beatsPerBar: 4, downbeat: 0, gridSource: 'user',
    key: 0, chroma, tuning: id === 'other' ? 0.2 : -0.1, keyVersion: 4, source: { kind: 'local' } }))
}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
  if (channel === 'library:readAudio' && args[1] === 'slow') await sleep(300);
  if (channel === 'ytdlp:status') return { installed: false }; // no network needed
  return fn(...args);
});
const watchdog = setTimeout(() => { console.error('UI test timed out'); app.exit(1); }, 60000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false);
  const errors = [];
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const wait = async code => {
      for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(50); }
      throw new Error(`Timed out: ${code}`);
    };
    try {
      await wait(`!!document.querySelector('tr[data-id="fast"]') && !!window.cdjDebug`);
      await click('tr[data-id="slow"] [data-load="A"]');
      await click('tr[data-id="fast"] [data-load="A"]');
      await wait(`window.cdjDebug.mixer.decks.A.track?.id === 'fast' && !document.querySelector('#deckA').classList.contains('loading')`);
      await sleep(600);
      assert.equal(await js('window.cdjDebug.mixer.decks.A.track.id'), 'fast', 'latest load wins');
      await click('tr[data-id="other"] [data-load="B"]');
      await wait(`window.cdjDebug.mixer.decks.B.track?.id === 'other'`);
      await click('#deckA .play');
      await sleep(400);
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'q', bubbles:true}))`);
      assert.equal(await js('window.cdjDebug.mixer.decks.A.bendFactor'), 0.96);
      await js(`window.dispatchEvent(new Event('blur'))`);
      assert.equal(await js('window.cdjDebug.mixer.decks.A.bendFactor'), 1, 'focus loss releases nudge');
      await click('#deckB .key-match');
      assert.equal(await js('window.cdjDebug.mixer.decks.B.keyShift'), -0.3, 'Match includes both recordings tuning');
      await click('#deckB .key-match');
      assert.equal(await js('window.cdjDebug.mixer.decks.B.keyShift'), -0.3, 'repeated Match is stable');
      await click('#deckB .sync');
      assert.equal(await js(`document.querySelector('#deckB .sync').getAttribute('aria-pressed')`), 'true');
      await click('#deckCountSeg [data-decks="4"]');
      await click('tr[data-id="fast"] [data-load="C"]');
      await wait(`!!window.cdjDebug.mixer.decks.C.buffer`);
      await click('#deckC .play');
      await sleep(400);
      const meter = await js(`document.querySelector('.strip[data-deck="C"] .meter-peak').style.bottom`);
      assert.ok(meter && !meter.includes('NaN'), 'four-deck peak meter has a finite position');
      await click('#deckCountSeg [data-decks="2"]');
      assert.equal(await js('window.cdjDebug.mixer.decks.C.playing'), false, 'hidden deck stops');
      await click('#deckB .play');
      await sleep(1200);
      fs.writeFileSync(path.join(out, 'mix-review.png'), (await win.webContents.capturePage()).toPNG());
      assert.deepEqual(errors, [], 'renderer has no errors');
      console.log('all real UI reliability checks passed');
      clearTimeout(watchdog);
      app.exit(0);
    } catch (err) {
      console.error(err, errors);
      clearTimeout(watchdog);
      app.exit(1);
    }
  });
});
const srcIndex = process.argv.indexOf('--src');
require(path.resolve(srcIndex >= 0 ? process.argv[srcIndex + 1] : path.join(__dirname, '../src'), 'main.js'));
