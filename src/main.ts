import { ANALYSIS, currentLimits, tooLongMessage, type VoiceRange } from './config.ts';
import { DecodeError, decodeToMono } from './decoder.ts';
import { looksLikeMedia, setupFileInput } from './fileInput.ts';
import { formatTime, spokenTime } from './format.ts';
import { LivePitch } from './livePitch.ts';
import { LiveView } from './liveView.ts';
import { getPhrase, getSource, LibraryFull, libraryAvailable, type Phrase, savePhrase } from './library/db.ts';
import { isSampleId, languageLabel, loadManifest, loadSample } from './library/samples.ts';
import { phraseFromClip } from './library/phraseBuilder.ts';
import { LibraryPanel } from './library/libraryPanel.ts';
import { SaveDialog } from './library/saveDialog.ts';
import { detectPhrases, PHRASE, phraseAt, type Span } from './phrases.ts';
import { Player } from './player.ts';
import { MicRecorder, RecorderError } from './recorder.ts';
import { SeekBar } from './seekBar.ts';
import { getStatus, setStatus, subscribe } from './state.ts';
import { TraceView } from './traceView.ts';
import type { PitchTrack, WorkerRequest, WorkerResponse } from './types.ts';
import { VoiceRangeControls } from './voiceRange.ts';
import { formatHz, stToHz } from './pitchAxis.ts';
import { PracticeView } from './practice/practiceView.ts';
import { bindUnitMenus, getUnit, onUnitChange } from './units.ts';
import { encodeWav } from './wav.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  fileName: $<HTMLHeadingElement>('file-name'),
  loadAnother: $<HTMLButtonElement>('load-another'),
  dropZone: $<HTMLElement>('drop-zone'),
  fileInput: $<HTMLInputElement>('file-input'),
  limitText: $<HTMLSpanElement>('limit-text'),
  error: $<HTMLParagraphElement>('error'),
  progress: $<HTMLElement>('progress'),
  progressLabel: $<HTMLParagraphElement>('progress-label'),
  progressBar: $<HTMLProgressElement>('progress-bar'),
  cancel: $<HTMLButtonElement>('cancel'),
  viewer: $<HTMLElement>('viewer'),
  traceWrap: $<HTMLElement>('trace-wrap'),
  traceCanvas: $<HTMLCanvasElement>('trace-canvas'),
  overlayCanvas: $<HTMLCanvasElement>('overlay-canvas'),
  noVoice: $<HTMLParagraphElement>('no-voice'),
  play: $<HTMLButtonElement>('play'),
  seek: $<HTMLInputElement>('seek'),
  timeCurrent: $<HTMLSpanElement>('time-current'),
  timeTotal: $<HTMLSpanElement>('time-total'),
  media: $<HTMLVideoElement>('media'),
  videoWrap: $<HTMLDivElement>('video-wrap'),
  rangePreset: $<HTMLSelectElement>('range-preset'),
  rangeMin: $<HTMLInputElement>('range-min'),
  rangeMax: $<HTMLInputElement>('range-max'),
  rangeStatus: $<HTMLSpanElement>('range-status'),
  actions: $<HTMLDivElement>('actions'),
  saveRecording: $<HTMLAnchorElement>('save-recording'),
  recordAgain: $<HTMLButtonElement>('record-again'),
  record: $<HTMLButtonElement>('record'),
  recorder: $<HTMLElement>('recorder'),
  liveWrap: $<HTMLDivElement>('live-wrap'),
  liveCanvas: $<HTMLCanvasElement>('live-canvas'),
  micWait: $<HTMLParagraphElement>('mic-wait'),
  recTime: $<HTMLSpanElement>('rec-time'),
  levelFill: $<HTMLDivElement>('level-fill'),
  stopRecording: $<HTMLButtonElement>('stop-recording'),
  cancelRecording: $<HTMLButtonElement>('cancel-recording'),
  recLimit: $<HTMLSpanElement>('rec-limit'),
  startRecording: $<HTMLButtonElement>('start-recording'),
  recDot: $<HTMLSpanElement>('rec-dot'),
  selectMode: $<HTMLButtonElement>('select-mode'),
  selectionBar: $<HTMLDivElement>('selection-bar'),
  selectionLabel: $<HTMLSpanElement>('selection-label'),
  playPhrase: $<HTMLButtonElement>('play-phrase'),
  savePhraseButton: $<HTMLButtonElement>('save-phrase'),
  clearSelection: $<HTMLButtonElement>('clear-selection'),
  selectionHint: $<HTMLSpanElement>('selection-hint'),
  openLibrary: $<HTMLButtonElement>('open-library'),
  practice: $<HTMLElement>('practice'),
  closePractice: $<HTMLButtonElement>('close-practice'),
  practicePhrase: $<HTMLButtonElement>('practice-phrase'),
};

