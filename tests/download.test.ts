import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extensionFor, safeFileName } from '../src/download.ts';

describe('download file names', () => {
  it('removes characters that break file names', () => {
    assert.equal(safeFileName('Karina: "laugh" / line?'), 'Karina- -laugh- - line-');
    assert.equal(safeFileName('  ..hidden  '), 'hidden');
    assert.equal(safeFileName('   '), 'phrase');
    assert.equal(safeFileName('a'.repeat(200)).length, 120);
    assert.equal(safeFileName('퇴장 – take 2'), '퇴장 – take 2');
  });

  it('picks an extension from the name, then the type', () => {
    assert.equal(extensionFor('video/mp4', 'clip.MOV'), 'mov');
    assert.equal(extensionFor('video/webm'), 'webm');
    assert.equal(extensionFor('application/x-unknown'), 'bin');
  });
});
