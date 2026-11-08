// Compare screen (M1 spec §8): pick a Model (A) and a Me phrase (B), align, nudge, and play
// A, B, or A then B with one playhead in aligned time. A's video plays when it has one.

import { formatTime } from '../format.ts';
import { getPhrase, getSource, type Phrase, type PhraseInfo } from '../library/db.ts';
import { firstVoicedTime } from '../phrases.ts';
import { Player } from '../player.ts';
import { type ChartTrace, CompareChart } from './compareChart.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GAP_BETWEEN_MS = 400;

type Which = 'a' | 'b';

interface Loaded {
  phrase: Phrase;
  url: string; // object URL for the media element
  start: number; // phrase start within that media (sourceStart for video, 0 for the WAV)
  hasVideo: boolean;
}

export class CompareView {
  private readonly pickA = $<HTMLSelectElement>('pick-a');
  private readonly pickB = $<HTMLSelectElement>('pick-b');
  private readonly alignOff = $<HTMLButtonElement>('align-off');
  private readonly alignStart = $<HTMLButtonElement>('align-start');
  private readonly nudgeLabel = $<HTMLSpanElement>('nudge-label');
  private readonly nudgeReset = $<HTMLButtonElement>('nudge-reset');
  private readonly empty = $<HTMLParagraphElement>('compare-empty');
  private readonly stage = $<HTMLDivElement>('compare-stage');
  private readonly videoWrap = $<HTMLDivElement>('compare-video-wrap');
  private readonly mediaA = $<HTMLVideoElement>('compare-media-a');
  private readonly playA = $<HTMLButtonElement>('play-a');
  private readonly playB = $<HTMLButtonElement>('play-b');
  private readonly playAB = $<HTMLButtonElement>('play-ab');
  private readonly time = $<HTMLSpanElement>('compare-time');
  private readonly chart = new CompareChart($<HTMLDivElement>('compare-wrap'), $<HTMLCanvasElement>('compare-canvas'));
  private readonly playerA = new Player(this.mediaA);
  private readonly playerB = new Player($<HTMLAudioElement>('compare-media-b'));

  private items: PhraseInfo[] = [];
  private a: Loaded | null = null;
  private b: Loaded | null = null;
  private align: 'off' | 'start' = 'start';
  private nudge = 0; // seconds; positive moves B later
  private playing: Which | null = null;
  private sequence = false;
  private pendingB: ReturnType<typeof setTimeout> | null = null;
  /** Per-side load counters, so a slow load can't overwrite a newer choice. */
  private loadSeq = { a: 0, b: 0 };

  constructor() {
    this.pickA.addEventListener('change', () => void this.load('a', this.pickA.value));
    this.pickB.addEventListener('change', () => void this.load('b', this.pickB.value));
    this.alignOff.addEventListener('click', () => this.setAlign('off'));
    this.alignStart.addEventListener('click', () => this.setAlign('start'));
    this.nudgeReset.addEventListener('click', () => {
      this.nudge = 0;
      this.redraw();
    });
    this.chart.onNudge = (offsetB) => {
      if (!this.b) return;
      this.nudge = this.baseOffset(this.b.phrase) - offsetB;
      this.showNudge();
    };
    this.playA.addEventListener('click', () => this.toggle('a', false));
    this.playB.addEventListener('click', () => this.toggle('b', false));
    this.playAB.addEventListener('click', () => this.toggle('a', true));
    this.mediaA.addEventListener('click', () => this.toggle('a', false));
  }

  /** Library changed: refresh the pickers (keeping current choices when possible). */
  setItems(items: PhraseInfo[]): void {
    this.items = items;
    this.fillPickers();
  }

