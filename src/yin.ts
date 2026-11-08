// YIN pitch estimator (de Cheveigné & Kawahara, 2002), steps 2–5.
// Pure and allocation-free per frame, so it can be unit-tested in Node.

export interface YinOptions {
  sampleRate: number;
  frameSize: number;
  minF0: number;
  maxF0: number;
  threshold: number;
}

export interface YinEstimate {
  /** Best-period frequency in Hz (always set; use aperiodicity to decide voicing). */
  f0: number;
  /** Cumulative mean normalized difference at the chosen lag, clamped to 0–1. */
  aperiodicity: number;
}

export type YinFn = (signal: Float32Array, offset: number) => YinEstimate;

export function createYin(opts: YinOptions): YinFn {
  const minLag = Math.max(2, Math.floor(opts.sampleRate / opts.maxF0));
  const maxLag = Math.ceil(opts.sampleRate / opts.minF0);
  // One extra lag (maxLag + 1) is computed for interpolation, so keep reads inside the frame.
  const window = opts.frameSize - maxLag - 1;
  if (window <= 0) throw new Error('frameSize must exceed the longest lag');

  const diff = new Float64Array(maxLag + 2);
  const cmnd = new Float64Array(maxLag + 2);

  return (x, offset) => {
    // Step 2: difference function d(τ) for τ = 1..maxLag+1 (one extra for interpolation).
    const top = maxLag + 1;
    for (let tau = 1; tau <= top; tau++) {
      let sum = 0;
      const o2 = offset + tau;
      for (let j = 0; j < window; j++) {
        const d = x[offset + j] - x[o2 + j];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    // Step 3: cumulative mean normalized difference.
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= top; tau++) {
      running += diff[tau];
      cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
    }

    // Step 4: absolute threshold — first dip below threshold, then walk to its local minimum.
    let best = -1;
    for (let tau = minLag; tau <= maxLag; tau++) {
      if (cmnd[tau] < opts.threshold) {
        while (tau + 1 <= maxLag && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      best = minLag;
      for (let tau = minLag + 1; tau <= maxLag; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    }

    // Step 5: parabolic interpolation around the chosen lag.
    let period = best;
    const s0 = cmnd[best - 1];
    const s1 = cmnd[best];
    const s2 = cmnd[best + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom > 0) {
      const shift = (s0 - s2) / (2 * denom);
      if (Math.abs(shift) < 1) period = best + shift;
    }

    return {
      f0: opts.sampleRate / period,
      aperiodicity: Math.min(1, Math.max(0, s1)),
    };
  };
}
