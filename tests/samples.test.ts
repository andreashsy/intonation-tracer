import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSampleId, languageLabel, parseManifest, isLanguageCode, rangeFor, sampleId } from '../src/library/samples.ts';

describe('sample manifest', () => {
  it('keeps well-formed entries and skips the rest', () => {
    const list = parseManifest({
      samples: [
        { file: 'ko/question.mp3', name: 'Question', language: 'ko' },
        { file: 'ko/question.mp3', name: 'Duplicate', language: 'ko' },
        { file: '../secret.mp3', name: 'Escape', language: 'ko' },
        { file: 'ko/x.mp3', name: '  ', language: 'ko' },
        { name: 'No file', language: 'ko' },
        null,
      ],
    });
    assert.deepEqual(list.map((e) => e.name), ['Question']);
  });

  it('accepts an optional text credit', () => {
    const list = parseManifest({
      samples: [
        { file: 'ko/a.wav', name: 'A', language: 'ko', credit: 'Read by LeeSeJin' },
        { file: 'ko/b.wav', name: 'B', language: 'ko', credit: 42 },
      ],
    });
    assert.deepEqual(list.map((e) => e.credit), ['Read by LeeSeJin']);
  });

  it('accepts an optional transcript and translation', () => {
    const list = parseManifest({
      samples: [
        { file: 'ko/a.wav', name: 'A', language: 'ko', transcript: '세계 인권 선언', translation: 'Universal Declaration of Human Rights' },
        { file: 'ko/b.wav', name: 'B', language: 'ko', transcript: ['not', 'text'] },
        { file: 'ko/c.wav', name: 'C', language: 'ko' },
      ],
    });
    assert.deepEqual(list.map((e) => [e.file, e.transcript, e.translation]), [
      ['ko/a.wav', '세계 인권 선언', 'Universal Declaration of Human Rights'],
      ['ko/c.wav', undefined, undefined],
    ]);
  });

  it('knows a language code from a language name', () => {
    assert.equal(isLanguageCode('ko'), true);
    assert.equal(isLanguageCode('pt-BR'), true);
    assert.equal(isLanguageCode('Korean'), false);
  });

  it('treats a missing or empty manifest as no samples', () => {
    assert.deepEqual(parseManifest({ samples: [] }), []);
    assert.deepEqual(parseManifest({}), []);
    assert.deepEqual(parseManifest(null), []);
  });

  it('resolves voice ranges', () => {
    assert.deepEqual(rangeFor({ file: 'a', name: 'a', language: 'ko', voiceRange: 'higher' }), { minF0: 140, maxF0: 500 });
    assert.deepEqual(rangeFor({ file: 'a', name: 'a', language: 'ko', voiceRange: { minF0: 100, maxF0: 400 } }), { minF0: 100, maxF0: 400 });
    // Invalid custom range falls back to Any voice.
    assert.deepEqual(rangeFor({ file: 'a', name: 'a', language: 'ko', voiceRange: { minF0: 300, maxF0: 400 } }), { minF0: 50, maxF0: 800 });
    assert.deepEqual(rangeFor({ file: 'a', name: 'a', language: 'ko' }), { minF0: 50, maxF0: 800 });
  });

  it('ids and language labels', () => {
    const id = sampleId({ file: 'ko/q.mp3', name: 'q', language: 'ko' });
    assert.equal(id, 'sample:ko/q.mp3');
    assert.ok(isSampleId(id));
    assert.ok(!isSampleId('8c1e…'));
    assert.ok(!isSampleId(undefined));
    assert.equal(languageLabel('Korean'), 'Korean');
    assert.match(languageLabel('ko'), /Korean|ko|한국어/);
  });
});
