// All tunable numbers in one place. Values follow the M0 spec (§5, §6, §7).

export const ANALYSIS = {
  sampleRate: 16_000,
  frameSize: 640, // 40 ms
  hopSize: 160, // 10 ms
  minF0: 50,
  maxF0: 800,
  /** YIN absolute threshold: picks the lag (first dip below this). */
  yinThreshold: 0.15,
  /** The single voicing decision: voiced if aperiodicity at the chosen lag ≤ this. */
  voicingThreshold: 0.3,
  /** Silence gate: unvoiced if RMS < max(gateFloorDb, loudest frame − gateRangeDb). */
  gateFloorDb: -60,
  gateRangeDb: 40,
  /** Octave fix: compare against the median of voiced frames within ±this many frames (250 ms). */
  octaveWindowFrames: 25,
  /** Fold if within this many semitones of an octave above/below the local median. */
  octaveToleranceSt: 3,
  medianFilterFrames: 5,
  /** Drop voiced runs shorter than this (30 ms). */
  minRunFrames: 3,
} as const;

export const VIEW = {
  windowSeconds: 8,
  /** Auto-scroll when the playhead passes this fraction of the window… */
  scrollTrigger: 0.75,
  /** …and put it back at this fraction. */
  scrollTarget: 0.25,
  minSemitoneRange: 12,
  semitoneStep: 6,
  clickSlopPx: 4,
} as const;

/**
 * Added to analysis time when mapping trace frames to playback time.
 * Measure per browser/format with the click-track fixture (spec §7.3, §12).
 */
export const TRACE_OFFSET_SECONDS = 0;

export interface Limits {
  maxBytes: number;
  maxSeconds: number;
  label: string;
}

export const DESKTOP_LIMITS: Limits = { maxBytes: 200 * 1024 * 1024, maxSeconds: 10 * 60, label: '10 minutes' };
export const MOBILE_LIMITS: Limits = { maxBytes: 100 * 1024 * 1024, maxSeconds: 5 * 60, label: '5 minutes' };

export function currentLimits(): Limits {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarse && touch ? MOBILE_LIMITS : DESKTOP_LIMITS;
}
