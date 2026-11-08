// Turns raw per-frame YIN output into a clean trace (spec §6.3).

export interface RawFrames {
  f0: Float32Array; // Hz, always set
  aperiodicity: Float32Array; // 0–1
  rms: Float32Array; // dBFS
}

export interface PostprocessOptions {
  voicingThreshold: number;
  gateFloorDb: number;
  gateRangeDb: number;
  octaveWindowFrames: number;
  octaveToleranceSt: number;
  medianFilterFrames: number;
  minRunFrames: number;
}

export interface CleanFrames {
  f0: Float32Array; // NaN when unvoiced
  confidence: Float32Array;
  medianF0: number; // NaN if no voiced frames
}

export function postprocess(raw: RawFrames, opts: PostprocessOptions): CleanFrames {
  const n = raw.f0.length;
  const f0 = new Float32Array(n);
  const confidence = new Float32Array(n);

  // 1. Silence gate (relative to the clip) and the single voicing threshold.
  let loudest = -Infinity;
  for (let i = 0; i < n; i++) if (raw.rms[i] > loudest) loudest = raw.rms[i];
  const gate = Math.max(opts.gateFloorDb, loudest - opts.gateRangeDb);
  for (let i = 0; i < n; i++) {
    confidence[i] = 1 - raw.aperiodicity[i];
    const voiced = raw.rms[i] >= gate && raw.aperiodicity[i] <= opts.voicingThreshold;
    f0[i] = voiced ? raw.f0[i] : NaN;
  }

  // 2. Octave fix against the local median of voiced frames.
  octaveFix(f0, opts.octaveWindowFrames, opts.octaveToleranceSt);

  // 3. Median filter within voiced runs.
  medianFilterRuns(f0, opts.medianFilterFrames);

  // 4. Drop short voiced runs.
  dropShortRuns(f0, opts.minRunFrames);

  return { f0, confidence, medianF0: medianOfVoiced(f0) };
}

export function octaveFix(f0: Float32Array, halfWindow: number, toleranceSt: number): void {
  const n = f0.length;
  const ref = f0.slice(); // compare against unfixed values so fixes don't cascade
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(ref[i])) continue;
    buf.length = 0;
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n - 1, i + halfWindow);
    for (let j = lo; j <= hi; j++) if (!Number.isNaN(ref[j])) buf.push(ref[j]);
    const med = median(buf);
    const st = 12 * Math.log2(ref[i] / med);
    if (Math.abs(st - 12) <= toleranceSt) f0[i] = ref[i] / 2;
    else if (Math.abs(st + 12) <= toleranceSt) f0[i] = ref[i] * 2;
  }
}

export function medianFilterRuns(f0: Float32Array, size: number): void {
  const half = Math.floor(size / 2);
  const src = f0.slice();
  const buf: number[] = [];
  const n = f0.length;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(src[i])) continue;
    buf.length = 0;
    buf.push(src[i]);
    // Extend outward only while still inside the same voiced run.
    for (let k = 1; k <= half && i - k >= 0 && !Number.isNaN(src[i - k]); k++) buf.push(src[i - k]);
    for (let k = 1; k <= half && i + k < n && !Number.isNaN(src[i + k]); k++) buf.push(src[i + k]);
    f0[i] = median(buf);
  }
}

export function dropShortRuns(f0: Float32Array, minRun: number): void {
  const n = f0.length;
  let i = 0;
  while (i < n) {
    if (Number.isNaN(f0[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !Number.isNaN(f0[j])) j++;
    if (j - i < minRun) f0.fill(NaN, i, j);
    i = j;
  }
}

export function medianOfVoiced(f0: Float32Array): number {
  const v: number[] = [];
  for (const x of f0) if (!Number.isNaN(x)) v.push(x);
  return v.length ? median(v) : NaN;
}

/** Median of a non-empty array (sorts in place). */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}
