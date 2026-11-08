// Pure helpers linking semitones and Hz on the charts (pitch-axis spec §3–§6).

export type AxisUnit = 'st' | 'hz' | 'notes';

/** Semitones of `hz` relative to `ref` Hz. */
export function hzToSt(hz: number, ref: number): number {
  return 12 * Math.log2(hz / ref);
}

export function stToHz(st: number, ref: number): number {
  return ref * 2 ** (st / 12);
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** MIDI note number (A4 = 69 = 440 Hz), fractional. */
export function hzToMidi(hz: number): number {
  return 69 + hzToSt(hz, 440);
}

export function midiToHz(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

/** Nearest note name, e.g. 261.6 → "C4". */
export function noteName(hz: number): string {
  const m = Math.round(hzToMidi(hz));
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

const NICE_HZ = [40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200];

/** Round Hz gridlines within [lo, hi], thinned to at most `max`. */
export function hzTicks(lo: number, hi: number, max = 8): number[] {
  let ticks = NICE_HZ.filter((h) => h >= lo && h <= hi);
  while (ticks.length > max) ticks = ticks.filter((_, i) => i % 2 === 0);
  return ticks;
}

/** Note gridlines (C and G of each octave) within [lo, hi]; only Cs if that's too many. */
export function noteTicks(lo: number, hi: number, max = 8): { hz: number; label: string }[] {
  const out: { hz: number; label: string }[] = [];
  for (let m = Math.ceil(hzToMidi(lo)); m <= Math.floor(hzToMidi(hi)); m++) {
    const pc = ((m % 12) + 12) % 12;
    if (pc === 0 || pc === 7) out.push({ hz: midiToHz(m), label: noteName(midiToHz(m)) });
  }
  return out.length > max ? out.filter((t) => t.label.startsWith('C')) : out;
}

export function formatHz(hz: number): string {
  return `${Math.round(hz)} Hz`;
}

/** "+2.7 st", "−6 st", "0 st"; whole numbers drop the decimal. */
export function formatSt(st: number, digits = 1): string {
  const r = Math.round(st * 10 ** digits) / 10 ** digits;
  if (r === 0) return '0 st';
  const abs = Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(digits);
  return `${r > 0 ? '+' : '−'}${abs} st`;
}

/** Log-Hz domain covering the 1st–99th percentile of voiced values, padded by `padSt` semitones. */
export function hzDomain(values: number[], padSt = 2, fallback: [number, number] = [75, 400]): [number, number] {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return fallback;
  const lo = v[Math.floor(v.length * 0.01)];
  const hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.99))];
  let a = stToHz(-padSt, lo);
  let b = stToHz(padSt, hi);
  // Keep at least an octave visible so a flat line doesn't fill the chart.
  if (hzToSt(b, a) < 12) {
    const mid = Math.sqrt(a * b);
    a = stToHz(-6, mid);
    b = stToHz(6, mid);
  }
  return [a, b];
}

/** Where a range limit lands on a semitone axis of ±extent, and whether it's off the edge. */
export function guidePosition(limitHz: number, typicalHz: number, extent: number): { st: number; clamped: -1 | 0 | 1 } {
  const st = hzToSt(limitHz, typicalHz);
  if (st > extent) return { st: extent, clamped: 1 };
  if (st < -extent) return { st: -extent, clamped: -1 };
  return { st, clamped: 0 };
}
