// 16-bit PCM mono WAV encoding for recordings.

/** Float samples (−1…1) → 16-bit integers, clipped. */
export function floatToInt16(x: Float32Array): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Builds a mono 16-bit WAV from chunks of samples. */
export function encodeWav(chunks: Int16Array[], sampleRate: number): Blob {
  let length = 0;
  for (const c of chunks) length += c.length;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  const dataBytes = length * 2;
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  // Int16Array is little-endian on every platform browsers run on.
  // Recorder chunks are always plain ArrayBuffers (never shared), so the cast is safe.
  return new Blob([header, ...chunks.map((c) => new Uint8Array(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength))], {
    type: 'audio/wav',
  });
}
