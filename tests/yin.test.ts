import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzePcm } from '../src/analyze.ts';
import { ANALYSIS } from '../src/config.ts';
import { createYin } from '../src/yin.ts';
import { glide, harmonicTone, noise, SR, sine, voicedValues } from './helpers.ts';

const yinOpts = {
  sampleRate: SR,
  frameSize: ANALYSIS.frameSize,
  minF0: ANALYSIS.minF0,
  maxF0: ANALYSIS.maxF0,
  threshold: ANALYSIS.yinThreshold,
};

describe('createYin (single frame)', () => {
  for (const freq of [100, 220, 440]) {
    it(`estimates a ${freq} Hz sine within ±1%`, () => {
      const yin = createYin(yinOpts);
      const est = yin(sine(freq, 0.1), 0);
      assert.ok(Math.abs(est.f0 - freq) / freq < 0.01, `got ${est.f0}`);
      assert.ok(est.aperiodicity < 0.1, `aperiodicity ${est.aperiodicity}`);
    });
  }

  it('reports high aperiodicity for silence', () => {
    const yin = createYin(yinOpts);
    const est = yin(new Float32Array(ANALYSIS.frameSize), 0);
    assert.equal(est.aperiodicity, 1);
  });

  it('rejects a frame too short for the lowest pitch', () => {
    assert.throws(() => createYin({ ...yinOpts, frameSize: 200 }));
  });
});

describe('analyzePcm (full pipeline)', () => {
  for (const freq of [100, 220, 440]) {
    it(`tracks a steady ${freq} Hz sine within ±1% on every voiced frame`, () => {
      const track = analyzePcm(sine(freq, 1), SR);
      const voiced = voicedValues(track.f0);
      assert.ok(voiced.length > 0.95 * track.f0.length, 'mostly voiced');
      for (const f of voiced) assert.ok(Math.abs(f - freq) / freq < 0.01, `got ${f}`);
      assert.ok(Math.abs(track.medianF0 - freq) / freq < 0.01);
    });
  }

  it('tracks a 100→300 Hz glide within ±2%', () => {
    const seconds = 2;
    const track = analyzePcm(glide(100, 300, seconds), SR);
    let checked = 0;
    for (let i = 0; i < track.f0.length; i++) {
      const f = track.f0[i];
      if (Number.isNaN(f)) continue;
      const t = track.frameCenterOffset + i * track.hopSeconds;
      const expected = 100 + (200 * t) / seconds;
      assert.ok(Math.abs(f - expected) / expected < 0.02, `frame ${i}: ${f} vs ${expected}`);
      checked++;
    }
    assert.ok(checked > 0.95 * track.f0.length, `only ${checked}/${track.f0.length} voiced`);
  });

  it('finds the fundamental of a harmonic-rich tone', () => {
    const track = analyzePcm(harmonicTone(150, 1), SR);
    assert.ok(Math.abs(track.medianF0 - 150) / 150 < 0.01, `median ${track.medianF0}`);
  });

  it('returns all-unvoiced for silence', () => {
    const track = analyzePcm(new Float32Array(SR), SR);
    assert.equal(voicedValues(track.f0).length, 0);
    assert.ok(Number.isNaN(track.medianF0));
  });

  it('leaves white noise mostly unvoiced', () => {
    const track = analyzePcm(noise(1), SR);
    const voicedFraction = voicedValues(track.f0).length / track.f0.length;
    assert.ok(voicedFraction < 0.05, `voiced fraction ${voicedFraction}`);
  });

  it('gates silence between tones and keeps quiet clips voiced', () => {
    const quiet = 0.01; // about −43 dBFS: would fail a fixed −40 dB gate
    const a = sine(200, 0.5, quiet);
    const gap = new Float32Array(SR / 2);
    const pcm = new Float32Array(a.length * 2 + gap.length);
    pcm.set(a, 0);
    pcm.set(gap, a.length);
    pcm.set(a, a.length + gap.length);
    const track = analyzePcm(pcm, SR);
    const midFrame = Math.round(0.75 / track.hopSeconds);
    assert.ok(Number.isNaN(track.f0[midFrame]), 'gap is unvoiced');
    assert.ok(voicedValues(track.f0).length > 0.6 * track.f0.length * (2 / 3), 'tones are voiced');
  });

  it('reports duration and frame timing', () => {
    const track = analyzePcm(sine(200, 1.5), SR);
    assert.equal(track.duration, 1.5);
    assert.equal(track.hopSeconds, 0.01);
    assert.equal(track.frameCenterOffset, 0.02);
    assert.equal(track.f0.length, Math.floor((1.5 * SR - 640) / 160) + 1);
  });

  it('handles input shorter than one frame', () => {
    const track = analyzePcm(new Float32Array(100), SR);
    assert.equal(track.f0.length, 0);
  });

  it('reports progress ending at 1', () => {
    const seen: number[] = [];
    analyzePcm(sine(200, 1), SR, (p) => seen.push(p));
    assert.ok(seen.length >= 10);
    assert.equal(seen.at(-1), 1);
  });
});
