// Drop full-length stereo songs into both decks and keep probing the renderer.
const { app, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { TRACKS, clickWav } = require('./sync-harness/wav.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-drop-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-audio-output');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
for (const flag of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(flag);
const seconds = 450;
const mono = clickWav(TRACKS[0], seconds);
const stereo = Buffer.alloc(44 + (mono.length - 44) * 2);
mono.copy(stereo, 0, 0, 44);
stereo.writeUInt32LE(stereo.length - 8, 4);
stereo.writeUInt16LE(2, 22);
stereo.writeUInt32LE(44100 * 4, 28);
stereo.writeUInt16LE(4, 32);
stereo.writeUInt32LE(stereo.length - 44, 40);
for (let i = 44; i < mono.length; i += 2) {
  const sample = mono.readInt16LE(i), offset = 44 + (i - 44) * 2;
  stereo.writeInt16LE(sample, offset);
  stereo.writeInt16LE(Math.round(sample * 0.8), offset + 2);
}
const file = path.join(tmp, 'long-stereo.wav');
fs.writeFileSync(file, stereo);
const ids = ['first', 'replacement', 'second'];
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 1, tracks: ids.map(id => ({
  id, file, title: id, artist: 'Drop regression', duration: seconds, bpm: 128,
  beatOffset: 0.123, downbeat: 0.123, beatsPerBar: 4, gridSource: 'user',
  key: 0, keyVersion: 4, source: { kind: 'local' },
})) }));
let separations = 0;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, (...args) => {
  if (channel === 'ytdlp:status') return { installed: false };
  if (channel === 'stems:setup') return { runtime: true, model: true };
  if (channel === 'stems:status') return { available: true, ready: false };
  if (channel === 'stems:separate') { separations++; throw new Error('New AI jobs must not start on drop'); }
  return fn(...args);
});
const watchdog = setTimeout(() => { console.error('Drop test timed out'); app.exit(1); }, 60000);
app.on('browser-window-created', (_e, win) => {
  const errors = [];
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Profiler.enable');
      await win.webContents.debugger.sendCommand('Profiler.start');
      await js(`window.__dropProbe = { last: performance.now(), maxGap: 0, ticks: 0 }; setInterval(() => {
        const p = window.__dropProbe, now = performance.now(); p.maxGap = Math.max(p.maxGap, now - p.last); p.last = now; p.ticks++;
      }, 10)`);
      const drop = (deck, id) => js(`{ const data = new DataTransfer(); data.setData('text/x-cdj-track', '${id}');
        document.querySelector('#deck${deck}').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })); }`);
      await drop('A', 'first');
      await new Promise(resolve => setTimeout(resolve, 100));
      await drop('A', 'replacement');
      await drop('B', 'second');
      let loaded = false;
      for (let i = 0; i < 300; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        loaded = await js(`window.cdjDebug.mixer.decks.A.track?.id === 'replacement' && window.cdjDebug.mixer.decks.B.track?.id === 'second' && !document.querySelector('.deck.loading')`);
        if (loaded) break;
      }
      assert.equal(loaded, true, 'both full-length drops finish, keeping the latest selection');
      await new Promise(resolve => setTimeout(resolve, 300));
      const probe = await js('window.__dropProbe');
      const { profile } = await win.webContents.debugger.sendCommand('Profiler.stop');
      if (probe.maxGap >= 750) {
        const out = path.resolve(__dirname, '../out');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'drop-profile.json'), JSON.stringify(profile));
        console.log('Load CPU samples:', profile.nodes.filter(n => n.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 15).map(n => ({ ...n.callFrame, hits: n.hitCount })));
      }
      assert.ok(probe.ticks > 10 && probe.maxGap < 750, `renderer stalled for ${probe.maxGap.toFixed(0)} ms`);
      assert.equal(separations, 0, 'installed AI must not start new separation on drop');
      assert.equal(await js(`document.querySelector('#aiChip').textContent`), 'Prepare AI stems');
      assert.equal(await js(`Object.values(window.cdjDebug.mixer.decks).filter(d => d.buffer).every(d => d.buffer.getChannelData(0).byteLength > 0)`), true, 'playback audio stays attached');
      assert.deepEqual(errors, []);
      console.log(`full-length stereo drop checks passed; longest UI gap ${probe.maxGap.toFixed(1)} ms`);
      clearTimeout(watchdog);
      app.exit(0);
    } catch (err) { console.error(err, errors); clearTimeout(watchdog); app.exit(1); }
  });
});
const srcIndex = process.argv.indexOf('--src');
require(path.resolve(srcIndex >= 0 ? process.argv[srcIndex + 1] : path.join(__dirname, '../src'), 'main.js'));