const player = new Player(ui.media);
let scrubTime: number | null = null;

const traceView = new TraceView(ui.traceWrap, ui.traceCanvas, ui.overlayCanvas, {
  onSeek: (t) => seekTo(t),
  onScrub: (t) => {
    scrubTime = t;
  },
  onSelect: (span) => setSelection(span, false),
  onPick: (t) => setSelection(phraseAt(bands, t)),
});
// Axis unit (pitch-axis spec §3) and voice range guides while editing (§6).
traceView.setUnit(getUnit());
onUnitChange((u) => traceView.setUnit(u));
bindUnitMenus();

const seekBar = new SeekBar(ui.seek, ui.timeCurrent, ui.timeTotal, (t) => seekTo(t));

// ---- loading ----

let loadToken = 0;
let analysisSeq = 0;
let objectUrl: string | null = null;
/** Decoded 16 kHz mono audio of the current file, kept so a range change can re-analyze it. */
let currentPcm: Float32Array | null = null;
let currentName = '';
/** The loaded file, its trace, and phrase selection state (M1). */
let currentFile: File | null = null;
let currentTrack: PitchTrack | null = null;
let selection: Span | null = null;
let bands: Span[] = [];
let selectMode = false;
/** True when the loaded clip came from the microphone (offers "Save recording"). */
let currentIsRecording = false;

const voiceRange = new VoiceRangeControls(ui.rangePreset, ui.rangeMin, ui.rangeMax, ui.rangeStatus, (r) =>
  void reanalyze(r),
);
let worker: Worker | null = null;
let pendingReject: ((err: Error) => void) | null = null;

class Cancelled extends Error {}

ui.limitText.textContent = currentLimits().sizeLabel;
ui.recLimit.textContent = currentLimits().recordLabel;

setupFileInput(ui.dropZone, ui.fileInput, (file) => void loadFile(file));
ui.loadAnother.addEventListener('click', () => ui.fileInput.click());
ui.cancel.addEventListener('click', () => cancelLoad());

async function loadFile(file: File, fromMic = false): Promise<void> {
  const token = ++loadToken;
  stopRecorder();
  stopWorker();
  resetMedia();
  currentIsRecording = fromMic;
  currentFile = file;

  const limits = currentLimits();
  if (!looksLikeMedia(file)) return fail("This file's format isn't supported. Try MP3, WAV, M4A or MP4.");
  if (file.size > limits.maxBytes) {
    return fail(`Please use a file under ${limits.sizeLabel}. This one is ${Math.round(file.size / 1024 / 1024)} MB.`);
  }

  ui.fileName.textContent = file.name;
  setStatus({ kind: 'loading', step: 'decoding', progress: 0 });

  try {
    // 1. Duration check before spending memory on a decode.
    objectUrl = URL.createObjectURL(file);
    const metaDuration = await player.load(objectUrl);
    if (token !== loadToken) return;
    // Uploads are limited by size; this only stops files too long to analyze without crashing.
    if (Number.isFinite(metaDuration) && metaDuration > limits.maxAnalysisSeconds) {
      return fail(tooLongMessage(metaDuration, limits));
    }

    // 2. Decode to 16 kHz mono.
    const pcm = await decodeToMono(file, ANALYSIS.sampleRate);
    if (token !== loadToken) return;
    // Some files (e.g. WebM) only reveal their length after decoding.
    if (pcm.length / ANALYSIS.sampleRate > limits.maxAnalysisSeconds) {
      return fail(tooLongMessage(pcm.length / ANALYSIS.sampleRate, limits));
    }

    // 3. Analyze in the worker, using the current voice range.
    currentPcm = pcm;
    currentName = file.name;
    setStatus({ kind: 'loading', step: 'analyzing', progress: 0 });
    const track = await analyzeInWorker(pcm, voiceRange.range, (p) => {
      if (token === loadToken) setStatus({ kind: 'loading', step: 'analyzing', progress: p });
    });
    if (token !== loadToken) return;

    showTrack(file.name, track);
  } catch (err) {
    if (err instanceof Cancelled || token !== loadToken) return;
    if (err instanceof DecodeError) return fail(err.message);
    fail(err instanceof Error ? err.message : 'Something went wrong while loading this file.');
  }
}

