import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzePcm, highPass } from '../src/analyze.ts';
import { ANALYSIS, RANGE_PRESETS, validateRange } from '../src/config.ts';
import { harmonicTone, SR, sine, voicedValues } from './helpers.ts';

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('voice range', () => {
  it('ignores a pitch below the range', () => {
    const bass = harmonicTone(82, 1);
    const wide = analyzePcm(bass, SR, undefined, ANALYSIS, RANGE_PRESETS.any);
    const high = analyzePcm(bass, SR, undefined, ANALYSIS, RANGE_PRESETS.higher);
    assert.ok(Math.abs(wide.medianF0 - 82) < 2, `wide median ${wide.medianF0}`);
    assert.ok(voicedValues(high.f0).length < 0.05 * high.f0.length, 'bass hidden in higher range');
  });

  it('ignores a pitch above the range', () => {
    const track = analyzePcm(sine(450, 1), SR, undefined, ANALYSIS, RANGE_PRESETS.lower);
    assert.ok(voicedValues(track.f0).every((f) => f <= 300));
  });

  it('follows a voice over loud bass when the range excludes the bass', () => {
    const voice = harmonicTone(250, 1);
    const bass = sine(82, 1, 0.6); // sub-bass, louder than the voice
    const mix = voice.map((v, i) => v + bass[i]);
    assert.ok(rms(bass) > rms(voice));
    // Without the range, the bass wins.
    const wide = analyzePcm(mix, SR, undefined, ANALYSIS, RANGE_PRESETS.any);
    assert.ok(Math.abs(wide.medianF0 - 250) / 250 > 0.1, `wide median ${wide.medianF0}`);
    const track = analyzePcm(mix, SR, undefined, ANALYSIS, RANGE_PRESETS.higher);
    const v = voicedValues(track.f0);
    assert.ok(v.length > 0.8 * track.f0.length, `only ${v.length}/${track.f0.length} voiced`);
    assert.ok(Math.abs(track.medianF0 - 250) / 250 < 0.02, `median ${track.medianF0}`);
  });

  it('never octave-folds a value out of the range', () => {
    // 150 Hz with a short 300 Hz stretch: folding 300→150 is fine; folding 150→75 must not happen.
    const pcm = new Float32Array(SR);
    pcm.set(sine(150, 0.5), 0);
    pcm.set(sine(300, 0.1), SR / 2);
    pcm.set(sine(150, 0.4), SR / 2 + SR / 10);
    const track = analyzePcm(pcm, SR, undefined, ANALYSIS, RANGE_PRESETS.higher);
    assert.ok(voicedValues(track.f0).every((f) => f >= 140 && f <= 500));
  });
});

describe('highPass', () => {
  it('removes low frequencies and keeps higher ones', () => {
    const low = highPass(sine(50, 1), SR, 112);
    const high = highPass(sine(250, 1), SR, 112);
    assert.ok(rms(low) < 0.05 * rms(sine(50, 1)), `50 Hz rms ${rms(low)}`);
    assert.ok(rms(high) > 0.95 * rms(sine(250, 1)), `250 Hz rms ${rms(high)}`);
  });

  it('adds no delay (zero phase)', () => {
    const x = sine(300, 0.5);
    const y = highPass(x, SR, 112);
    const mid = SR / 4;
    for (let i = mid; i < mid + 50; i++) assert.ok(Math.abs(x[i] - y[i]) < 0.02);
  });
});

describe('validateRange', () => {
  it('accepts the presets', () => {
    for (const r of Object.values(RANGE_PRESETS)) assert.equal(validateRange(r), null);
  });
  it('rejects bad ranges', () => {
    assert.match(validateRange({ minF0: 30, maxF0: 300 }) ?? '', /below/);
    assert.match(validateRange({ minF0: 100, maxF0: 1200 }) ?? '', /above/);
    assert.match(validateRange({ minF0: 200, maxF0: 300 }) ?? '', /twice/);
    assert.match(validateRange({ minF0: NaN, maxF0: 300 }) ?? '', /both/);
  });
});
