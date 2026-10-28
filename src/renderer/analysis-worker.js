// Track analysis off the main thread (module Worker), so loading a track never stalls the decks.
// Message: { id, op: 'analyze' | 'fitAt' | 'key' | 'onsets', mono: Float32Array (transfer it), sampleRate, bpm }
// Reply:   { id, result } or { id, error }
import { analyzeTrack, fitGridAt, detectKey, onsetEnvelope } from './analysis.js';

self.onmessage = ({ data: { id, op, mono, sampleRate, bpm } }) => {
  try {
    if (op === 'analyze') self.postMessage({ id, result: analyzeTrack(mono, sampleRate) });
    else if (op === 'key') self.postMessage({ id, result: detectKey(mono, sampleRate) });
    else if (op === 'onsets') self.postMessage({ id, result: onsetEnvelope(mono, sampleRate) });
    else if (op === 'fitAt') self.postMessage({ id, result: fitGridAt(mono, sampleRate, bpm) });
    else throw new Error(`unknown op ${op}`);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
