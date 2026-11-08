// Real-time pitch for the live view while recording.
// Microphone audio arrives in chunks at the device rate (usually 44.1 or 48 kHz); it's
// low-pass filtered and resampled to 16 kHz, then YIN runs on each 10 ms hop.
// This is a preview: after recording stops, the full offline analysis replaces it.

import { ANALYSIS, type VoiceRange } from './config.ts';
import { createYin, type YinFn } from './yin.ts';

/** Fixed silence gate for live input (the clip's loudest level isn't known yet). */
export const LIVE_GATE_DB = -55;

export interface LiveFrame {
  f0: number; // Hz, NaN when unvoiced
  rmsDb: number;
}

export class LivePitch {
  private readonly step: number; // input samples per output sample
  private readonly lp: Biquad[];
  private t = 0; // position of the next output sample, in input samples relative to the chunk start
  private last = 0; // last filtered input sample of the previous chunk
  private buf = new Float32Array(8192);
  private start = 0;
  private fill = 0;
  private readonly yin: YinFn;
  private readonly range: VoiceRange;
  private readonly onFrame: (frame: LiveFrame) => void;

  constructor(inputRate: number, range: VoiceRange, onFrame: (frame: LiveFrame) => void) {
    this.onFrame = onFrame;
    this.step = inputRate / ANALYSIS.sampleRate;
    // Anti-alias before downsampling: two cascaded low-pass sections at 7 kHz.
    this.lp = inputRate > ANALYSIS.sampleRate ? [new Biquad(inputRate, 7000, 0.5412), new Biquad(inputRate, 7000, 1.3066)] : [];
    this.range = range;
    this.yin = createYin({
      sampleRate: ANALYSIS.sampleRate,
      frameSize: ANALYSIS.frameSize,
      minF0: range.minF0,
      maxF0: range.maxF0,
      threshold: ANALYSIS.yinThreshold,
    });
  }

  /** Feed the next chunk of input samples. Emits zero or more frames. */
  push(input: Float32Array): void {
    let x = input;
    if (this.lp.length) {
      x = Float32Array.from(input);
      for (const f of this.lp) f.process(x);
    }
    const n = x.length;
    if (n === 0) return;
    // Linear interpolation; index −1 refers to the previous chunk's last sample.
    while (this.t < n - 1) {
      const i0 = Math.floor(this.t);
      const frac = this.t - i0;
      const a = i0 < 0 ? this.last : x[i0];
      const b = x[i0 + 1];
      this.append(a + (b - a) * frac);
      this.t += this.step;
    }
    this.t -= n;
    this.last = x[n - 1];
  }

  private append(sample: number): void {
    if (this.fill === this.buf.length) {
      // Compact: drop samples already consumed.
      this.buf.copyWithin(0, this.start, this.fill);
      this.fill -= this.start;
      this.start = 0;
    }
    this.buf[this.fill++] = sample;
    if (this.fill - this.start >= ANALYSIS.frameSize) {
      this.analyzeFrame(this.start);
      this.start += ANALYSIS.hopSize;
    }
  }

  private analyzeFrame(offset: number): void {
    let sumSq = 0;
    for (let j = 0; j < ANALYSIS.frameSize; j++) sumSq += this.buf[offset + j] ** 2;
    const rmsDb = 10 * Math.log10(sumSq / ANALYSIS.frameSize + 1e-12);
    let f0 = NaN;
    if (rmsDb >= LIVE_GATE_DB) {
      const est = this.yin(this.buf, offset);
      if (est.aperiodicity <= ANALYSIS.voicingThreshold && est.f0 >= this.range.minF0 && est.f0 <= this.range.maxF0) {
        f0 = est.f0;
      }
    }
    this.onFrame({ f0, rmsDb });
  }
}

/** Streaming 2nd-order low-pass (RBJ cookbook), keeps state between chunks. */
class Biquad {
  private b0: number;
  private b1: number;
  private b2: number;
  private a1: number;
  private a2: number;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(sr: number, fc: number, q: number) {
    const w = (2 * Math.PI * fc) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: Float32Array): void {
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = this.b0 * xi + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = xi;
      this.y2 = this.y1;
      this.y1 = yi;
      x[i] = yi;
    }
  }
}
