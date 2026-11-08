export interface PitchTrack {
  hopSeconds: number; // 0.01
  /** Time of frame 0's center; frame i is at frameCenterOffset + i * hopSeconds. */
  frameCenterOffset: number;
  duration: number; // seconds
  f0: Float32Array; // Hz per frame; NaN when unvoiced
  confidence: Float32Array; // 0–1 per frame (1 − YIN aperiodicity)
  rms: Float32Array; // loudness per frame, dBFS
  medianF0: number; // over voiced frames; NaN if none
}

export type WorkerRequest = {
  type: 'analyze';
  id: number;
  pcm: Float32Array;
  sampleRate: number;
};

export type WorkerResponse =
  | { type: 'progress'; id: number; value: number }
  | { type: 'done'; id: number; track: PitchTrack }
  | { type: 'error'; id: number; message: string };
