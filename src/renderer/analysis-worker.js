// Track analysis off the main thread (module Worker), so loading a track never stalls the decks.
// Message: { id, op, mono or channels (transferred), sampleRate, bpm, options }
// Reply:   { id, result } or { id, error }
import { analyzeTrack, fitGridAt, detectKey, onsetEnvelope, mixToMono, computeWaveform } from './analysis.js';

self.onmessage = ({ data: { id, op, mono, channels, sampleRate, bpm, options } }) => {
  try {
    if (op === 'prepare') {
      const samples = mixToMono(channels);
      const analysis = options.analyze ? analyzeTrack(samples, sampleRate) : { key: options.key ? detectKey(samples, sampleRate) : null };
      const result = { ...analysis, wave: computeWaveform(samples, sampleRate, 300), onsets: onsetEnvelope(samples, sampleRate), channels };
      // Reuse these copies for scratching instead of copying a whole song again on the UI thread.
      self.postMessage({ id, result }, channels.map((ch) => ch.buffer));
    }
    else if (op === 'analyze') self.postMessage({ id, result: analyzeTrack(mono, sampleRate) });
    else if (op === 'key') self.postMessage({ id, result: detectKey(mono, sampleRate) });
    else if (op === 'onsets') self.postMessage({ id, result: onsetEnvelope(mono, sampleRate) });
    else if (op === 'fitAt') self.postMessage({ id, result: fitGridAt(mono, sampleRate, bpm) });
    else throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
