// Pure phrase helpers (M1 spec §4–§8): detection, clamping, slicing, alignment, sparklines.

export const PHRASE = {
  /** Voiced runs closer than this are one phrase. */
  maxGapSeconds: 0.35,
  padSeconds: 0.15,
  minSeconds: 0.3,
  maxSeconds: 30,
} as const;

export interface Span {
  start: number;
  end: number;
}

export interface TraceLike {
  f0: Float32Array;
  hopSeconds: number;
  frameCenterOffset: number;
  duration: number;
}

const frameTime = (t: TraceLike, i: number) => t.frameCenterOffset + i * t.hopSeconds;

/** Groups voiced runs separated by short gaps into padded phrases. */
export function detectPhrases(t: TraceLike, opts = PHRASE): Span[] {
  const out: Span[] = [];
  let groupStart = -1;
  let lastVoiced = -1;
  const flush = () => {
    if (groupStart < 0) return;
    const voicedStart = frameTime(t, groupStart) - t.hopSeconds / 2;
    const voicedEnd = frameTime(t, lastVoiced) + t.hopSeconds / 2;
    if (voicedEnd - voicedStart >= opts.minSeconds - 1e-9) {
      out.push({
        start: Math.max(0, voicedStart - opts.padSeconds),
        end: Math.min(t.duration, voicedEnd + opts.padSeconds),
      });
    }
    groupStart = -1;
  };
  for (let i = 0; i < t.f0.length; i++) {
    if (Number.isNaN(t.f0[i])) continue;
    if (groupStart >= 0 && (i - lastVoiced) * t.hopSeconds > opts.maxGapSeconds) flush();
    if (groupStart < 0) groupStart = i;
    lastVoiced = i;
  }
  flush();
  // Padding can make neighbours overlap slightly; split the overlap evenly.
  for (let k = 1; k < out.length; k++) {
    if (out[k].start < out[k - 1].end) {
      const mid = (out[k].start + out[k - 1].end) / 2;
      out[k - 1].end = mid;
      out[k].start = mid;
    }
  }
  return out;
}

export function phraseAt(spans: Span[], time: number): Span | null {
  return spans.find((s) => time >= s.start && time <= s.end) ?? null;
}

/** Orders, clamps to the clip and to the max length. Returns null if too short. */
export function normalizeSpan(a: number, b: number, duration: number, opts = PHRASE): Span | null {
  let start = Math.max(0, Math.min(a, b));
  let end = Math.min(duration, Math.max(a, b));
  if (end - start > opts.maxSeconds) {
    // Keep the edge the user started from (a), trim the other.
    if (a <= b) end = start + opts.maxSeconds;
    else start = end - opts.maxSeconds;
  }
  return end - start >= opts.minSeconds ? { start, end } : null;
}

/** Cuts samples [start, end) seconds. */
export function slicePcm(pcm: Float32Array, sampleRate: number, span: Span): Float32Array {
  const a = Math.max(0, Math.round(span.start * sampleRate));
  const b = Math.min(pcm.length, Math.round(span.end * sampleRate));
  return pcm.slice(a, b);
}

/** The frames whose centres fall inside the span, re-timed relative to its start. */
export function sliceTrace(t: TraceLike, span: Span): { f0: Float32Array; frameCenterOffset: number; medianF0: number } {
  const i0 = Math.max(0, Math.ceil((span.start - t.frameCenterOffset) / t.hopSeconds - 1e-9));
  const i1 = Math.min(t.f0.length - 1, Math.floor((span.end - t.frameCenterOffset) / t.hopSeconds + 1e-9));
  const f0 = i1 >= i0 ? t.f0.slice(i0, i1 + 1) : new Float32Array(0);
  return { f0, frameCenterOffset: frameTime(t, i0) - span.start, medianF0: medianVoiced(f0) };
}

export function medianVoiced(f0: Float32Array): number {
  const v = Array.from(f0).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Time of the first voiced frame, or 0 if none (used for Align: Start). */
export function firstVoicedTime(t: Pick<TraceLike, 'f0' | 'hopSeconds' | 'frameCenterOffset'>): number {
  for (let i = 0; i < t.f0.length; i++) if (!Number.isNaN(t.f0[i])) return frameTime(t as TraceLike, i);
  return 0;
}

/** Semitones relative to the median; NaN stays NaN. */
export function toSemitones(f0: Float32Array, median: number): Float32Array {
  const out = new Float32Array(f0.length);
  for (let i = 0; i < f0.length; i++) out[i] = Number.isNaN(f0[i]) ? NaN : 12 * Math.log2(f0[i] / median);
  return out;
}

/** SVG path for a small trace preview, breaking at unvoiced frames. */
export function sparklinePath(f0: Float32Array, median: number, width: number, height: number, rangeSt = 9): string {
  if (!f0.length || Number.isNaN(median)) return '';
  const st = toSemitones(f0, median);
  const parts: string[] = [];
  let pen = false;
  const dx = width / Math.max(1, f0.length - 1);
  for (let i = 0; i < st.length; i++) {
    if (Number.isNaN(st[i])) {
      pen = false;
      continue;
    }
    const y = Math.min(height, Math.max(0, height / 2 - (st[i] / rangeSt) * (height / 2)));
    parts.push(`${pen ? 'L' : 'M'}${(i * dx).toFixed(1)} ${y.toFixed(1)}`);
    pen = true;
  }
  return parts.join(' ');
}

/** Bytes as "86 KB" / "4.8 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
