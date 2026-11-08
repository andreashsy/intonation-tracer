import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DESKTOP_LIMITS, MOBILE_LIMITS, tooLongMessage } from '../src/config.ts';

describe('upload limits', () => {
  it('limits uploads by size, recordings by length', () => {
    assert.equal(DESKTOP_LIMITS.maxBytes, 200 * 1024 * 1024);
    assert.equal(DESKTOP_LIMITS.sizeLabel, '200 MB');
    assert.equal(MOBILE_LIMITS.sizeLabel, '100 MB');
    assert.equal(DESKTOP_LIMITS.maxRecordSeconds, 600);
  });

  it('keeps the safety ceiling well above normal clips and explains it', () => {
    // A 30-minute video under 200 MB is fine on desktop.
    assert.ok(DESKTOP_LIMITS.maxAnalysisSeconds >= 30 * 60);
    // Peak memory at the ceiling stays under ~1 GB (≈15 MB per minute).
    assert.ok((DESKTOP_LIMITS.maxAnalysisSeconds / 60) * 15 <= 1000);
    assert.ok((MOBILE_LIMITS.maxAnalysisSeconds / 60) * 15 <= 320);
    assert.match(tooLongMessage(3 * 3600, DESKTOP_LIMITS), /about 180 minutes.*up to about 60 minutes/);
  });
});
