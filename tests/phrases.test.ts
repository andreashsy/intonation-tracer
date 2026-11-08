import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectPhrases,
  firstVoicedTime,
  formatBytes,
  normalizeSpan,
  phraseAt,
  slicePcm,
  sliceTrace,
  sparklinePath,
  type TraceLike,
} from '../src/phrases.ts';

/** Builds a trace (10 ms frames, centre offset 0.02 s) voiced over the given second ranges. */
function trace(duration: number, voiced: [number, number][], hz = 200): TraceLike {
  const hop = 0.01;
  const fco = 0.02;
  const n = Math.floor((duration - 0.04) / hop) + 1;
  const f0 = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const t = fco + i * hop;
    if (voiced.some(([a, b]) => t >= a && t < b)) f0[i] = hz;
  }
  return { f0, hopSeconds: hop, frameCenterOffset: fco, duration };
}

const close = (a: number, b: number, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe('detectPhrases', () => {
  it('joins runs with short gaps and splits at long pauses', () => {
    // Two words 0.2 s apart (one phrase), then a 0.8 s pause, then another phrase.
    const p = detectPhrases(trace(5, [[0.5, 1.0], [1.2, 1.8], [2.6, 3.4]]));
    assert.equal(p.length, 2);
    close(p[0].start, 0.35);
    close(p[0].end, 1.95);
    close(p[1].start, 2.45);
    close(p[1].end, 3.55);
  });

  it('drops tiny blips and clamps padding to the clip', () => {
    const p = detectPhrases(trace(2, [[0.03, 0.6], [1.0, 1.1]]));
    assert.equal(p.length, 1);
    assert.equal(p[0].start, 0);
  });

  it('never lets padded neighbours overlap', () => {
    const p = detectPhrases(trace(3, [[0.5, 1.0], [1.37, 2.0]])); // gap just over 0.35 s
    assert.equal(p.length, 2);
    assert.ok(p[0].end <= p[1].start, `${p[0].end} > ${p[1].start}`);
  });

  it('finds nothing in silence', () => {
    assert.equal(detectPhrases(trace(2, [])).length, 0);
  });
});

describe('phraseAt / normalizeSpan', () => {
  it('picks the phrase under a time', () => {
    const spans = [{ start: 1, end: 2 }, { start: 3, end: 4 }];
    assert.deepEqual(phraseAt(spans, 3.5), { start: 3, end: 4 });
    assert.equal(phraseAt(spans, 2.5), null);
  });

  it('orders, clamps and limits spans', () => {
    assert.deepEqual(normalizeSpan(3, 1, 10), { start: 1, end: 3 });
    assert.deepEqual(normalizeSpan(-1, 0.5, 10), { start: 0, end: 0.5 });
    assert.deepEqual(normalizeSpan(5, 50, 60), { start: 5, end: 35 }); // dragged right: keep start
    assert.deepEqual(normalizeSpan(50, 5, 60), { start: 20, end: 50 }); // dragged left: keep end
    assert.equal(normalizeSpan(1, 1.1, 10), null);
  });
});

describe('slicing', () => {
  it('cuts audio samples by time', () => {
    const pcm = Float32Array.from({ length: 16_000 }, (_, i) => i);
    const s = slicePcm(pcm, 16_000, { start: 0.25, end: 0.5 });
    assert.equal(s.length, 4000);
    assert.equal(s[0], 4000);
  });

  it('keeps frame timing when slicing a trace', () => {
    const t = trace(4, [[1.0, 2.0]]);
    const s = sliceTrace(t, { start: 0.905, end: 2.1 });
    // First frame centre at or after 0.905 is 0.91 → offset 0.005 within the phrase.
    close(s.frameCenterOffset, 0.005, 1e-6);
    assert.equal(s.f0.length, 120); // centres 0.91 … 2.10
    assert.equal(s.medianF0, 200);
    close(firstVoicedTime({ ...s, hopSeconds: 0.01 }), 0.095, 0.006);
  });

  it('handles an empty slice', () => {
    const s = sliceTrace(trace(1, []), { start: 0.5, end: 0.5 });
    assert.ok(Number.isNaN(s.medianF0));
  });
});

describe('display helpers', () => {
  it('draws a sparkline that breaks at gaps', () => {
    const f0 = Float32Array.from([200, 200, NaN, 400, 100]);
    const d = sparklinePath(f0, 200, 40, 20);
    assert.equal((d.match(/M/g) ?? []).length, 2);
    assert.match(d, /^M0\.0 10\.0 L10\.0 10\.0 M30\.0 0\.0 L40\.0 20\.0$/);
  });

  it('formats sizes', () => {
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(88_000), '86 KB');
    assert.equal(formatBytes(4_791_718), '4.6 MB');
  });
});