/** Re-runs analysis on the loaded clip with a new range. Playback and the view keep going. */
async function reanalyze(range: VoiceRange): Promise<void> {
  if (getStatus().kind !== 'ready' || !currentPcm) return; // applies to the next file instead
  const token = loadToken;
  voiceRange.setBusy(true);
  try {
    const track = await analyzeInWorker(currentPcm, range, () => {});
    if (token !== loadToken) return;
    showTrack(currentName, track, true);
    voiceRange.setBusy(false);
  } catch (err) {
    if (err instanceof Cancelled || token !== loadToken) return;
    voiceRange.setBusy(false);
    ui.rangeStatus.textContent = 'Re-analysis failed. Try another range.';
  }
}

function analyzeInWorker(pcm: Float32Array, range: VoiceRange, onProgress: (p: number) => void): Promise<PitchTrack> {
  stopWorker(); // only one analysis at a time; a newer request replaces an older one
  const id = ++analysisSeq;
  worker = new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' });
  const w = worker;
  return new Promise<PitchTrack>((resolve, reject) => {
    pendingReject = reject;
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.id !== id) return;
      if (msg.type === 'progress') onProgress(msg.value);
      else {
        pendingReject = null;
        if (msg.type === 'done') resolve(msg.track);
        else reject(new Error(msg.message));
      }
    };
    w.onerror = (e) => {
      pendingReject = null;
      reject(new Error(e.message || 'Pitch analysis failed.'));
    };
    // Sent as a copy (no transfer) so the PCM stays here for later range changes.
    const req: WorkerRequest = { type: 'analyze', id, pcm, sampleRate: ANALYSIS.sampleRate, range };
    w.postMessage(req);
  });
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
  pendingReject?.(new Cancelled());
  pendingReject = null;
}

function resetMedia(): void {
  player.unload();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  currentPcm = null;
  currentIsRecording = false;
  currentFile = null;
  currentTrack = null;
  selection = null;
  bands = [];
  scrubTime = null;
  traceView.clear();
}

function cancelLoad(): void {
  loadToken++;
  stopRecorder();
  stopWorker();
  resetMedia();
  ui.fileName.textContent = 'Intonation Tracer';
  setStatus({ kind: 'empty' });
}

function fail(message: string): void {
  stopRecorder();
  stopWorker();
  resetMedia();
  ui.fileName.textContent = 'Intonation Tracer';
  setStatus({ kind: 'empty', error: message });
}

let duration = 0;

function showTrack(name: string, track: PitchTrack, keepView = false): void {
  if (!keepView) {
    duration = Number.isFinite(player.duration) ? player.duration : track.duration;
    // Show the picture only for files that have one; audio files keep the full-width trace.
    const hasVideo = ui.media.videoWidth > 0 && ui.media.videoHeight > 0;
    ui.videoWrap.hidden = !hasVideo;
    ui.videoWrap.classList.toggle('portrait', hasVideo && ui.media.videoHeight > ui.media.videoWidth);
    ui.media.setAttribute('aria-label', `Video: ${name}`);
    setStatus({ kind: 'ready' });
    seekBar.setDuration(duration);
    ui.saveRecording.hidden = !currentIsRecording;
    if (currentIsRecording && objectUrl) {
      ui.saveRecording.href = objectUrl;
      ui.saveRecording.download = name;
    }
  }
  traceView.setTrack(track, keepView);
  currentTrack = track;
  bands = detectPhrases(track);
  traceView.setBands(bands);
  if (!keepView) {
    setSelectMode(false); // each new clip starts in normal (seek) mode
    setSelection(null);
  } else {
    updateSelectionUi();
  }
  ui.noVoice.hidden = !Number.isNaN(track.medianF0);
  ui.noVoice.textContent =
    voiceRange.range.minF0 === ANALYSIS.minF0 && voiceRange.range.maxF0 === ANALYSIS.maxF0
      ? 'No speech detected in this file.'
      : 'No speech detected in this voice range. Try a wider range.';
  ui.traceCanvas.setAttribute('aria-label', `Pitch trace of ${name}, ${spokenTime(duration)}`);
}

