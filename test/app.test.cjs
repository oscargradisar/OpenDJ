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
  const ctx = vm.createContext({
    URL, console, analyzeTrack: () => 'fallback', detectKey() {}, onsetEnvelope() {}, fitGridAt() {},
    Worker: class { constructor() { ctx.worker = this; } postMessage() {} terminate() { this.terminated = true; } },
  });
  vm.runInContext(workerCode.replace('import.meta.url', "'file:///app.js'"), ctx);
  const first = ctx.analyse('analyze', new Float32Array(1), 48000);
  const second = ctx.analyse('key', new Float32Array(1), 48000);
  const rejected = Promise.all([assert.rejects(first, /analysis stopped/), assert.rejects(second, /analysis stopped/)]);
  ctx.worker.onerror({ preventDefault() {} });
  await rejected;
  assert.equal(ctx.worker.terminated, true);
  assert.equal(await ctx.analyse('analyze', new Float32Array(1), 48000), 'fallback');
  assert.equal(vm.runInContext('analysisWaiting.size', ctx), 0);
  vm.runInContext('analysisWorker = new Worker()', ctx);
  ctx.worker.postMessage = () => { throw new Error('clone failed'); };
  await assert.rejects(ctx.analyse('analyze', new Float32Array(1), 48000), /clone failed/);
  assert.equal(vm.runInContext('analysisWaiting.size', ctx), 0, 'a failed post does not leak a pending job');
  console.log('all library and analysis-worker regression tests passed');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
