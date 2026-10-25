// Synthetic click tracks with exactly known grids: one 1 ms 2 kHz Hann burst centred on
// every beat (so its centre is the beat whatever the playback rate), louder on downbeats.
'use strict';
const SR = 44100;

/** The test set. Each row's grid goes into the library as-is, so analysis never runs. */
const TRACKS = [
  { id: 'sh128a', title: 'Click 128.00 @0.123', bpm: 128, beatOffset: 0.123, beatsPerBar: 4 },
  { id: 'sh12737', title: 'Click 127.37 @0.050', bpm: 127.37, beatOffset: 0.05, beatsPerBar: 4 },
  { id: 'sh64', title: 'Click 64.00 @0.210', bpm: 64, beatOffset: 0.21, beatsPerBar: 4 },
  { id: 'sh120w', title: 'Click 120.00 3/4 @0.170', bpm: 120, beatOffset: 0.17, beatsPerBar: 3 },
  { id: 'sh174', title: 'Click 174.00 @0.081', bpm: 174, beatOffset: 0.081, beatsPerBar: 4 },
  { id: 'sh128b', title: 'Click 128.00 @0.311', bpm: 128, beatOffset: 0.311, beatsPerBar: 4 },
];

/** Beat times (s) and whether each is a downbeat (the first beat is beat 1 of a bar). */
function beats(t, seconds) {
  const P = 60 / t.bpm, out = [];
  for (let k = 0; t.beatOffset + k * P < seconds - 0.001; k++) out.push({ t: t.beatOffset + k * P, down: k % t.beatsPerBar === 0 });
  return out;
}

/** 16-bit mono PCM WAV of the track's clicks. */
function clickWav(t, seconds) {
  const n = Math.round(seconds * SR), x = new Float32Array(n), half = 0.0005;
  for (const b of beats(t, seconds)) {
    const amp = b.down ? 0.9 : 0.5;
    for (let i = Math.ceil((b.t - half) * SR); i <= Math.floor((b.t + half) * SR); i++) {
      const u = i / SR - (b.t - half); // 0..1 ms into the burst
      x[i] += amp * (0.5 - 0.5 * Math.cos((2 * Math.PI * u) / (2 * half))) * Math.sin(2 * Math.PI * 2000 * u);
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  return buf;
}

module.exports = { SR, TRACKS, beats, clickWav };
