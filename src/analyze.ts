// Framing loop: PCM → raw YIN frames → clean PitchTrack.
// Shared by the worker and by the Node tests/benchmark.

import { ANALYSIS } from './config.ts';
import { postprocess } from './postprocess.ts';
import type { PitchTrack } from './types.ts';
import { createYin } from './yin.ts';

export type AnalysisParams = typeof ANALYSIS;

export function analyzePcm(
  pcm: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
  params: AnalysisParams = ANALYSIS,
): PitchTrack {
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
