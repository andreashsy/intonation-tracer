import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RANGE_PRESETS } from '../src/config.ts';
import { type LiveFrame, LivePitch } from '../src/livePitch.ts';
import { permissionMessage } from '../src/recorder.ts';
import { encodeWav, floatToInt16 } from '../src/wav.ts';
import { glide, harmonicTone, sine } from './helpers.ts';

/** Streams a signal through LivePitch in irregular chunk sizes, like a real mic. */
function stream(signal: Float32Array, rate: number, range = RANGE_PRESETS.any): LiveFrame[] {
  const frames: LiveFrame[] = [];
  const live = new LivePitch(rate, range, (f) => frames.push(f));
  const sizes = [128, 2048, 333, 1024, 77, 4096];
  for (let i = 0, k = 0; i < signal.length; k++) {
    const n = sizes[k % sizes.length];
    live.push(signal.subarray(i, i + n));
    i += n;
  }
  return frames;
}

const voiced = (frames: LiveFrame[]) => frames.map((f) => f.f0).filter((f) => !Number.isNaN(f));

describe('LivePitch', () => {
  for (const rate of [48_000, 44_100, 16_000]) {
    it(`tracks 220 Hz from ${rate} Hz input within ±1%`, () => {
      const frames = stream(sine(220, 1, 0.5, rate), rate);
      // ~100 frames per second of audio, minus the first frame's fill.
      assert.ok(Math.abs(frames.length - 97) <= 2, `${frames.length} frames`);
      const v = voiced(frames);
      assert.ok(v.length > 0.95 * frames.length, `${v.length}/${frames.length} voiced`);
      for (const f of v) assert.ok(Math.abs(f - 220) / 220 < 0.01, `got ${f}`);
    });
  }

  it('follows a glide at 48 kHz', () => {
    const frames = stream(glide(120, 300, 2, 0.5, 48_000), 48_000);
    const v = voiced(frames);
    assert.ok(v[5] < 140 && v.at(-5)! > 280, `start ${v[5]}, end ${v.at(-5)}`);
  });

  it('finds the fundamental of a harmonic tone, not a harmonic', () => {
    const frames = stream(harmonicTone(150, 1, 48_000), 48_000);
    const v = voiced(frames).sort((a, b) => a - b);
    assert.ok(Math.abs(v[v.length >> 1] - 150) < 2, `median ${v[v.length >> 1]}`);
  });

  it('reports silence as unvoiced', () => {
    const frames = stream(new Float32Array(48_000), 48_000);
    assert.equal(voiced(frames).length, 0);
    assert.ok(frames.every((f) => f.rmsDb < -100));
  });

  it('respects the voice range', () => {
    const frames = stream(harmonicTone(90, 1, 48_000), 48_000, RANGE_PRESETS.higher);
    assert.ok(voiced(frames).length < 0.05 * frames.length);
  });
});

describe('microphone error messages', () => {
  const msg = (name: string) => permissionMessage(new DOMException('x', name));
  it('explains each failure in plain words', () => {
    assert.match(msg('NotAllowedError'), /blocked/);
    assert.match(msg('SecurityError'), /blocked/);
    assert.match(msg('NotFoundError'), /No microphone/);
    assert.match(msg('NotReadableError'), /in use/);
    assert.match(msg('NotSupportedError'), /can't record/);
    assert.match(permissionMessage(new Error('?')), /Couldn't access/);
  });
});

describe('WAV encoding', () => {
  it('writes a valid mono 16-bit header and data', async () => {
    const a = floatToInt16(Float32Array.from([0, 0.5, -0.5]));
    const b = floatToInt16(Float32Array.from([1, -1, 2]));
    const blob = encodeWav([a, b], 48_000);
    const buf = Buffer.from(await blob.arrayBuffer());
    assert.equal(buf.length, 44 + 12);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buf.readUInt32LE(4), 36 + 12);
    assert.equal(buf.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.equal(buf.readUInt16LE(22), 1); // channels
    assert.equal(buf.readUInt32LE(24), 48_000);
    assert.equal(buf.readUInt16LE(34), 16);
    assert.equal(buf.readUInt32LE(40), 12);
    const samples = Array.from({ length: 6 }, (_, i) => buf.readInt16LE(44 + i * 2));
    assert.deepEqual(samples, [0, 16384, -16384, 32767, -32768, 32767]);
    assert.equal(blob.type, 'audio/wav');
  });
});
