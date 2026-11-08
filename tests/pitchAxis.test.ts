import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatHz,
  formatSt,
  guidePosition,
  hzDomain,
  hzTicks,
  hzToSt,
  noteName,
  noteTicks,
  stToHz,
} from '../src/pitchAxis.ts';

const close = (a: number, b: number, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

describe('semitones and Hz', () => {
  it('converts both ways', () => {
    close(hzToSt(400, 200), 12);
    close(hzToSt(100, 200), -12);
    close(stToHz(6, 200), 282.84);
    close(hzToSt(stToHz(3.7, 151), 151), 3.7);
  });

  it('shows equal steps in st are unequal steps in Hz', () => {
    assert.equal(Math.round(stToHz(6, 200) - 200), 83);
    assert.equal(Math.round(200 - stToHz(-6, 200)), 59);
  });
});

describe('notes', () => {
  it('names notes', () => {
    assert.equal(noteName(440), 'A4');
    assert.equal(noteName(261.63), 'C4');
    assert.equal(noteName(110), 'A2');
    assert.equal(noteName(196), 'G3');
    assert.equal(noteName(277.18), 'C♯4');
  });

  it('gives C and G gridlines, only C when crowded', () => {
    assert.deepEqual(
      noteTicks(95, 300).map((t) => t.label), // G2 = 98 Hz … C4 = 262 Hz
      ['G2', 'C3', 'G3', 'C4'],
    );
    assert.ok(noteTicks(40, 1200, 6).every((t) => t.label.startsWith('C')));
  });
});

describe('ticks and domain', () => {
  it('picks round Hz ticks inside the range', () => {
    assert.deepEqual(hzTicks(90, 420), [100, 125, 150, 200, 250, 300, 400]);
    assert.ok(hzTicks(40, 1200, 6).length <= 6);
  });

  it('pads the domain and keeps at least an octave', () => {
    const [a, b] = hzDomain([200, 200, 200]);
    close(hzToSt(b, a), 12);
    const [c, d] = hzDomain(Array.from({ length: 100 }, (_, i) => 100 + i * 3)); // 100–397 Hz
    assert.ok(c < 100 && d > 397);
    assert.deepEqual(hzDomain([]), [75, 400]);
  });
});

describe('labels and guides', () => {
  it('formats values', () => {
    assert.equal(formatHz(282.8), '283 Hz');
    assert.equal(formatSt(2.74), '+2.7 st');
    assert.equal(formatSt(-6), '−6 st');
    assert.equal(formatSt(0.01), '0 st');
  });

  it('places and clamps range limits on a semitone axis', () => {
    const inside = guidePosition(140, 200, 12);
    close(inside.st, -6.17);
    assert.equal(inside.clamped, 0);
    assert.deepEqual(guidePosition(800, 200, 12), { st: 12, clamped: 1 });
    assert.deepEqual(guidePosition(40, 200, 12), { st: -12, clamped: -1 });
  });
});