// ---- recording (spec §2.1) ----

const liveView = new LiveView(ui.liveWrap, ui.liveCanvas);
let recorder: MicRecorder | null = null;
let levelDb = -100;

ui.record.addEventListener('click', () => void startRecording());
ui.recordAgain.addEventListener('click', () => void startRecording());
ui.stopRecording.addEventListener('click', () => stopRecording());
ui.startRecording.addEventListener('click', () => beginCapture());
ui.cancelRecording.addEventListener('click', () => cancelLoad());

async function startRecording(): Promise<void> {
  if (recorder) return;
  loadToken++;
  stopWorker();
  resetMedia();
  ui.fileName.textContent = 'Recording';
  ui.recTime.textContent = formatTime(0);
  levelDb = -100;
  liveView.reset(voiceRange.range);
  setStatus({ kind: 'recording', phase: 'waiting' });

  const rec = new MicRecorder();
  recorder = rec;
  try {
    await rec.start(); // asks for permission the first time
  } catch (err) {
    if (recorder !== rec) return; // cancelled while waiting
    recorder = null;
    return fail(err instanceof RecorderError ? err.message : "Couldn't access the microphone.");
  }
  if (recorder !== rec) {
    rec.cancel(); // cancelled while waiting
    return;
  }
  // Mic is open: show the level, but don't record until the user presses Start.
  rec.capturing = false;
  const live = new LivePitch(rec.sampleRate, voiceRange.range, (f) => liveView.push(f.f0));
  rec.onMonitor = (x) => {
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    levelDb = Math.max(levelDb, 20 * Math.log10(peak + 1e-9));
  };
  rec.onAudio = (x) => live.push(x);
  rec.onEnded = () => {
    // Mic unplugged or permission revoked: keep what was recorded, or explain if nothing was.
    const s = getStatus();
    if (s.kind === 'recording' && s.phase === 'live') stopRecording();
    else fail('The microphone was disconnected. Connect it and try again.');
  };
  setStatus({ kind: 'recording', phase: 'ready' });
  ui.startRecording.focus();
}

/** Start pressed: begin keeping audio and drawing the live trace. */
function beginCapture(): void {
  const s = getStatus();
  if (!recorder || s.kind !== 'recording' || s.phase !== 'ready') return;
  recorder.capturing = true;
  setStatus({ kind: 'recording', phase: 'live' });
  ui.stopRecording.focus();
}

/** Stops recording and loads the result through the normal file pipeline. */
function stopRecording(): void {
  const rec = recorder;
  const s = getStatus();
  if (!rec || s.kind !== 'recording' || s.phase !== 'live') return;
  recorder = null;
  const r = rec.stop();
  if (r.length < r.sampleRate * 0.5) return fail('That recording was too short. Speak for at least a second, then press Stop.');
  const file = new File([encodeWav(r.chunks, r.sampleRate)], recordingName(), { type: 'audio/wav' });
  void loadFile(file, true);
}

function stopRecorder(): void {
  recorder?.cancel();
  recorder = null;
}

