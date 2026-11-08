// Practice screen (M2 spec): pick a Model, then Try again = open mic → listen → count-in →
// record with a live line over the faded model → auto-stop → analyze → show the take.
// Takes live for the session; ★ saves one to the library as a Me phrase linked to the model.

import { analyzeOnce } from '../analysisClient.ts';
import { ANALYSIS, type VoiceRange } from '../config.ts';
import { decodeToMono } from '../decoder.ts';
import { formatTime } from '../format.ts';
import { deletePhrase, getSource, LibraryFull, type Phrase, type PhraseInfo, savePhrase, updatePhrase } from '../library/db.ts';
import { newId, phraseFromClip } from '../library/phraseBuilder.ts';
import type { SaveDialog } from '../library/saveDialog.ts';
import { LivePitch } from '../livePitch.ts';
import { firstVoicedTime, slicePcm, sliceTrace, type Span, sparklinePath, type TraceLike } from '../phrases.ts';
import { Player } from '../player.ts';
import { MicRecorder, RecorderError } from '../recorder.ts';
import { encodeWav, floatToInt16 } from '../wav.ts';
import { VoiceRangeControls } from '../voiceRange.ts';
import { isSampleId } from '../library/samples.ts';
import { getUnit, onUnitChange } from '../units.ts';
import { type Layer, PracticeChart, type Speaker } from './practiceChart.ts';
import { AutoStop, runningMedian, speechSpan, TAKE } from './takes.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MY_RANGE_KEY = 'intonation-tracer.myVoiceRange';
const GAP_MS = 400;
const UNSAVED = 'unsaved';

interface Trace {
  f0: Float32Array;
  hopSeconds: number;
  frameCenterOffset: number;
  medianF0: number;
  duration: number;
}

interface Model extends Trace {
  key: string; // phrase id, or UNSAVED
  name: string;
  language?: string;
  media: Blob;
  mediaStart: number;
  hasVideo: boolean;
  voiceRange: VoiceRange;
  /** 16 kHz audio of just the phrase, decoded on first re-analysis. */
  pcm?: Float32Array;
  /** Audio to decode for re-analysis (saved phrase audio); unsaved models slice the clip instead. */
  audio?: Blob;
}

/** A clip selection to practice before it's saved (from the player). */
export interface UnsavedModel {
  file: File;
  hasVideo: boolean;
  track: TraceLike;
  pcm: Float32Array; // whole clip, 16 kHz
  span: Span;
  voiceRange: VoiceRange;
  name: string;
}

interface Take extends Trace {
  audio: Blob; // 16 kHz WAV
  savedId?: string;
  shift: number; // seconds; positive = later
  pcm?: Float32Array; // decoded on first re-analysis
}

type Phase = 'idle' | 'arming' | 'listening' | 'countin' | 'recording' | 'analyzing';

export interface PracticeDeps {
  saveDialog: SaveDialog;
  /** Re-reads the library and returns it (also refreshes other views). */
  refreshLibrary(): Promise<PhraseInfo[]>;
}

export class PracticeView {
  private readonly picker = $<HTMLSelectElement>('pick-model');
  private readonly modelMeta = $<HTMLSpanElement>('model-meta');
  private readonly empty = $<HTMLParagraphElement>('practice-empty');
  private readonly stage = $<HTMLDivElement>('practice-stage');
  private readonly videoWrap = $<HTMLDivElement>('practice-video-wrap');
  private readonly modelEl = $<HTMLVideoElement>('practice-media');
  private readonly message = $<HTMLParagraphElement>('practice-message');
  private readonly playModelBtn = $<HTMLButtonElement>('play-model');
  private readonly speed = $<HTMLSelectElement>('model-speed');
  private readonly playTakeBtn = $<HTMLButtonElement>('play-take');
  private readonly playBothBtn = $<HTMLButtonElement>('play-model-me');
  private readonly tryBtn = $<HTMLButtonElement>('try-again');
  private readonly strip = $<HTMLDivElement>('take-strip');
  private readonly ghostBox = $<HTMLInputElement>('show-ghost');
  private readonly shiftLabel = $<HTMLSpanElement>('shift-label');
  private readonly shiftReset = $<HTMLButtonElement>('shift-reset');
  private readonly status = $<HTMLSpanElement>('practice-status');
  private readonly hzForModel = $<HTMLButtonElement>('hz-for-model');
  private readonly hzForMe = $<HTMLButtonElement>('hz-for-me');
  private readonly chart = new PracticeChart($<HTMLDivElement>('practice-wrap'), $<HTMLCanvasElement>('practice-canvas'));
  private readonly modelPlayer = new Player(this.modelEl);
  private readonly takePlayer = new Player($<HTMLAudioElement>('practice-take-media'));
  private readonly deps: PracticeDeps;
  private readonly modelRange: VoiceRangeControls;
  private readonly myRange: VoiceRangeControls;
  /** Bumped on every re-analysis request so stale results are dropped. */
  private rangeSeq = 0;

