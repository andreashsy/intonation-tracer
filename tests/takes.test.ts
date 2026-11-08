import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AutoStop, runningMedian, speechSpan, TAKE } from '../src/practice/takes.ts';

function trace(duration: number, voiced: [number, number][]) {
  const hop = 0.01;
  const fco = 0.02;
  const n = Math.floor((duration - 0.04) / hop) + 1;
  const f0 = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const t = fco + i * hop;
    if (voiced.some(([a, b]) => t >= a && t < b)) f0[i] = 180;
  }
  return { f0, hopSeconds: hop, frameCenterOffset: fco, duration };
}

const close = (a: number, b: number, tol = 0.011) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe('speechSpan', () => {
  it('trims leading and trailing silence with padding', () => {
    const s = speechSpan(trace(4, [[1.0, 1.5], [1.8, 2.2]]))!;
    close(s.start, 1.0 - TAKE.padBefore);
    close(s.end, 2.2 + TAKE.padAfter);
  });

  it('clamps to the recording', () => {
    const s = speechSpan(trace(1, [[0.03, 0.9]]))!;
    assert.equal(s.start, 0);
    assert.ok(s.end <= 1);
  });

  it('returns null with no speech', () => {
    assert.equal(speechSpan(trace(2, [])), null);
  });
});

describe('AutoStop', () => {
  const feed = (a: AutoStop, from: number, to: number, voiced: boolean) => {
    for (let t = from; t < to; t += 0.01) a.frame(t, voiced);
  };

  it('stops one second after speech ends', () => {
    const a = new AutoStop(2);
    feed(a, 0, 0.5, false);
    feed(a, 0.5, 1.5, true);
    feed(a, 1.5, 2.4, false);
    assert.equal(a.check(2.4), null);
    feed(a, 2.4, 2.51, false);
    assert.equal(a.check(2.51), 'silence');
  });

  it('ignores a short click before speech', () => {
    const a = new AutoStop(2);
    feed(a, 0.2, 0.24, true); // 4 frames < minVoicedFrames
    assert.equal(a.heardSpeech, false);
    assert.equal(a.check(1.5), null);
  });

  it('gives up when nothing is heard', () => {
    const a = new AutoStop(2);
    assert.equal(a.check(4.9), null);
    assert.equal(a.check(5), 'no-speech');
  });

  it('stops at the time limit even mid-speech', () => {
    const a = new AutoStop(1); // limit 5 s
    feed(a, 0, 5, true);
    assert.equal(a.check(5), 'limit');
  });
});

describe('runningMedian', () => {
  it('uses voiced values only, up to count', () => {
    assert.equal(runningMedian([NaN, 100, 300, 200, NaN, 900], 5), 200);
    assert.equal(runningMedian([100, 200]), 150);
    assert.ok(Number.isNaN(runningMedian([NaN])));
  });
});