function recordingName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.wav`;
}

function recordingFrame(): void {
  if (!recorder) return;
  const seconds = recorder.seconds;
  ui.recTime.textContent = formatTime(seconds);
  liveView.draw();
  // Level meter: −60…0 dBFS, falling back slowly after peaks.
  const pct = Math.max(0, Math.min(100, ((levelDb + 60) / 60) * 100));
  ui.levelFill.style.width = `${pct}%`;
  ui.levelFill.classList.toggle('hot', levelDb > -3);
  levelDb -= 1.5;
  // Stop just short of the limit so the file passes the length check.
  if (seconds >= currentLimits().maxRecordSeconds - 0.25) stopRecording();
}

// ---- playback ----

function seekTo(t: number): void {
  player.seek(t);
  traceView.reveal(t);
}

/** Play/pause; with a phrase selected, plays just that phrase (from its start if outside it). */
function togglePlay(): void {
  if (!player.playing && selection) {
    const t = player.time();
    if (t < selection.start || t >= selection.end - 0.05) player.seek(selection.start);
  }
  player.toggle();
}

ui.play.addEventListener('click', () => togglePlay());
// Tapping the video plays/pauses too, like most players.
ui.media.addEventListener('click', () => togglePlay());

// ---- phrase selection (M1 spec §4) ----

ui.selectMode.addEventListener('click', () => setSelectMode(!selectMode));
ui.playPhrase.addEventListener('click', () => {
  if (!selection) return;
  player.seek(selection.start);
  traceView.reveal(selection.start);
  void player.play();
});
ui.clearSelection.addEventListener('click', () => setSelection(null));
ui.savePhraseButton.addEventListener('click', () => void saveSelection());

function setSelectMode(on: boolean): void {
  selectMode = on;
  ui.selectMode.setAttribute('aria-pressed', String(on));
  traceView.setMode(on ? 'select' : 'seek');
  updateSelectionUi();
}

function setSelection(span: Span | null, final = true): void {
  selection = span;
  if (final) traceView.setSelection(span);
  if (span && final) traceView.reveal(span.start);
  ui.selectionHint.textContent = '';
  updateSelectionUi();
}

function wholeClipSavable(): boolean {
  return !!currentTrack && currentTrack.duration <= PHRASE.maxSeconds;
}

function updateSelectionUi(): void {
  const show = selectMode || !!selection;
  ui.selectionBar.hidden = !show;
  ui.playPhrase.hidden = !selection;
  ui.clearSelection.hidden = !selection;
  if (selection) {
    const len = selection.end - selection.start;
    ui.selectionLabel.textContent = `Phrase ${formatTime(selection.start)}–${formatTime(selection.end)} (${len.toFixed(1)} s)`;
    ui.savePhraseButton.textContent = 'Save phrase…';
    ui.savePhraseButton.hidden = false;
    ui.practicePhrase.textContent = '🎙 Practice this phrase';
    ui.practicePhrase.hidden = false;
  } else {
    ui.selectionLabel.textContent = bands.length
      ? 'Click a phrase on the trace, or drag across it.'
      : 'Drag across the trace to select a phrase.';
    ui.savePhraseButton.textContent = 'Save whole clip…';
    ui.savePhraseButton.hidden = !wholeClipSavable();
    ui.practicePhrase.textContent = '🎙 Practice this clip';
    ui.practicePhrase.hidden = !wholeClipSavable();
  }
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

async function saveSelection(): Promise<void> {
  if (!currentPcm || !currentTrack || !currentFile) return;
  const span: Span | null = selection ?? (wholeClipSavable() ? { start: 0, end: currentTrack.duration } : null);
  if (!span) return;
  player.pause();
  const file = currentFile;
  const track = currentTrack;
  const pcmAll = currentPcm;
  const hasVideo = !ui.videoWrap.hidden;
  const items = library.allPhrases; // samples too, so a take can be linked to one
  const whole = !selection;
  const defaultName = currentIsRecording
    ? `My take ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : whole
      ? baseName(file.name)
      : `${baseName(file.name)} ${formatTime(span.start)}`;
  let answer = await saveDialog.ask({
    defaultName,
    summary: `${whole ? 'Whole clip' : `${formatTime(span.start)}–${formatTime(span.end)}`} (${(span.end - span.start).toFixed(1)} s) from ${file.name}`,
    defaultRole: currentIsRecording ? 'me' : 'model',
    videoSize: hasVideo ? file.size : 0,
    models: items.filter((i) => i.phrase.role === 'model').map((i) => ({ id: i.phrase.id, name: i.phrase.name })),
    languages: [...new Set(items.map((i) => i.phrase.language).filter((l): l is string => !!l))],
  });
  while (answer) {
    const phrase = phraseFromClip(
      { name: answer.name, role: answer.role, language: answer.language, modelId: answer.modelId, sourceName: file.name },
      track,
      pcmAll,
      span,
      voiceRange.range,
    );
    try {
      await savePhrase(phrase, answer.keepVideo ? file : undefined);
      saveDialog.close();
      await library.refresh();
      ui.selectionHint.textContent = `Saved "${answer.name}" to the library.`;
      return;
    } catch (err) {
      answer = await saveDialog.showError(
        err instanceof LibraryFull
          ? "Couldn't save: this browser is out of storage space. Untick \"Keep video\", or remove videos or delete phrases in the library."
          : "Couldn't save to the library in this browser.",
      );
    }
  }
}

// ---- library (M1 spec §7) and practice (M2 spec) ----

