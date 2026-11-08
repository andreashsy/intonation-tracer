// Pure helpers for practice takes (M2 spec §4): trimming to speech, auto-stop, running median.

import type { Span, TraceLike } from '../phrases.ts';

export const TAKE = {
  padBefore: 0.15,
  padAfter: 0.3,
  /** Stop this long after the last voiced frame, once speech has started. */
  silenceAfterSpeech: 1.0,
  /** Give up if no speech is heard within this long. */
  noSpeechTimeout: 5,
  /** Voiced frames needed before we count it as speech (filters clicks). */
  minVoicedFrames: 8,
  /** Count-in step length. */
  countInStep: 0.45,
} as const;

/** Span from just before the first voiced frame to just after the last; null if none. */
export function speechSpan(t: TraceLike, opts = TAKE): Span | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < t.f0.length; i++) {
    if (Number.isNaN(t.f0[i])) continue;
    if (first < 0) first = i;
    last = i;
  }
  if (first < 0) return null;
  const at = (i: number) => t.frameCenterOffset + i * t.hopSeconds;
  return {
    start: Math.max(0, at(first) - t.hopSeconds / 2 - opts.padBefore),
    end: Math.min(t.duration, at(last) + t.hopSeconds / 2 + opts.padAfter),
  };
}

/** Tracks live frames and decides when recording should stop. */
export class AutoStop {
  private voicedCount = 0;
  private lastVoiced = -1; // seconds
  private readonly limit: number;
  private readonly opts: typeof TAKE;

  /** modelDuration sets the overall time limit: 2 × model + 3 s. */
  constructor(modelDuration: number, opts = TAKE) {
    this.limit = 2 * modelDuration + 3;
    this.opts = opts;
  }

  get heardSpeech(): boolean {
    return this.voicedCount >= this.opts.minVoicedFrames;
  }

  /** Feed one frame (time in seconds since capture started). */
  frame(time: number, voiced: boolean): void {
    if (voiced) {
      this.voicedCount++;
      this.lastVoiced = time;
    }
  }

  /** null = keep going; otherwise why to stop. */
  check(now: number): 'silence' | 'no-speech' | 'limit' | null {
    if (now >= this.limit) return 'limit';
    if (!this.heardSpeech) return now >= this.opts.noSpeechTimeout ? 'no-speech' : null;
    return now - this.lastVoiced >= this.opts.silenceAfterSpeech ? 'silence' : null;
  }
}

/** Median of the voiced values seen so far; cheap enough to call a few times a second. */
export function runningMedian(f0: ArrayLike<number>, count = f0.length): number {
  const v: number[] = [];
  for (let i = 0; i < count; i++) if (!Number.isNaN(f0[i])) v.push(f0[i]);
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
