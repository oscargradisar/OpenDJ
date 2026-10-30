const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  // Run the real startup reader with a stub filesystem: bad libraries must never become empty libraries.
  const mainSource = fs.readFileSync('src/main.js', 'utf8');
  {
    const handlers = new Map();
    const file = require('node:path').resolve('audio with spaces #1.wav');
    const pathToFileURL = require('node:url').pathToFileURL;
    const ctx = vm.createContext({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
      findTrack: id => id === 'track' ? { file } : null, pathToFileURL });
    vm.runInContext(mainSource.slice(mainSource.indexOf('function registerIpc()'), mainSource.indexOf('// ---------------------------------------------------------------- window')), ctx);
    ctx.registerIpc();
    assert.equal(await handlers.get('library:readAudio')(null, 'track'), pathToFileURL(file).href);
    await assert.rejects(handlers.get('library:readAudio')(null, 'missing'), /Track not found/);
    let api;
    const bytes = new ArrayBuffer(4);
    const electron = { contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async () => pathToFileURL(file).href } };
    const bridge = vm.createContext({ require: () => electron, fetch: async url => {
      assert.equal(url, pathToFileURL(file).href);
      return { ok: true, arrayBuffer: async () => bytes };
    } });
    vm.runInContext(fs.readFileSync('src/preload.js', 'utf8'), bridge);
    assert.equal(await api.library.audioUrl('track'), pathToFileURL(file).href, 'normal loads pass only a URL through the bridge');
    assert.equal(await api.library.readAudio('track'), bytes, 'the public audio API still returns bytes');
    bridge.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(api.library.readAudio('track'), /Could not read audio/);
  }
  const reader = mainSource.slice(mainSource.indexOf('async function loadLibrary()'), mainSource.indexOf('let saveTimer'));
  for (const value of ['broken JSON', '{}', '{"tracks":[{}]}', '{"tracks":null}']) {
    const ctx = vm.createContext({ paths: { library: 'library.json' }, fsp: { readFile: async () => value } });
    vm.runInContext(reader, ctx);
    await assert.rejects(ctx.loadLibrary());
  }
  for (const missing of [false, true]) {
    const ctx = vm.createContext({ paths: {}, fsp: { readFile: async () => {
      if (missing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return '{"tracks":[]}';
    } } });
    vm.runInContext(reader, ctx);
    await ctx.loadLibrary();
  }
  {
    const ctx = vm.createContext({ paths: {}, fsp: { readFile: async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); } } });
    vm.runInContext(reader, ctx);
    await assert.rejects(ctx.loadLibrary(), /access denied/);
  }

  const source = fs.readFileSync('src/renderer/app.js', 'utf8');
  {
    let observer, reads = 0;
    const ctx = vm.createContext({ window: { devicePixelRatio: 1 },
      ResizeObserver: class { constructor(callback) { observer = callback; } observe() {} } });
    vm.runInContext(source.slice(source.indexOf('const canvasSizes ='), source.indexOf('// Three-colour waveforms')), ctx);
    const canvas = { width: 0, height: 0, get clientWidth() { reads++; return 100; }, get clientHeight() { reads++; return 50; } };
    assert.equal(ctx.fitCanvas(canvas), true);
    assert.equal(ctx.fitCanvas(canvas), false);
    assert.equal(reads, 2, 'animation frames do not repeatedly force layout');
    observer([{ target: canvas, contentRect: { width: 120, height: 80 } }]);
    ctx.window.devicePixelRatio = 2;
    assert.equal(ctx.fitCanvas(canvas), true);
    assert.equal(canvas.width, 240);
    assert.equal(canvas.height, 160);
    assert.equal(reads, 2, 'resize and display-scale changes use the observed size');
  }
  {
    let separated = 0, cached = 0;
    const track = { id: 'test' };
    const ctx = vm.createContext({
      api: { stems: { status: async () => ({ available: true, ready: false }), separate: async () => { separated++; } } },
      state: { stemJobs: new Map() }, DECKS: [], mixer: { decks: {} },
      toModelPcm: async () => [new Float32Array(1), new Float32Array(1)],
      loadAiStems: async () => { cached++; }, renderStems() {}, toast() {}, console,
    });
    vm.runInContext(source.slice(source.indexOf('async function prepareAiStems('), source.indexOf('function matchKey(')), ctx);
    await ctx.prepareAiStems('A', track, {}, { cachedOnly: true });
    assert.equal(separated, 0, 'loading cannot start a new AI job');
    await ctx.prepareAiStems('A', track, {});
    assert.equal(separated, 1, 'explicit AI preparation still works');
    ctx.api.stems.status = async () => ({ available: true, ready: true });
    await ctx.prepareAiStems('A', track, {}, { cachedOnly: true });
    assert.equal(cached, 1, 'cached AI stems still load automatically');
  }
  {
    const a = { name: 'A', playing: true }, b = { name: 'B', playing: false };
    let inspected;
    const ctx = vm.createContext({ mixer: { decks: { A: a, B: b } }, group: {
      members: new Map([[a, {}], [b, {}]]), listen: d => { inspected = d; },
    } });
    vm.runInContext(source.slice(source.indexOf('function listenAndTell('), source.indexOf('const fmtSemis')), ctx);
    ctx.listenAndTell('A');
    assert.equal(inspected, b, 'joining through the on-air deck corrects the paused partner');
  }
  const workerCode = source.slice(source.indexOf('let analysisWorker ='), source.indexOf('// Grids made by an older'));
  let timeout;
  const deadline = {};
  const ctx = vm.createContext({
    URL, console,
    setTimeout: (fn, ms) => ms === 30000 ? (timeout = fn, deadline) : setTimeout(fn, ms),
    clearTimeout: id => { if (id !== deadline) clearTimeout(id); },
    Worker: class { constructor() { ctx.worker = this; } postMessage() {} terminate() { this.terminated = true; } },
  });
  vm.runInContext(workerCode.replace('import.meta.url', "'file:///app.js'"), ctx);
  const first = ctx.analyse('analyze', new Float32Array(1), 48000);
  const second = ctx.analyse('key', new Float32Array(1), 48000);
  const rejected = Promise.all([assert.rejects(first, /analysis stopped/), assert.rejects(second, /analysis stopped/)]);
  await new Promise(resolve => setTimeout(resolve, 10));
  ctx.worker.onerror({ preventDefault() {} });
  await rejected;
  assert.equal(ctx.worker.terminated, true);
  assert.equal(vm.runInContext('analysisWaiting.size', ctx), 0);
  const restart = ctx.analyse('analyze', new Float32Array(1), 48000);
  await new Promise(resolve => setTimeout(resolve, 10));
  ctx.worker.onmessage({ data: { id: 3, result: 'restarted' } });
  assert.equal(await restart, 'restarted', 'a failed worker is recreated instead of blocking the UI');
  ctx.worker.postMessage = () => { throw new Error('clone failed'); };
  await assert.rejects(ctx.analyse('analyze', new Float32Array(1), 48000), /clone failed/);
  assert.equal(vm.runInContext('analysisWaiting.size', ctx), 0, 'a failed post does not leak a pending job');
  ctx.worker.postMessage = () => {};
  const input = { numberOfChannels: 1, length: 1, copyFromChannel: (out) => { out[0] = 0.5; } };
  const stalled = ctx.analyse('prepare', input, 48000, {});
  const timedOut = assert.rejects(stalled, /timed out/);
  await new Promise(resolve => setTimeout(resolve, 10));
  timeout();
  await timedOut;
  assert.equal(vm.runInContext('analysisWaiting.size', ctx), 0, 'a stuck worker cannot leave decks loading forever');
  console.log('all library and analysis-worker regression tests passed');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