const saveDialog = new SaveDialog();
const practiceView = new PracticeView({ saveDialog, refreshLibrary: () => library.refresh() });
const library = new LibraryPanel({
  open: (id) => void openPhrase(id),
  practice: (id) => void openPractice(id),
  changed: (items) => practiceView.setItems(items),
});
ui.practicePhrase.addEventListener('click', () => void practiceCurrentPhrase());
voiceRange.onEditing((r) => traceView.setRangeGuide(r), document.querySelector<HTMLElement>('#viewer .settings')!);

// ---- semitones and Hz explainer (pitch-axis spec §8) ----

const axisHelp = $<HTMLDialogElement>('axis-help');
function openAxisHelp(): void {
  // Worked example from what's on screen: the model in Practice, else the loaded clip.
  const typical = getStatus().kind === 'practice' ? practiceView.modelTypicalHz : traceView.typicalHz;
  const t = Number.isFinite(typical) ? typical : 200;
  const ex = $<HTMLDivElement>('axis-example');
  const rows: [string, number][] = [['+12 st (1 octave up)', 12], ['+6 st', 6], ['typical (0 st)', 0], ['−6 st', -6], ['−12 st (1 octave down)', -12]];
  const table = document.createElement('table');
  const cap = document.createElement('caption');
  cap.textContent = Number.isFinite(typical) ? `In this clip, typical = ${formatHz(t)}:` : `For example, if typical = ${formatHz(t)}:`;
  table.append(cap);
  for (const [label, st] of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.textContent = label;
    const b = document.createElement('td');
    b.textContent = formatHz(stToHz(st, t));
    tr.append(a, b);
    table.append(tr);
  }
  ex.replaceChildren(table);
  axisHelp.showModal();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.axis-help-button')) b.addEventListener('click', openAxisHelp);
document.addEventListener('open-axis-help', openAxisHelp);
$<HTMLButtonElement>('axis-help-close').addEventListener('click', () => axisHelp.close());

let libraryOk = true;
void libraryAvailable().then((ok) => {
  libraryOk = ok;
  if (ok) void library.refresh();
  else library.disable("The library isn't available in this browser window (private browsing or storage blocked).");
});

// Built-in samples (M1 spec §7.1): analyzed in the background; nothing shows if there are none.
void (async () => {
  const entries = await loadManifest();
  if (!entries.length) return;
  const ready: Phrase[] = [];
  let pending = entries.map((e) => ({ name: e.name, language: languageLabel(e.language) }));
  library.setSamples(ready, pending);
  if (!libraryOk) library.enableForSamples();
  for (const e of entries) {
    try {
      ready.push(await loadSample(e));
    } catch {
      // A missing or undecodable sample is skipped.
    }
    pending = pending.slice(1);
    library.setSamples([...ready], pending);
  }
})();

async function openPhrase(id: string): Promise<void> {
  if (getStatus().kind === 'practice') closePractice();
  if (isSampleId(id)) {
    const sp = library.allPhrases.find((i) => i.phrase.id === id)?.phrase;
    // Name the file after the sample so the player shows its name, keeping the original extension.
    const ext = /\.[^.]+$/.exec(sp?.sourceName ?? '')?.[0] ?? '';
    if (sp) await loadFile(new File([sp.audio], `${sp.name}${ext}`, { type: sp.audio.type }));
    return;
  }
  const p = await getPhrase(id);
  if (!p) return;
  const src = p.sourceId ? await getSource(p.sourceId) : undefined;
  if (src) {
    await loadFile(new File([src.blob], src.name, { type: src.type, lastModified: src.lastModified }));
    if (getStatus().kind !== 'ready') return;
    setSelection({ start: p.sourceStart, end: p.sourceStart + p.duration });
    seekTo(p.sourceStart);
  } else {
    await loadFile(new File([p.audio], `${p.name}.wav`, { type: 'audio/wav' }));
  }
}

async function openPractice(id: string): Promise<void> {
  player.pause();
  setStatus({ kind: 'practice' });
  await practiceView.openWithPhrase(id);
}

/** Practice the selected phrase (or the whole short clip) without saving it first. */
async function practiceCurrentPhrase(): Promise<void> {
  if (!currentPcm || !currentTrack || !currentFile) return;
  const span: Span | null = selection ?? (wholeClipSavable() ? { start: 0, end: currentTrack.duration } : null);
  if (!span) return;
  player.pause();
  setStatus({ kind: 'practice' });
  await practiceView.openWithUnsaved({
    file: currentFile,
    hasVideo: !ui.videoWrap.hidden,
    track: currentTrack,
    pcm: currentPcm,
    span,
    voiceRange: { ...voiceRange.range },
    name: selection ? `${baseName(currentFile.name)} ${formatTime(span.start)}` : baseName(currentFile.name),
  });
}

function closePractice(): void {
  practiceView.close();
  setStatus(currentTrack ? { kind: 'ready' } : { kind: 'empty' });
}
ui.closePractice.addEventListener('click', () => closePractice());

function syncPlayButton(): void {
  const playing = player.playing;
  ui.play.textContent = playing ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
for (const ev of ['play', 'pause', 'ended']) ui.media.addEventListener(ev, syncPlayButton);

function frame(): void {
  if (getStatus().kind === 'ready') {
    const t = scrubTime ?? player.time();
    if (scrubTime === null && player.playing) traceView.follow(t);
    traceView.drawPlayhead(t);
    seekBar.update(t);
    // A selected phrase plays to its end, then stops.
    if (selection && scrubTime === null && player.playing && t >= selection.end) player.pause();
  }
  if (getStatus().kind === 'practice') practiceView.tick();
  if (getStatus().kind === 'recording') recordingFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- keyboard (one global handler; spec §8) ----

document.addEventListener(
  'keydown',
  (e) => {
    const kind = getStatus().kind;
    if (kind !== 'ready' && kind !== 'practice') return;
    if (e.metaKey || e.ctrlKey || e.altKey || library.isOpen || document.querySelector('dialog[open]')) return;
    // Let menus and text/number boxes keep their own keys (typing, arrows, Space).
    if (ownsKeys(e.target)) return;
    if (kind === 'practice') {
      if (practiceView.handleKey(e)) e.preventDefault();
      return;
    }
    const now = player.time();
    const jump = e.shiftKey ? 10 : 2;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) togglePlay();
        break;
      case 'Escape':
        if (selection) setSelection(null);
        else if (selectMode) setSelectMode(false);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekTo(now - jump);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekTo(now + jump);
        break;
      case 'Home':
        e.preventDefault();
        seekTo(0);
        break;
      case 'End':
        e.preventDefault();
        seekTo(duration);
        break;
    }
  },
  { capture: true },
);

// A focused button activates on Space keyup; prevent it so Space never double-toggles.
document.addEventListener(
  'keyup',
  (e) => {
    if (library.isOpen || document.querySelector('dialog[open]')) return;
    const kind = getStatus().kind;
    if (e.key === ' ' && (kind === 'ready' || kind === 'practice') && !ownsKeys(e.target)) e.preventDefault();
  },
  { capture: true },
);

/** Elements that need their own keys: menus and any input except sliders. */
function ownsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return true;
  return target instanceof HTMLInputElement && target.type !== 'range';
}