  /** Opens with a phrase chosen from the library; picks a sensible partner for it. */
  async openWith(id: string): Promise<void> {
    this.stop();
    const models = this.items.filter((i) => i.phrase.role === 'model').map((i) => i.phrase);
    const mes = this.items.filter((i) => i.phrase.role === 'me').map((i) => i.phrase);
    const chosen = this.items.find((i) => i.phrase.id === id)?.phrase;
    let aId: string | undefined;
    let bId: string | undefined;
    if (chosen?.role === 'model') {
      aId = chosen.id;
      bId = (mes.find((m) => m.modelId === chosen.id) ?? mes[0])?.id;
    } else if (chosen) {
      bId = chosen.id;
      aId = (models.find((m) => m.id === chosen.modelId) ?? models[0])?.id;
    }
    this.nudge = 0;
    this.fillPickers(aId, bId);
    await Promise.all([this.load('a', aId ?? ''), this.load('b', bId ?? '')]);
  }

  /** Stops playback and releases media (when leaving the screen). */
  close(): void {
    this.stop();
    for (const which of ['a', 'b'] as const) this.release(which);
  }

  /** Called every animation frame while the compare screen is visible. */
  tick(): void {
    if (!this.playing) return;
    const cur = this.playing === 'a' ? this.a : this.b;
    const player = this.playing === 'a' ? this.playerA : this.playerB;
    if (!cur) return;
    const t = player.time() - cur.start; // time within the phrase
    const aligned = t - this.offsetOf(this.playing);
    this.chart.setPlayhead(aligned);
    this.time.textContent = `${this.playing.toUpperCase()} ${formatTime(Math.max(0, t))}`;
    if (t >= cur.phrase.duration - 0.01 || !player.playing) {
      player.pause();
      const wasA = this.playing === 'a';
      this.playing = null;
      if (wasA && this.sequence && this.b) {
        this.pendingB = setTimeout(() => {
          this.pendingB = null;
          void this.start('b', true);
        }, GAP_BETWEEN_MS);
        this.playing = null;
        this.syncButtons(true);
      } else {
        this.sequence = false;
        this.syncButtons();
      }
    }
  }

  // ---- loading ----

  private fillPickers(aId = this.pickA.value, bId = this.pickB.value): void {
    const models = this.items.filter((i) => i.phrase.role === 'model').map((i) => i.phrase);
    const mes = this.items.filter((i) => i.phrase.role === 'me').map((i) => i.phrase);
    // Takes linked to the chosen model first.
    mes.sort((x, y) => Number(y.modelId === aId) - Number(x.modelId === aId) || y.createdAt - x.createdAt);
    const opts = (list: Phrase[]) => list.map((p) => new Option(p.name, p.id));
    this.pickA.replaceChildren(...opts(models));
    this.pickB.replaceChildren(...opts(mes));
    if (aId && models.some((m) => m.id === aId)) this.pickA.value = aId;
    if (bId && mes.some((m) => m.id === bId)) this.pickB.value = bId;

    const missing = !models.length ? 'a Model phrase' : !mes.length ? 'one of your own phrases as "Me"' : '';
    this.empty.hidden = !missing;
    this.empty.textContent = missing
      ? `To compare, save ${missing} first: load a clip or record yourself, press "Select phrase", then "Save phrase…".`
      : '';
    this.stage.hidden = !models.length && !mes.length;
    this.playA.disabled = !models.length;
    this.playB.disabled = !mes.length;
    this.playAB.disabled = !models.length || !mes.length;
  }

  private async load(which: Which, id: string): Promise<void> {
    if (this.playing) this.stop();
    const seq = ++this.loadSeq[which];
    this.release(which);
    if (!id) {
      this.redraw();
      return;
    }
    const phrase = await getPhrase(id);
    if (!phrase || seq !== this.loadSeq[which]) return;
    let url: string;
    let start = 0;
    let hasVideo = false;
    const source = which === 'a' && phrase.sourceId ? await getSource(phrase.sourceId) : undefined;
    if (source) {
      url = URL.createObjectURL(source.blob);
      start = phrase.sourceStart;
      hasVideo = source.type.startsWith('video/');
    } else {
      url = URL.createObjectURL(phrase.audio);
    }
    if (seq !== this.loadSeq[which]) {
      URL.revokeObjectURL(url);
      return;
    }
    const loaded: Loaded = { phrase, url, start, hasVideo };
    if (which === 'a') this.a = loaded;
    else this.b = loaded;
    if (which === 'b') this.nudge = 0;
    const player = which === 'a' ? this.playerA : this.playerB;
    try {
      await player.load(url);
      player.seek(start);
    } catch {
      // Unplayable media: the trace still shows.
    }
    if (which === 'a') {
      const showVideo = hasVideo && this.mediaA.videoWidth > 0;
      this.videoWrap.hidden = !showVideo;
      this.videoWrap.classList.toggle('portrait', showVideo && this.mediaA.videoHeight > this.mediaA.videoWidth);
    }
    this.redraw();
  }

