// Builds a library Phrase from a span of an analyzed clip (shared by Save phrase and Practice).

import { ANALYSIS, type VoiceRange } from '../config.ts';
import { slicePcm, sliceTrace, type Span, type TraceLike } from '../phrases.ts';
import { encodeWav, floatToInt16 } from '../wav.ts';
import type { Phrase, Role } from './db.ts';

export interface PhraseFields {
  name: string;
  role: Role;
  language?: string;
  modelId?: string;
  sourceName: string;
}

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Cuts `span` out of a clip's 16 kHz audio and trace. */
export function phraseFromClip(
  fields: PhraseFields,
  track: TraceLike,
  pcm: Float32Array,
  span: Span,
  voiceRange: VoiceRange,
): Phrase {
  const t = sliceTrace(track, span);
  const audio = slicePcm(pcm, ANALYSIS.sampleRate, span);
  return {
    id: newId(),
    ...fields,
    createdAt: Date.now(),
    duration: audio.length / ANALYSIS.sampleRate,
    audio: encodeWav([floatToInt16(audio)], ANALYSIS.sampleRate),
    f0: t.f0,
    hopSeconds: track.hopSeconds,
    frameCenterOffset: t.frameCenterOffset,
    medianF0: t.medianF0,
    voiceRange: { ...voiceRange },
    sourceStart: span.start,
  };
}
