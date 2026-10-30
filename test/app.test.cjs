const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
  // Run the real startup reader with a stub filesystem: bad libraries must never become empty libraries.
  const mainSource = fs.readFileSync('src/main.js', 'utf8');
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
  const stalled = ctx.analyse('prepare', [new Float32Array(1)], 48000, {});
  const timedOut = assert.rejects(stalled, /timed out/);
  await new Promise(resolve => setTimeout(resolve, 10));
  timeout();
  await timedOut;
  assert.equal(vm.runInContext('analysisWaiting.size', ctx), 0, 'a stuck worker cannot leave decks loading forever');
  console.log('all library and analysis-worker regression tests passed');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