  private items: PhraseInfo[] = [];
  private unsaved: UnsavedModel | null = null;
  private model: Model | null = null;
  private modelUrl: string | null = null;
  private takeUrl: string | null = null;
  /** Session takes per model key, so switching models and back keeps them. */
  private session = new Map<string, Take[]>();
  private takes: Take[] = [];
  private current = -1;

  private phase: Phase = 'idle';
  private rec: MicRecorder | null = null;
  private countStart = 0;
  private live: { f0: Float32Array; count: number; firstVoiced: number; median: number; auto: AutoStop } | null = null;
  private playing: 'model' | 'take' | null = null;
  private sequence = false;
  private pendingTake: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PracticeDeps) {
    this.deps = deps;
    // The model's range starts at what it was traced with; it isn't remembered globally.
    this.modelRange = new VoiceRangeControls(
      $<HTMLSelectElement>('pr-model-preset'),
      $<HTMLInputElement>('pr-model-min'),
      $<HTMLInputElement>('pr-model-max'),
      $<HTMLSpanElement>('pr-model-status'),
      (r) => void this.reanalyzeModel(r),
      null,
    );
    // The user's own range is remembered: their voice doesn't change between models.
    this.myRange = new VoiceRangeControls(
      $<HTMLSelectElement>('pr-me-preset'),
      $<HTMLInputElement>('pr-me-min'),
      $<HTMLInputElement>('pr-me-max'),
      $<HTMLSpanElement>('pr-me-status'),
      (r) => void this.reanalyzeTakes(r),
      MY_RANGE_KEY,
    );
    // Pitch-axis aids: shared unit, right axis for Model or Me, and range guides while editing.
    this.chart.setUnit(getUnit());
    onUnitChange((u) => this.chart.setUnit(u));
    this.hzForModel.addEventListener('click', () => this.setHzFor('model'));
    this.hzForMe.addEventListener('click', () => this.setHzFor('me'));
    const rows = document.querySelectorAll<HTMLElement>('#practice .pr-range');
    this.modelRange.onEditing((r) => {
      if (r) this.setHzFor('model');
      this.chart.setGuide(r ? { range: r, who: 'model' } : null);
    }, rows[0]);
    this.myRange.onEditing((r) => {
      if (r) this.setHzFor('me');
      this.chart.setGuide(r ? { range: r, who: 'me' } : null);
    }, rows[1]);
    this.picker.addEventListener('change', () => void this.selectModel(this.picker.value));
    this.tryBtn.addEventListener('click', () => this.tryAgain());
    this.playModelBtn.addEventListener('click', () => this.togglePlay('model', false));
    this.playTakeBtn.addEventListener('click', () => this.togglePlay('take', false));
    this.playBothBtn.addEventListener('click', () => this.togglePlay('model', true));
    this.modelEl.addEventListener('click', () => this.togglePlay('model', false));
    this.speed.addEventListener('change', () => {
      this.modelEl.playbackRate = Number(this.speed.value);
    });
    this.ghostBox.addEventListener('change', () => this.redraw());
    this.shiftReset.addEventListener('click', () => {
      const t = this.takes[this.current];
      if (t) t.shift = 0;
      this.redraw();
    });
    this.chart.onShift = (offset) => {
      const t = this.takes[this.current];
      if (!t) return;
      t.shift = firstVoicedTime(t) - offset;
      this.showShift();
    };
    // Keep pitch when slowed (all current browsers default to true; set explicitly).
    (this.modelEl as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = true;
  }

  /** The model's typical pitch in Hz (for the explainer), or NaN. */
  get modelTypicalHz(): number {
    return this.model?.medianF0 ?? NaN;
  }

  /** Which speaker's Hz the right-hand axis shows. */
  private setHzFor(who: Speaker): void {
    this.hzForModel.setAttribute('aria-checked', String(who === 'model'));
    this.hzForMe.setAttribute('aria-checked', String(who === 'me'));
    this.chart.setHzFor(who);
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  setItems(items: PhraseInfo[]): void {
    this.items = items;
    this.fillPicker();
  }

  /** Opens with a library phrase: a Model, or a Me take (opens its model with that take current). */
  async openWithPhrase(id: string): Promise<void> {
    const p = this.items.find((i) => i.phrase.id === id)?.phrase;
    this.unsaved = null;
    if (!p) return this.selectModel('');
    if (p.role === 'model') return this.selectModel(p.id);
    await this.selectModel(p.modelId ?? '');
    const idx = this.takes.findIndex((t) => t.savedId === p.id);
    if (idx >= 0) this.setCurrent(idx);
  }

  async openWithUnsaved(u: UnsavedModel): Promise<void> {
    this.unsaved = u;
    this.session.delete(UNSAVED);
    await this.selectModel(UNSAVED);
  }

  close(): void {
    this.cancelTry();
    this.stopPlayback();
    this.releaseMedia();
  }

  // ---- model ----

  private fillPicker(): void {
    const models = this.items.filter((i) => i.phrase.role === 'model').map((i) => i.phrase);
    const opts = models.map((m) => new Option(isSampleId(m.id) ? `${m.name} (sample)` : m.name, m.id));
    if (this.unsaved) opts.unshift(new Option(`${this.unsaved.name} (not saved)`, UNSAVED));
    const keep = this.model?.key;
    this.picker.replaceChildren(...opts);
    if (keep && opts.some((o) => o.value === keep)) this.picker.value = keep;
    const none = !opts.length;
    this.empty.hidden = !none;
    this.empty.textContent = none
      ? 'Save a Model phrase first: load a clip, press "Select phrase", then "Save phrase…" or "Practice this phrase".'
      : '';
    this.stage.hidden = none;
    this.picker.disabled = none;
  }

  private async selectModel(key: string): Promise<void> {
    this.cancelTry();
    this.stopPlayback();
    this.releaseMedia();
    this.fillPicker();
    const models = this.items.filter((i) => i.phrase.role === 'model').map((i) => i.phrase);
    if (!key) key = this.unsaved ? UNSAVED : (models[0]?.id ?? '');
    this.picker.value = key;
    this.model = key === UNSAVED ? this.modelFromUnsaved() : await this.modelFromLibrary(models.find((m) => m.id === key));
    this.takes = this.model ? this.loadTakes(this.model) : [];
    this.current = this.takes.length - 1;
    this.status.textContent = '';
    this.rangeSeq++; // drop any re-analysis still running for the previous model
    if (this.model) this.modelRange.set(this.model.voiceRange);
    this.modelMeta.textContent = this.model
      ? [formatTime(this.model.duration), this.model.language].filter(Boolean).join(' · ')
      : '';
    if (this.model) {
      this.modelUrl = URL.createObjectURL(this.model.media);
      try {
        await this.modelPlayer.load(this.modelUrl);
        this.modelPlayer.seek(this.model.mediaStart);
      } catch {
        // trace still shows
      }
      this.modelEl.playbackRate = Number(this.speed.value);
      const showVideo = this.model.hasVideo && this.modelEl.videoWidth > 0;
      this.videoWrap.hidden = !showVideo;
      this.videoWrap.classList.toggle('portrait', showVideo && this.modelEl.videoHeight > this.modelEl.videoWidth);
    }
    this.renderStrip();
    this.redraw();
    this.syncButtons();
  }

  private modelFromUnsaved(): Model | null {
    const u = this.unsaved;
    if (!u) return null;
    const t = sliceTrace(u.track, u.span);
    return {
      key: UNSAVED,
      name: u.name,
      f0: t.f0,
      hopSeconds: u.track.hopSeconds,
      frameCenterOffset: t.frameCenterOffset,
      medianF0: t.medianF0,
      duration: u.span.end - u.span.start,
      media: u.file,
      mediaStart: u.span.start,
      hasVideo: u.hasVideo,
      voiceRange: { ...u.voiceRange },
      pcm: slicePcm(u.pcm, ANALYSIS.sampleRate, u.span),
    };
  }

  private async modelFromLibrary(p: Phrase | undefined): Promise<Model | null> {
    if (!p) return null;
    const src = p.sourceId ? await getSource(p.sourceId) : undefined;
    return {
      key: p.id,
      name: p.name,
      language: p.language,
      f0: p.f0,
      hopSeconds: p.hopSeconds,
      frameCenterOffset: p.frameCenterOffset,
      medianF0: p.medianF0,
      duration: p.duration,
      media: src?.blob ?? p.audio,
      mediaStart: src ? p.sourceStart : 0,
      hasVideo: !!src && src.type.startsWith('video/'),
      voiceRange: { ...p.voiceRange },
      audio: p.audio,
    };
  }

  /** Saved takes for this model (oldest first), then this session's takes. */
  private loadTakes(m: Model): Take[] {
    const saved = this.items
      .filter((i) => i.phrase.role === 'me' && i.phrase.modelId === m.key)
      .map((i) => i.phrase)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map<Take>((p) => ({ ...p, savedId: p.id, shift: 0 }));
    // Starred session takes are already in `saved` (read back from the library); keep the rest.
    const unsavedSession = (this.session.get(m.key) ?? []).filter((t) => !t.savedId);
    return [...saved, ...unsavedSession];
  }

  private releaseMedia(): void {
    this.modelPlayer.unload();
    this.takePlayer.unload();
    if (this.modelUrl) URL.revokeObjectURL(this.modelUrl);
    if (this.takeUrl) URL.revokeObjectURL(this.takeUrl);
    this.modelUrl = this.takeUrl = null;
    this.videoWrap.hidden = true;
  }

  // ---- the loop ----

  private tryAgain(): void {
    if (this.phase === 'idle') void this.startTry();
    else if (this.phase === 'recording') void this.finishRecording('manual');
    else if (this.phase !== 'analyzing') this.cancelTry();
  }

  private async startTry(): Promise<void> {
    if (!this.model) return;
    this.stopPlayback();
    this.status.textContent = '';
    this.message.hidden = true;
    this.setPhase('arming');
    const rec = new MicRecorder();
    rec.capturing = false; // mic open, nothing kept while the model plays
    this.rec = rec;
    try {
      await rec.start();
    } catch (err) {
      if (this.rec !== rec) return;
      this.rec = null;
      this.setPhase('idle');
      this.status.textContent = err instanceof RecorderError ? err.message : "Couldn't access the microphone.";
      return;
    }
    if (this.rec !== rec) {
      rec.cancel();
      return;
    }
    rec.onEnded = () => void this.finishRecording('manual');
    this.setPhase('listening');
    this.modelPlayer.seek(this.model.mediaStart);
    await this.modelPlayer.play();
  }

  /** Cancels a try before or during recording; nothing is kept. */
  cancelTry(): void {
    if (this.phase === 'idle' || this.phase === 'analyzing') return;
    this.rec?.cancel();
    this.rec = null;
    this.live = null;
    this.modelPlayer.pause();
    this.chart.setLive(null);
    this.chart.setCountIn('');
    this.chart.setModelFaded(false);
    this.redraw();
    this.setPhase('idle');
  }

  private beginRecording(): void {
    if (!this.rec || !this.model) return;
    const rec = this.rec;
    const auto = new AutoStop(this.model.duration);
    const live = { f0: new Float32Array(100 * 60), count: 0, firstVoiced: -1, median: NaN, auto };
    this.live = live;
    const pitch = new LivePitch(rec.sampleRate, this.myRange.range, (f) => {
      if (live.count >= live.f0.length) return;
      const i = live.count++;
      live.f0[i] = f.f0;
      const voiced = !Number.isNaN(f.f0);
      auto.frame(i * 0.01 + 0.02, voiced);
      if (voiced && live.firstVoiced < 0) live.firstVoiced = i;
      if (voiced && (i % 10 === 0 || Number.isNaN(live.median))) live.median = runningMedian(live.f0, live.count);
    });
    rec.onAudio = (x) => pitch.push(x);
    rec.capturing = true;
    // While recording: faded model, the last take as a faint ghost, and the live line.
    this.redraw(true);
    this.chart.setModelFaded(true);
    this.setPhase('recording');
  }

  private async finishRecording(reason: 'manual' | 'silence' | 'no-speech' | 'limit'): Promise<void> {
    const rec = this.rec;
    if (!rec || this.phase !== 'recording') return this.cancelTry();
    this.rec = null;
    this.live = null;
    const r = rec.stop();
    this.chart.setLive(null);
    this.chart.setModelFaded(false);
    this.redraw();
    if (reason === 'no-speech') {
      this.setPhase('idle');
      this.status.textContent = "Didn't hear anything. Check your microphone and try again.";
      return;
    }
    this.setPhase('analyzing');
    try {
      const wav = new File([encodeWav(r.chunks, r.sampleRate)], 'take.wav', { type: 'audio/wav' });
      const pcm = await decodeToMono(wav, ANALYSIS.sampleRate);
      const track = await analyzeOnce(pcm, this.myRange.range);
      const span = speechSpan(track);
      if (!span) {
        this.status.textContent = "Didn't catch any speech. Try again a little louder.";
        return;
      }
      const t = sliceTrace(track, span);
      const audio = slicePcm(pcm, ANALYSIS.sampleRate, span);
      const take: Take = {
        pcm: audio,
        f0: t.f0,
        hopSeconds: track.hopSeconds,
        frameCenterOffset: t.frameCenterOffset,
        medianF0: t.medianF0,
        duration: audio.length / ANALYSIS.sampleRate,
        audio: encodeWav([floatToInt16(audio)], ANALYSIS.sampleRate),
        shift: 0,
      };
      this.takes.push(take);
      if (this.model) this.session.set(this.model.key, [...(this.session.get(this.model.key) ?? []), take]);
      this.setCurrent(this.takes.length - 1);
      this.status.textContent = 'Star a take to keep it.';
    } catch {
      this.status.textContent = "Couldn't analyze that take. Try again.";
    } finally {
      this.setPhase('idle');
    }
  }

  /** Called every animation frame while Practice is visible. */
  tick(): void {
    switch (this.phase) {
      case 'listening': {
        if (!this.model) return;
        const t = this.modelPlayer.time() - this.model.mediaStart;
        this.chart.setPlayhead(t - firstVoicedTime(this.model));
        if (t >= this.model.duration - 0.01 || !this.modelPlayer.playing) {
          this.modelPlayer.pause();
          this.chart.setPlayhead(NaN);
          this.countStart = performance.now();
          this.setPhase('countin');
        }
        return;
      }
      case 'countin': {
        const step = Math.floor((performance.now() - this.countStart) / 1000 / TAKE.countInStep);
        if (step >= 3) {
          this.chart.setCountIn('');
          this.beginRecording();
        } else {
          const label = String(3 - step);
          this.chart.setCountIn(label);
          this.tryBtn.textContent = label;
        }
        return;
      }
      case 'recording': {
        const live = this.live;
        if (!live || !this.rec) return;
        if (live.firstVoiced >= 0 && !Number.isNaN(live.median)) {
          this.chart.setLive({
            kind: 'live',
            f0: live.f0,
            count: live.count,
            hopSeconds: 0.01,
            frameCenterOffset: 0.02,
            medianF0: live.median,
            duration: live.count * 0.01,
            offset: 0.02 + live.firstVoiced * 0.01,
          });
        }
        const reason = live.auto.check(this.rec.seconds);
        if (reason) void this.finishRecording(reason);
        return;
      }
      default:
        this.tickPlayback();
    }
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.tryBtn.classList.toggle('recording', p === 'recording');
    this.tryBtn.setAttribute('aria-pressed', String(p !== 'idle'));
    const labels: Record<Phase, string> = {
      idle: '● Try again',
      arming: 'Allow microphone…',
      listening: '🔊 Listening…',
      countin: '3',
      recording: '■ Stop',
      analyzing: 'Analyzing…',
    };
    this.tryBtn.textContent = labels[p];
    this.syncButtons();
  }

  // ---- takes ----

  private setCurrent(i: number): void {
    this.stopPlayback();
    this.current = i;
    this.renderStrip();
    this.redraw();
    this.syncButtons();
  }

  private renderStrip(): void {
    const chips = this.takes.map((t, i) => {
      const chip = document.createElement('div');
      chip.className = `take-chip${i === this.current ? ' current' : ''}`;
      chip.setAttribute('role', 'listitem');
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'take-pick';
      pick.setAttribute('aria-pressed', String(i === this.current));
      pick.setAttribute('aria-label', `Take ${i + 1}${t.savedId ? ', saved' : ''}`);
      const label = document.createElement('span');
      label.textContent = `Take ${i + 1}`;
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'spark me');
      svg.setAttribute('viewBox', '0 0 64 20');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', sparklinePath(t.f0, t.medianF0, 64, 20));
      svg.append(path);
      pick.append(label, svg);
      pick.addEventListener('click', () => this.setCurrent(i));
      const star = document.createElement('button');
      star.type = 'button';
      star.className = `take-star${t.savedId ? ' on' : ''}`;
      star.textContent = t.savedId ? '★' : '☆';
      star.setAttribute('aria-pressed', String(!!t.savedId));
      star.setAttribute('aria-label', t.savedId ? `Remove take ${i + 1} from the library` : `Star take ${i + 1} to save it`);
      star.title = t.savedId ? 'Saved — click to remove from the library' : 'Star to save to the library';
      star.addEventListener('click', () => void this.toggleStar(i));
      chip.append(pick, star);
      return chip;
    });
    if (!chips.length) {
      const p = document.createElement('span');
      p.className = 'hint';
      p.textContent = 'No takes yet. Press "Try again" to record one.';
      chips.push(p as unknown as HTMLDivElement);
    }
    this.strip.replaceChildren(...chips);
    this.strip.querySelector('.current')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  private async toggleStar(i: number): Promise<void> {
    const take = this.takes[i];
    if (!take || !this.model) return;
    try {
      if (take.savedId) {
        await deletePhrase(take.savedId);
        take.savedId = undefined;
        // Keep it in the session so it isn't lost.
        this.session.set(this.model.key, [...(this.session.get(this.model.key) ?? []).filter((t) => t !== take), take]);
        this.status.textContent = `Take ${i + 1} removed from the library.`;
      } else {
        const modelId = await this.ensureModelSaved();
        if (!modelId) return;
        const phrase: Phrase = {
          id: newId(),
          name: `${this.model.name} – take ${i + 1}`,
          role: 'me',
          language: this.model.language,
          modelId,
          createdAt: Date.now(),
          duration: take.duration,
          audio: take.audio,
          f0: take.f0,
          hopSeconds: take.hopSeconds,
          frameCenterOffset: take.frameCenterOffset,
          medianF0: take.medianF0,
          voiceRange: { ...this.myRange.range },
          sourceStart: 0,
          sourceName: 'Practice take',
        };
        await savePhrase(phrase);
        take.savedId = phrase.id;
        this.status.textContent = `Take ${i + 1} saved to the library.`;
      }
      await this.deps.refreshLibrary();
    } catch (err) {
      this.status.textContent =
        err instanceof LibraryFull ? "Couldn't save: this browser is out of storage space." : "Couldn't update the library.";
    }
    this.renderStrip();
  }

  /** Saves an unsaved model (via the dialog) so a take can link to it. Returns its id, or null. */
  private async ensureModelSaved(): Promise<string | null> {
    const m = this.model;
    if (!m) return null;
    if (m.key !== UNSAVED) return m.key;
    const u = this.unsaved;
    if (!u) return null;
    const items = this.items;
    let answer = await this.deps.saveDialog.ask({
      title: 'Save the model',
      lockRole: 'model',
      defaultRole: 'model',
      defaultName: u.name,
      summary: 'Save the model so your starred take can be linked to it.',
      videoSize: u.hasVideo ? u.file.size : 0,
      models: [],
      languages: [...new Set(items.map((i) => i.phrase.language).filter((l): l is string => !!l))],
    });
    while (answer) {
      const phrase = phraseFromClip(
        { name: answer.name, role: 'model', language: answer.language, sourceName: u.file.name },
        u.track,
        u.pcm,
        u.span,
        m.voiceRange,
      );
      // If the model's range was changed in Practice, save the trace that's on screen.
      Object.assign(phrase, {
        f0: m.f0,
        hopSeconds: m.hopSeconds,
        frameCenterOffset: m.frameCenterOffset,
        medianF0: m.medianF0,
      });
      try {
        await savePhrase(phrase, answer.keepVideo ? u.file : undefined);
        this.deps.saveDialog.close();
        // The model is now a library Model; move this session's takes over to it.
        const takes = this.session.get(UNSAVED) ?? [];
        this.session.delete(UNSAVED);
        this.session.set(phrase.id, takes);
        this.unsaved = null;
        m.key = phrase.id;
        m.name = phrase.name;
        m.language = phrase.language;
        this.items = await this.deps.refreshLibrary();
        this.fillPicker();
        this.picker.value = phrase.id;
        return phrase.id;
      } catch (err) {
        answer = await this.deps.saveDialog.showError(
          err instanceof LibraryFull
            ? "Couldn't save: this browser is out of storage space. Untick \"Keep video\", or free space in the library."
            : "Couldn't save to the library in this browser.",
        );
      }
    }
    return null;
  }

  // ---- voice ranges ----

  /** Re-traces the model with a new range; saved models are updated in the library. */
  private async reanalyzeModel(range: VoiceRange): Promise<void> {
    const m = this.model;
    if (!m) return;
    const seq = ++this.rangeSeq;
    this.modelRange.setBusy(true);
    this.setRangeBusy(true);
    try {
      m.pcm ??= m.audio ? await decodeToMono(new File([m.audio], 'model.wav', { type: 'audio/wav' }), ANALYSIS.sampleRate) : undefined;
      if (!m.pcm) return;
      const track = await analyzeOnce(m.pcm, range);
      if (seq !== this.rangeSeq || this.model !== m) return;
      Object.assign(m, {
        f0: track.f0,
        hopSeconds: track.hopSeconds,
        frameCenterOffset: track.frameCenterOffset,
        medianF0: track.medianF0,
        voiceRange: { ...range },
      });
      // Built-in samples are read-only: their new trace lasts for this visit only.
      if (m.key !== UNSAVED && !isSampleId(m.key)) {
        await updatePhrase(m.key, {
          f0: m.f0,
          hopSeconds: m.hopSeconds,
          frameCenterOffset: m.frameCenterOffset,
          medianF0: m.medianF0,
          voiceRange: { ...range },
        });
        this.items = await this.deps.refreshLibrary();
      }
      this.redraw();
      this.status.textContent = Number.isNaN(m.medianF0) ? 'No speech found in the model with this range. Try a wider one.' : '';
    } catch {
      this.status.textContent = "Couldn't re-trace the model.";
    } finally {
      if (seq === this.rangeSeq) {
        this.modelRange.setBusy(false);
        this.setRangeBusy(false);
      }
    }
  }

  /** Re-traces every take in the strip with the user's new range (saved takes are updated too). */
  private async reanalyzeTakes(range: VoiceRange): Promise<void> {
    if (!this.takes.length) return;
    const seq = ++this.rangeSeq;
    const takes = [...this.takes];
    this.myRange.setBusy(true);
    this.setRangeBusy(true);
    let changedLibrary = false;
    try {
      for (const t of takes) {
        t.pcm ??= await decodeToMono(new File([t.audio], 'take.wav', { type: 'audio/wav' }), ANALYSIS.sampleRate);
        const track = await analyzeOnce(t.pcm, range);
        if (seq !== this.rangeSeq) return;
        Object.assign(t, {
          f0: track.f0,
          hopSeconds: track.hopSeconds,
          frameCenterOffset: track.frameCenterOffset,
          medianF0: track.medianF0,
        });
        if (t.savedId) {
          await updatePhrase(t.savedId, {
            f0: t.f0,
            hopSeconds: t.hopSeconds,
            frameCenterOffset: t.frameCenterOffset,
            medianF0: t.medianF0,
            voiceRange: { ...range },
          });
          changedLibrary = true;
        }
      }
      if (changedLibrary) this.items = await this.deps.refreshLibrary();
      this.renderStrip();
      this.redraw();
    } catch {
      this.status.textContent = "Couldn't re-trace your takes.";
    } finally {
      if (seq === this.rangeSeq) {
        this.myRange.setBusy(false);
        this.setRangeBusy(false);
      }
    }
  }

  /** While re-tracing, recording and playback wait. */
  private rangeBusy = false;
  private setRangeBusy(busy: boolean): void {
    this.rangeBusy = busy;
    this.syncButtons();
  }

  // ---- chart ----

  private offsetOf(t: Trace): number {
    return firstVoicedTime(t);
  }

  private redraw(recording = false): void {
    const layers: Layer[] = [];
    if (this.model) layers.push({ kind: 'model', ...this.model, offset: this.offsetOf(this.model) });
    const take = this.takes[this.current];
    if (recording) {
      // The take being recorded is the live line; show the current take as the ghost.
      if (take && this.ghostBox.checked) layers.push({ kind: 'ghost', ...take, offset: this.offsetOf(take) - take.shift });
      this.chart.setLayers(layers);
      return;
    }
    if (take) layers.push({ kind: 'take', ...take, offset: this.offsetOf(take) - take.shift });
    const prev = this.takes[this.current - 1];
    if (prev && this.ghostBox.checked) layers.push({ kind: 'ghost', ...prev, offset: this.offsetOf(prev) - prev.shift });
    this.chart.setLayers(layers);
    this.chart.setPlayhead(NaN);
    this.showShift();
  }

  private showShift(): void {
    const t = this.takes[this.current];
    const n = t ? Math.round(t.shift * 100) / 100 : 0;
    this.shiftReset.hidden = n === 0;
    this.shiftLabel.textContent = !t
      ? ''
      : n === 0
        ? 'Drag the chart sideways to shift your take.'
        : `Take shifted ${n > 0 ? '+' : '−'}${Math.abs(n).toFixed(2)} s`;
  }

  // ---- playback ----

  private togglePlay(which: 'model' | 'take', sequence: boolean): void {
    if (this.phase !== 'idle') return;
    const btn = sequence ? this.playBothBtn : which === 'model' ? this.playModelBtn : this.playTakeBtn;
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    this.stopPlayback();
    if (!wasOn) void this.startPlay(which, sequence);
  }

  private async startPlay(which: 'model' | 'take', sequence: boolean): Promise<void> {
    this.sequence = sequence;
    if (which === 'model') {
      if (!this.model) return;
      this.playing = 'model';
      this.modelPlayer.seek(this.model.mediaStart);
      this.syncButtons();
      await this.modelPlayer.play();
    } else {
      const take = this.takes[this.current];
      if (!take) return;
      if (this.takeUrl) URL.revokeObjectURL(this.takeUrl);
      this.takeUrl = URL.createObjectURL(take.audio);
      this.playing = 'take';
      this.syncButtons();
      try {
        await this.takePlayer.load(this.takeUrl);
      } catch {
        this.stopPlayback();
        return;
      }
      this.takePlayer.seek(0);
      await this.takePlayer.play();
    }
  }

  private tickPlayback(): void {
    if (!this.playing) return;
    if (this.playing === 'model' && this.model) {
      const t = this.modelPlayer.time() - this.model.mediaStart;
      this.chart.setPlayhead(t - this.offsetOf(this.model));
      if (t >= this.model.duration - 0.01 || !this.modelPlayer.playing) {
        this.modelPlayer.pause();
        this.playing = null;
        if (this.sequence && this.takes[this.current]) {
          this.pendingTake = setTimeout(() => {
            this.pendingTake = null;
            void this.startPlay('take', true);
          }, GAP_MS);
        } else {
          this.sequence = false;
          this.chart.setPlayhead(NaN);
        }
        this.syncButtons();
      }
    } else if (this.playing === 'take') {
      const take = this.takes[this.current];
      if (!take) return;
      const t = this.takePlayer.time();
      this.chart.setPlayhead(t - (this.offsetOf(take) - take.shift));
      if (t >= take.duration - 0.01 || (!this.takePlayer.playing && t > 0.05)) {
        this.takePlayer.pause();
        this.playing = null;
        this.sequence = false;
        this.chart.setPlayhead(NaN);
        this.syncButtons();
      }
    }
  }

  private stopPlayback(): void {
    if (this.pendingTake) clearTimeout(this.pendingTake);
    this.pendingTake = null;
    this.modelPlayer.pause();
    this.takePlayer.pause();
    this.playing = null;
    this.sequence = false;
    this.chart.setPlayhead(NaN);
    this.syncButtons();
  }

  private syncButtons(): void {
    const idle = this.phase === 'idle';
    const hasTake = !!this.takes[this.current];
    const seq = this.sequence || this.pendingTake !== null;
    const set = (b: HTMLButtonElement, on: boolean, label: string, enabled: boolean) => {
      b.setAttribute('aria-pressed', String(on));
      b.textContent = on ? '■ Stop' : label;
      b.disabled = !enabled;
    };
    set(this.playModelBtn, this.playing === 'model' && !seq, '▶ Model', idle && !!this.model);
    set(this.playTakeBtn, this.playing === 'take' && !seq, '▶ My take', idle && hasTake);
    set(this.playBothBtn, seq, '▶ Model → Me', idle && !!this.model && hasTake);
    this.speed.disabled = !idle;
    this.picker.disabled = !idle || !this.picker.options.length;
    this.tryBtn.disabled = this.phase === 'analyzing' || (idle && (this.rangeBusy || !this.model));
    // Ranges can't change mid-try (the live line and take analysis use them).
    this.modelRange.setDisabled(!idle || !this.model);
    this.myRange.setDisabled(!idle);
  }

  // ---- keyboard (M2 spec §9) ----

  /** Returns true if the key was handled. */
  handleKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'r') this.tryAgain();
    else if (k === 'm') this.togglePlay('model', false);
    else if (e.key === ' ') {
      if (!e.repeat) this.togglePlay('take', false);
    } else if (e.key === 'Escape') this.cancelTry();
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= this.takes.length && this.phase === 'idle') this.setCurrent(Number(e.key) - 1);
    else return false;
    return true;
  }
}
