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

// ---- Voice range (which pitches count as the voice we follow) ----

export interface VoiceRange {
  minF0: number;
  maxF0: number;
}

export type RangePresetId = 'any' | 'lower' | 'higher' | 'custom';

export const RANGE_PRESETS: Record<Exclude<RangePresetId, 'custom'>, VoiceRange & { label: string }> = {
  any: { label: 'Any voice', minF0: ANALYSIS.minF0, maxF0: ANALYSIS.maxF0 },
  lower: { label: 'Lower voice', minF0: 60, maxF0: 300 },
  higher: { label: 'Higher voice', minF0: 140, maxF0: 500 },
};

export const RANGE_LIMITS = {
  /** Lowest allowed min. Its period (400 samples) must fit in the 640-sample frame. */
  floor: 40,
  ceiling: 1000,
  /** Max must be at least this × min (one octave), so octave correction has room. */
  minRatio: 2,
} as const;

/** Returns an error message, or null if the range is usable. */
export function validateRange(r: VoiceRange): string | null {
  if (!Number.isFinite(r.minF0) || !Number.isFinite(r.maxF0)) return 'Enter both numbers.';
  if (r.minF0 < RANGE_LIMITS.floor) return `Min can't be below ${RANGE_LIMITS.floor} Hz.`;
  if (r.maxF0 > RANGE_LIMITS.ceiling) return `Max can't be above ${RANGE_LIMITS.ceiling} Hz.`;
  if (r.maxF0 < r.minF0 * RANGE_LIMITS.minRatio) return 'Max must be at least twice Min.';
  return null;
}

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
  /** Uploads are limited by file size (M0 spec §5). */
  maxBytes: number;
  sizeLabel: string;
  /** Microphone recordings are limited by length. */
  maxRecordSeconds: number;
  recordLabel: string;
  /**
   * Safety ceiling, not a product limit: analysis keeps the audio decoded at 16 kHz in memory,
   * peaking around 15 MB per minute (decoded buffer + mono copy + worker copy). A small file can
   * still be hours long (a 200 MB MP3 is ~3 h), which would crash the tab, so longer files are
   * refused with an explanation. ~60 min ≈ 0.9 GB on desktop, ~20 min ≈ 0.3 GB on phones.
   */
  maxAnalysisSeconds: number;
}

const MB = 1024 * 1024;

export const DESKTOP_LIMITS: Limits = {
  maxBytes: 200 * MB,
  sizeLabel: '200 MB',
  maxRecordSeconds: 10 * 60,
  recordLabel: '10 minutes',
  maxAnalysisSeconds: 60 * 60,
};
export const MOBILE_LIMITS: Limits = {
  maxBytes: 100 * MB,
  sizeLabel: '100 MB',
  maxRecordSeconds: 5 * 60,
  recordLabel: '5 minutes',
  maxAnalysisSeconds: 20 * 60,
};

/** Message for a file too long to analyze on this device. */
export function tooLongMessage(seconds: number, limits: Limits): string {
  const mins = Math.round(seconds / 60);
  const max = Math.round(limits.maxAnalysisSeconds / 60);
  return `This file is about ${mins} minutes long, too long to analyze on this device (up to about ${max} minutes). Try a shorter clip, or trim it first.`;
}

export function currentLimits(): Limits {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarse && touch ? MOBILE_LIMITS : DESKTOP_LIMITS;
}