// ---- status → UI ----

subscribe((s) => {
  ui.dropZone.hidden = s.kind !== 'empty';
  ui.progress.hidden = s.kind !== 'loading';
  ui.viewer.hidden = s.kind !== 'ready';
  ui.recorder.hidden = s.kind !== 'recording';
  ui.practice.hidden = s.kind !== 'practice';
  ui.openLibrary.hidden = s.kind === 'loading' || s.kind === 'recording';
  if (s.kind === 'ready') ui.fileName.textContent = currentName;
  else if (s.kind === 'empty' || s.kind === 'practice') ui.fileName.textContent = 'Intonation Tracer';
  const recPhase = s.kind === 'recording' ? s.phase : null;
  ui.micWait.hidden = recPhase === null || recPhase === 'live';
  ui.micWait.textContent =
    recPhase === 'ready'
      ? 'Microphone ready. Check the level meter, then press Start recording.'
      : 'Allow microphone access to continue…';
  ui.startRecording.hidden = recPhase !== 'ready';
  ui.stopRecording.hidden = recPhase !== 'live';
  ui.recDot.classList.toggle('live', recPhase === 'live');
  ui.actions.hidden = s.kind !== 'ready';

  ui.error.hidden = !(s.kind === 'empty' && s.error);
  ui.error.textContent = s.kind === 'empty' ? (s.error ?? '') : '';

  if (s.kind === 'loading') {
    ui.progressLabel.textContent = s.step === 'decoding' ? 'Decoding…' : 'Analyzing pitch…';
    if (s.step === 'decoding') ui.progressBar.removeAttribute('value'); // indeterminate
    else ui.progressBar.value = s.progress;
  }
  if (s.kind === 'ready') syncPlayButton();
});
