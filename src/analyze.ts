// Framing loop: PCM → raw YIN frames → clean PitchTrack.
// Shared by the worker and by the Node tests/benchmark.

import { ANALYSIS, type VoiceRange } from './config.ts';
import { postprocess } from './postprocess.ts';
import type { PitchTrack } from './types.ts';
import { createYin } from './yin.ts';

export type AnalysisParams = { -readonly [K in keyof typeof ANALYSIS]: number };

export function analyzePcm(
  pcm: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
  params: AnalysisParams = ANALYSIS,
  range?: VoiceRange,
): PitchTrack {
  if (range) params = { ...params, minF0: range.minF0, maxF0: range.maxF0 };
  // Remove energy below the voice range (bass, rumble, beats) so it can't mask the voice.
  pcm = highPass(pcm, sampleRate, params.minF0 * HIGHPASS_RATIO);
  if (sampleRate !== params.sampleRate) {
    throw new Error(`Expected ${params.sampleRate} Hz audio, got ${sampleRate} Hz`);
  }
  const { frameSize, hopSize } = params;
  const frames = pcm.length >= frameSize ? Math.floor((pcm.length - frameSize) / hopSize) + 1 : 0;

  const rawF0 = new Float32Array(frames);
  const aperiodicity = new Float32Array(frames);
  const rms = new Float32Array(frames);

  const yin = createYin({
    sampleRate,
    frameSize,
    minF0: params.minF0,
    maxF0: params.maxF0,
    threshold: params.yinThreshold,
  });

  // Pass 1: loudness, so the silence gate is known before running YIN.
  let loudest = -Infinity;
  for (let i = 0; i < frames; i++) {
    const offset = i * hopSize;
    let sumSq = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = pcm[offset + j];
      sumSq += s * s;
    }
    rms[i] = 10 * Math.log10(sumSq / frameSize + 1e-12);
    if (rms[i] > loudest) loudest = rms[i];
  }
  const gate = Math.max(params.gateFloorDb, loudest - params.gateRangeDb);

  // Pass 2: YIN, skipping frames the gate will discard anyway (the expensive part).
  const progressStep = Math.max(1, Math.floor(frames / 20)); // every 5%
  for (let i = 0; i < frames; i++) {
    if (rms[i] < gate) {
      rawF0[i] = NaN;
      aperiodicity[i] = 1;
    } else {
      const est = yin(pcm, i * hopSize);
      rawF0[i] = est.f0;
      aperiodicity[i] = est.aperiodicity;
    }
    if (onProgress && i % progressStep === 0) onProgress(i / frames);
  }

  const clean = postprocess({ f0: rawF0, aperiodicity, rms }, params);
  onProgress?.(1);

  return {
    hopSeconds: hopSize / sampleRate,
    frameCenterOffset: frameSize / 2 / sampleRate,
    duration: pcm.length / sampleRate,
    f0: clean.f0,
    confidence: clean.confidence,
    rms,
    medianF0: clean.medianF0,
  };
}

/** High-pass cutoff as a fraction of the range's min F0. */
export const HIGHPASS_RATIO = 0.8;

/**
 * 4th-order Butterworth high-pass (two cascaded biquads), run forward and
 * backward so it adds no delay. Returns a new array.
 */
export function highPass(x: Float32Array, sampleRate: number, cutoff: number): Float32Array {
  // Q values for a 4th-order Butterworth split into two 2nd-order sections.
  const qs = [0.5411961, 1.3065630];
  const y = Float32Array.from(x);
  for (let pass = 0; pass < 2; pass++) {
    for (const q of qs) biquadHighPassInPlace(y, sampleRate, cutoff, q);
    y.reverse(); // second pass runs backward; two reversals restore the order
  }
  return y;
}

function biquadHighPassInPlace(x: Float32Array, sr: number, fc: number, q: number): void {
  const w = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    x[i] = yi;
  }
}
