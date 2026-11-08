import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANALYSIS } from '../src/config.ts';
import { dropShortRuns, medianFilterRuns, octaveFix, postprocess } from '../src/postprocess.ts';

const N = NaN;
const arr = (xs: number[]) => Float32Array.from(xs);
const same = (a: Float32Array, b: number[]) =>
  assert.deepEqual(Array.from(a).map((x) => (Number.isNaN(x) ? 'NaN' : Math.round(x * 100) / 100)), b.map((x) => (Number.isNaN(x) ? 'NaN' : x)));

describe('octaveFix', () => {
  it('folds a frame an octave above the local median down', () => {
    const f0 = arr([200, 200, 400, 200, 200]);
    octaveFix(f0, 25, 3);
    same(f0, [200, 200, 200, 200, 200]);
  });

  it('folds a frame an octave below up', () => {
    const f0 = arr([200, 200, 100, 200, 200]);
    octaveFix(f0, 25, 3);
    same(f0, [200, 200, 200, 200, 200]);
  });

  it('leaves real movement (a fifth) alone', () => {
    const f0 = arr([200, 200, 300, 200, 200]);
    octaveFix(f0, 25, 3);
    same(f0, [200, 200, 300, 200, 200]);
  });
});

describe('medianFilterRuns', () => {
  it('removes a single-frame spike', () => {
    const f0 = arr([200, 201, 260, 202, 203]);
    medianFilterRuns(f0, 5);
    assert.ok(Math.abs(f0[2] - 201.5) < 1, `got ${f0[2]}`);
  });

  it('does not reach across unvoiced gaps', () => {
    const f0 = arr([100, 100, N, 300, 300]);
    medianFilterRuns(f0, 5);
    same(f0, [100, 100, N, 300, 300]);
  });
});

describe('dropShortRuns', () => {
  it('drops runs shorter than the minimum', () => {
    const f0 = arr([N, 200, 200, N, 210, 210, 210, N]);
    dropShortRuns(f0, 3);
    same(f0, [N, N, N, N, 210, 210, 210, N]);
  });
});

describe('postprocess', () => {
  it('applies the voicing threshold and relative gate', () => {
    const raw = {
      f0: arr([200, 200, 200, 200, 200, 200]),
      aperiodicity: arr([0.05, 0.05, 0.05, 0.9, 0.05, 0.05]),
      rms: arr([-20, -20, -20, -20, -70, -20]),
    };
    const out = postprocess(raw, { ...ANALYSIS, minRunFrames: 1 });
    same(out.f0, [200, 200, 200, N, N, 200]);
    assert.equal(out.medianF0, 200);
    assert.ok(Math.abs(out.confidence[3] - 0.1) < 1e-6);
  });

  it('gates relative to the loudest frame', () => {
    const raw = {
      f0: arr([200, 200, 200, 200]),
      aperiodicity: arr([0.05, 0.05, 0.05, 0.05]),
      rms: arr([-10, -10, -55, -55]), // −55 is > 40 dB below −10
    };
    const out = postprocess(raw, { ...ANALYSIS, minRunFrames: 1 });
    same(out.f0, [200, 200, N, N]);
  });

  it('returns NaN median when nothing is voiced', () => {
    const raw = { f0: arr([200]), aperiodicity: arr([1]), rms: arr([-20]) };
    assert.ok(Number.isNaN(postprocess(raw, ANALYSIS).medianF0));
  });
});