  private release(which: Which): void {
    const cur = which === 'a' ? this.a : this.b;
    if (!cur) return;
    (which === 'a' ? this.playerA : this.playerB).unload();
    URL.revokeObjectURL(cur.url);
    if (which === 'a') {
      this.a = null;
      this.videoWrap.hidden = true;
    } else {
      this.b = null;
    }
  }

  // ---- alignment ----

  private setAlign(mode: 'off' | 'start'): void {
    this.align = mode;
    this.alignOff.setAttribute('aria-checked', String(mode === 'off'));
    this.alignStart.setAttribute('aria-checked', String(mode === 'start'));
    this.redraw();
  }

  private baseOffset(p: Phrase): number {
    return this.align === 'start' ? firstVoicedTime(p) : 0;
  }

  /** Aligned time = phrase time − offset. B's nudge moves it later. */
  private offsetOf(which: Which): number {
    const cur = which === 'a' ? this.a : this.b;
    if (!cur) return 0;
    return this.baseOffset(cur.phrase) - (which === 'b' ? this.nudge : 0);
  }

  private trace(which: Which): ChartTrace | null {
    const cur = which === 'a' ? this.a : this.b;
    if (!cur) return null;
    const p = cur.phrase;
    return {
      f0: p.f0,
      hopSeconds: p.hopSeconds,
      frameCenterOffset: p.frameCenterOffset,
      medianF0: p.medianF0,
      duration: p.duration,
      offset: this.offsetOf(which),
    };
  }

  private redraw(): void {
    this.chart.set(this.trace('a'), this.trace('b'));
    this.chart.setPlayhead(NaN);
    this.showNudge();
    this.time.textContent = formatTime(0);
  }

  private showNudge(): void {
    const n = Math.round(this.nudge * 100) / 100;
    this.nudgeReset.hidden = n === 0;
    this.nudgeLabel.textContent = n === 0 ? 'Drag the chart sideways to shift B.' : `B shifted ${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(2)} s`;
  }

  // ---- playback ----

  private toggle(which: Which, sequence: boolean): void {
    const button = sequence ? this.playAB : which === 'a' ? this.playA : this.playB;
    if (button.getAttribute('aria-pressed') === 'true') {
      this.stop();
      return;
    }
    this.stop();
    void this.start(which, sequence);
  }

  private async start(which: Which, sequence: boolean): Promise<void> {
    const cur = which === 'a' ? this.a : this.b;
    if (!cur) return;
    const player = which === 'a' ? this.playerA : this.playerB;
    this.sequence = sequence;
    this.playing = which;
    player.seek(cur.start);
    this.syncButtons();
    await player.play();
  }

  private stop(): void {
    if (this.pendingB) clearTimeout(this.pendingB);
    this.pendingB = null;
    this.playerA.pause();
    this.playerB.pause();
    this.playing = null;
    this.sequence = false;
    this.syncButtons();
  }

  private syncButtons(sequenceWaiting = false): void {
    const set = (b: HTMLButtonElement, on: boolean, label: string) => {
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? '■ Stop' : label;
    };
    const seq = this.sequence || sequenceWaiting;
    set(this.playA, this.playing === 'a' && !seq, '▶ A');
    set(this.playB, this.playing === 'b' && !seq, '▶ B');
    set(this.playAB, seq && (this.playing !== null || sequenceWaiting), '▶ A then B');
  }
}
