// Runs one pitch analysis in its own worker (used for Practice takes, so it never
// interferes with the player's analysis worker).

import { ANALYSIS, type VoiceRange } from './config.ts';
import type { PitchTrack, WorkerRequest, WorkerResponse } from './types.ts';

export function analyzeOnce(pcm: Float32Array, range: VoiceRange): Promise<PitchTrack> {
  const worker = new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<PitchTrack>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') return;
      worker.terminate();
      if (msg.type === 'done') resolve(msg.track);
      else reject(new Error(msg.message));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'Pitch analysis failed.'));
    };
    const req: WorkerRequest = { type: 'analyze', id: 1, pcm, sampleRate: ANALYSIS.sampleRate, range };
    worker.postMessage(req);
  });
}
