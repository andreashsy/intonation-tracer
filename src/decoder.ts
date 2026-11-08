// File → mono Float32 PCM at the analysis rate (spec §5).

export class DecodeError extends Error {}

/**
 * Decodes with an AudioContext running at the target rate, so the browser
 * resamples during decode and no full-rate copy is kept. Falls back to a
 * default-rate decode plus OfflineAudioContext resampling.
 */
export async function decodeToMono(file: File, targetRate: number): Promise<Float32Array> {
  try {
    const direct = await decodeWith(file, targetRate);
    if (direct.sampleRate === targetRate) return downmix(direct);
  } catch {
    // Fall through to the fallback path (some browsers reject the rate, or decode fails here only).
  }

  let decoded: AudioBuffer;
  try {
    decoded = await decodeWith(file); // re-read: decodeAudioData detached the first buffer
  } catch {
    throw new DecodeError("This file's format isn't supported. Try MP3, WAV, M4A or MP4.");
  }
  return resample(decoded, targetRate);
}

async function decodeWith(file: File, sampleRate?: number): Promise<AudioBuffer> {
  const ctx = sampleRate ? new AudioContext({ sampleRate }) : new AudioContext();
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } finally {
    void ctx.close();
  }
}

function downmix(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(buf.length);
  const n = buf.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

async function resample(buf: AudioBuffer, targetRate: number): Promise<Float32Array> {
  const length = Math.max(1, Math.ceil(buf.duration * targetRate));
  // A 1-channel destination downmixes the source automatically.
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
