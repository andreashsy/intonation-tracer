export const SR = 16_000;

/** Sine at a fixed frequency. */
export function sine(freq: number, seconds: number, amp = 0.5, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Linear frequency glide with continuous phase. */
export function glide(f1: number, f2: number, seconds: number, amp = 0.5, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f1 + ((f2 - f1) * i) / n;
    phase += (2 * Math.PI * f) / sr;
    out[i] = amp * Math.sin(phase);
  }
  return out;
}

/** Deterministic white noise. */
export function noise(seconds: number, amp = 0.3, sr = SR, seed = 1): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = amp * (s / 2 ** 32 - 0.5) * 2;
  }
  return out;
}

/** Harmonic-rich "voice-like" tone: several harmonics with falling amplitude. */
export function harmonicTone(freq: number, seconds: number, sr = SR): Float32Array {
  const n = Math.round(seconds * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * freq * h * i) / sr) / h;
    out[i] = 0.2 * v;
  }
  return out;
}

export function voicedValues(f0: Float32Array): number[] {
  return Array.from(f0).filter((x) => !Number.isNaN(x));
}
