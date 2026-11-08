// Microphone capture (spec §2.1). An AudioWorklet taps raw samples at the device
// rate; they're kept as 16-bit chunks for the WAV and passed on for the live trace.
// Raw capture (rather than MediaRecorder) gives a file with an exact duration and
// reliable seeking in every browser.

import { floatToInt16 } from './wav.ts';

export class RecorderError extends Error {}

// Inlined so no bundler support for worklet modules is needed. Batches the
// 128-sample render quanta into ~2048-sample messages.
const WORKLET_SOURCE = `
class MicTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
`;

export interface Recording {
  chunks: Int16Array[];
  sampleRate: number;
  length: number; // samples
}

export class MicRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Int16Array[] = [];
  private length = 0;
  /** Live samples (device rate) for the live trace and level meter. */
  onAudio: (samples: Float32Array) => void = () => {};
  /** The microphone went away (unplugged, permission revoked). */
  onEnded: () => void = () => {};
  /**
   * When false, the mic stays open but audio is discarded (Practice opens the mic before
   * playing the model, so the model's sound can't leak into the take).
   */
  capturing = true;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  get seconds(): number {
    return this.ctx ? this.length / this.ctx.sampleRate : 0;
  }

  /** Call from a click handler: Safari only lets audio start inside a user gesture. */
  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      throw new RecorderError('Recording needs a secure (https) page in a browser with microphone support.');
    }
    // Created before awaiting permission so it's still inside the user gesture.
    const ctx = new AudioContext();
    this.ctx = ctx;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // Voice processing distorts pitch; capture the raw signal.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (err) {
      this.teardown();
      throw new RecorderError(permissionMessage(err));
    }

    try {
      await ctx.resume();
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const source = ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (!this.capturing) return;
        const samples = e.data;
        this.chunks.push(floatToInt16(samples));
        this.length += samples.length;
        this.onAudio(samples);
      };
      // Some browsers only run a node that leads to the output; route it through silence.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(ctx.destination);
      this.node = node;
      for (const track of this.stream.getAudioTracks()) track.addEventListener('ended', () => this.onEnded());
    } catch {
      this.teardown();
      throw new RecorderError("Couldn't start recording in this browser.");
    }
  }

  /** Stops and returns everything recorded. */
  stop(): Recording {
    const rec = { chunks: this.chunks, sampleRate: this.sampleRate, length: this.length };
    this.teardown();
    return rec;
  }

  /** Stops and discards the recording. */
  cancel(): void {
    this.teardown();
  }

  private teardown(): void {
    if (this.node) {
      this.node.port.onmessage = null;
      this.node.disconnect();
    }
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.chunks = [];
    this.length = 0;
  }
}

export function permissionMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return "Microphone access is blocked. Allow it in your browser's site settings, then try again.";
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is in use by another app or could not be opened.';
    case 'NotSupportedError':
      return "This browser can't record from the microphone on this page.";
    default:
      return "Couldn't access the microphone.";
  }
}
