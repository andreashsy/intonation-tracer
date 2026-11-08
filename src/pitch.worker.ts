import { analyzePcm } from './analyze.ts';
import type { WorkerRequest, WorkerResponse } from './types.ts';

// Typed view of the dedicated worker scope without pulling in the WebWorker lib
// (which conflicts with the DOM lib used by the rest of the app).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== 'analyze') return;
  const { id } = msg;
  try {
    const track = analyzePcm(msg.pcm, msg.sampleRate, (value) => {
      ctx.postMessage({ type: 'progress', id, value });
    });
    ctx.postMessage({ type: 'done', id, track }, [
      track.f0.buffer,
      track.confidence.buffer,
      track.rms.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
