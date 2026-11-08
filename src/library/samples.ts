// Built-in, read-only sample phrases (M1 spec §7.1). They ship with the app in
// public/samples/ (listed in manifest.json), are analyzed in the browser when the app
// starts, and never go into the user's IndexedDB library. With no samples listed, the
// library shows no Samples section at all.

import { analyzeOnce } from '../analysisClient.ts';
import { ANALYSIS, RANGE_PRESETS, type VoiceRange, validateRange } from '../config.ts';
import { decodeToMono } from '../decoder.ts';
import type { Phrase } from './db.ts';

export const SAMPLE_PREFIX = 'sample:';

export interface SampleEntry {
  /** Path inside public/samples/, e.g. "ko/question.mp3". One short phrase per file. */
  file: string;
  name: string;
  /** Language code ("ko") or name ("Korean"); samples are grouped by it. */
  language: string;
  /** "any" | "lower" | "higher" | { minF0, maxF0 }; defaults to "any". */
  voiceRange?: 'any' | 'lower' | 'higher' | VoiceRange;
  /** Optional credit shown with the sample, e.g. "Read by LeeSeJin · LibriVox (public domain)". */
  credit?: string;
  /** Optional: what is said, written in the sample's language. */
  transcript?: string;
  /** Optional: a translation of the transcript, shown smaller underneath. */
  translation?: string;
}

export function isSampleId(id: string | undefined): boolean {
  return !!id && id.startsWith(SAMPLE_PREFIX);
}

export function sampleId(e: SampleEntry): string {
  return SAMPLE_PREFIX + e.file;
}

/** Keeps only well-formed entries (bad ones are skipped, not fatal). */
export function parseManifest(json: unknown): SampleEntry[] {
  const list = (json as { samples?: unknown })?.samples;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.filter((e): e is SampleEntry => {
    const ok =
      !!e &&
      typeof e.file === 'string' &&
      e.file.length > 0 &&
      !e.file.includes('..') &&
      typeof e.name === 'string' &&
      e.name.trim().length > 0 &&
      typeof e.language === 'string' &&
      e.language.trim().length > 0 &&
      (e.credit === undefined || typeof e.credit === 'string') &&
      (e.transcript === undefined || typeof e.transcript === 'string') &&
      (e.translation === undefined || typeof e.translation === 'string') &&
      !seen.has(e.file);
    if (ok) seen.add(e.file);
    return ok;
  });
}

export function rangeFor(e: SampleEntry): VoiceRange {
  const r = e.voiceRange;
  if (r === 'lower' || r === 'higher' || r === 'any') return { minF0: RANGE_PRESETS[r].minF0, maxF0: RANGE_PRESETS[r].maxF0 };
  if (r && typeof r === 'object' && !validateRange(r)) return { minF0: r.minF0, maxF0: r.maxF0 };
  return { minF0: RANGE_PRESETS.any.minF0, maxF0: RANGE_PRESETS.any.maxF0 };
}

/** "ko" → "Korean" (in the user's language); names are returned as given. */
export function isLanguageCode(language: string): boolean {
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language.trim());
}

export function languageLabel(language: string): string {
  const code = language.trim();
  if (isLanguageCode(code)) {
    try {
      return new Intl.DisplayNames(undefined, { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }
  return code;
}

const base = () => new URL('samples/', document.baseURI);

/** Reads the manifest; a missing or broken manifest means "no samples". */
export async function loadManifest(): Promise<SampleEntry[]> {
  try {
    const res = await fetch(new URL('manifest.json', base()), { cache: 'no-cache' });
    if (!res.ok) return [];
    return parseManifest(await res.json());
  } catch {
    return [];
  }
}

/** Fetches and analyzes one sample into a read-only Phrase. */
export async function loadSample(e: SampleEntry): Promise<Phrase> {
  const res = await fetch(new URL(e.file, base()));
  if (!res.ok) throw new Error(`Sample not found: ${e.file}`);
  const blob = await res.blob();
  const name = e.file.split('/').pop() ?? e.file;
  const file = new File([blob], name, { type: blob.type });
  const pcm = await decodeToMono(file, ANALYSIS.sampleRate);
  const range = rangeFor(e);
  const track = await analyzeOnce(pcm, range);
  return {
    id: sampleId(e),
    name: e.name,
    role: 'model',
    language: languageLabel(e.language),
    createdAt: 0,
    duration: pcm.length / ANALYSIS.sampleRate,
    audio: file, // the original file: used for playback, Practice and Download
    f0: track.f0,
    hopSeconds: track.hopSeconds,
    frameCenterOffset: track.frameCenterOffset,
    medianF0: track.medianF0,
    voiceRange: range,
    sourceStart: 0,
    sourceName: name,
    credit: e.credit?.trim() || undefined,
    transcript: e.transcript?.trim() || undefined,
    translation: e.translation?.trim() || undefined,
    lang: isLanguageCode(e.language) ? e.language.trim() : undefined,
  };
}
