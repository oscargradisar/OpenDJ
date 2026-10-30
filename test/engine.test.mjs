import assert from 'node:assert/strict';
import { Deck } from '../src/renderer/engine.js';

// Exercise the actual transport methods without needing an audio device.
const deck = () => Object.assign(Object.create(Deck.prototype), {
  ctx: { currentTime: 10 }, buffer: { duration: 600 }, track: { bpm: 120, beatOffset: 0 },
  playing: true, startPos: 30, startTime: 0, rate: 1, appliedSpeed: 1,
  bendFactor: 1, sources: [], lead: 0, loop: null, keyShift: 0, keyLock: false,
  fxChain: { syncGate() {} }, emit() {}, sendFx() {},
});

for (const change of [d => d.setRate(1.08), d => d.bend(0.04)]) {
  const d = deck();
  const before = d.position;
  change(d);
  assert.equal(d.position, before, 'tempo and bend preserve the current position');
  d.ctx.currentTime += 2;
  assert.equal(d.position, before + 2 * d.speed);
  const bent = d.position;
  d.endBend();
  assert.equal(d.position, bent, 'releasing a nudge preserves position');
}
{
  const d = deck();
  d.lead = 0.1;
  d.setRate(1.1);
  assert.ok(Math.abs(d.position - 39.99) < 1e-9, 'latency compensation uses the old speed');
}
{
  const d = deck();
  d.startTime = 12;
  d.startSource = (at, when) => { d.restarted = { at, when }; };
  d.restartInPlace();
  assert.deepEqual(d.restarted, { at: 30, when: 12 }, 'routing changes preserve a cued future start');
}
{
  const d = deck();
  d.playing = false;
  d.pausedPos = 600;
  d.startSource = (at) => { d.startedAt = at; };
  d.mixer = { resume() {} };
  d.play({ at: 600, when: 11 });
  assert.equal(d.startedAt, 0, 'replaying an ended synced deck starts from zero');
}
{
  const d = deck(), other = deck();
  d.track.key = 2 + 12; // D minor
  other.track.key = 9 + 12; // A minor
  d.track.tuning = -0.2;
  other.track.tuning = 0.15;
  assert.equal(d.matchKeyTo(other), -4.65, 'key match compensates both recordings tuning');
  assert.equal(d.keyLock, true);
}
{
  const d = deck();
  const samples = new Float32Array([0, 0.5, -0.5]);
  d.scratchChannels = [samples];
  d.buffer.getChannelData = () => { throw new Error('must reuse worker samples'); };
  let sent;
  d.scratchNode = { port: { postMessage: (message, transfer) => { sent = structuredClone(message, { transfer }); } } };
  d.sendScratchBuffer();
  assert.deepEqual(Array.from(sent.channels[0]), [0, 0.5, -0.5]);
  assert.equal(samples.byteLength, 0);
  assert.equal(d.scratchChannels, null, 'transferred scratch data is released by the UI');
}
console.log('all engine regression tests passed');
