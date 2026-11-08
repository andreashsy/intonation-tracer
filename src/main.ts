import { ANALYSIS, currentLimits } from './config.ts';
import { DecodeError, decodeToMono } from './decoder.ts';
import { looksLikeMedia, setupFileInput } from './fileInput.ts';
import { spokenTime } from './format.ts';
import { Player } from './player.ts';
import { SeekBar } from './seekBar.ts';
import { getStatus, setStatus, subscribe } from './state.ts';
import { TraceView } from './traceView.ts';
import type { PitchTrack, WorkerRequest, WorkerResponse } from './types.ts';

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
  audio: $<HTMLAudioElement>('audio'),
};

const player = new Player(ui.audio);
let scrubTime: number | null = null;

const traceView = new TraceView(ui.traceWrap, ui.traceCanvas, ui.overlayCanvas, {
  onSeek: (t) => seekTo(t),
  onScrub: (t) => {
    scrubTime = t;
  },
});
const seekBar = new SeekBar(ui.seek, ui.timeCurrent, ui.timeTotal, (t) => seekTo(t));

// ---- loading ----

let loadToken = 0;
let objectUrl: string | null = null;
let worker: Worker | null = null;
let pendingReject: ((err: Error) => void) | null = null;

class Cancelled extends Error {}

ui.limitText.textContent = currentLimits().label;

setupFileInput(ui.dropZone, ui.fileInput, (file) => void loadFile(file));
ui.loadAnother.addEventListener('click', () => ui.fileInput.click());
ui.cancel.addEventListener('click', () => cancelLoad());

async function loadFile(file: File): Promise<void> {
  const token = ++loadToken;
  stopWorker();
  resetMedia();

  const limits = currentLimits();
  if (!looksLikeMedia(file)) return fail("This file's format isn't supported. Try MP3, WAV, M4A or MP4.");
  if (file.size > limits.maxBytes) {
    return fail(`Please use a file under ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
  }

  ui.fileName.textContent = file.name;
  setStatus({ kind: 'loading', step: 'decoding', progress: 0 });

  try {
    // 1. Duration check before spending memory on a decode.
    objectUrl = URL.createObjectURL(file);
    const metaDuration = await player.load(objectUrl);
    if (token !== loadToken) return;
    if (Number.isFinite(metaDuration) && metaDuration > limits.maxSeconds) {
      return fail(`Please use a file under ${limits.label}.`);
    }

    // 2. Decode to 16 kHz mono.
    const pcm = await decodeToMono(file, ANALYSIS.sampleRate);
    if (token !== loadToken) return;
    if (pcm.length / ANALYSIS.sampleRate > limits.maxSeconds) {
      return fail(`Please use a file under ${limits.label}.`);
    }

    // 3. Analyze in the worker.
    setStatus({ kind: 'loading', step: 'analyzing', progress: 0 });
    const track = await analyzeInWorker(pcm, token, (p) => {
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

function analyzeInWorker(pcm: Float32Array, id: number, onProgress: (p: number) => void): Promise<PitchTrack> {
  worker ??= new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' });
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
    const req: WorkerRequest = { type: 'analyze', id, pcm, sampleRate: ANALYSIS.sampleRate };
    w.postMessage(req, [pcm.buffer]);
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
  scrubTime = null;
  traceView.clear();
}

function cancelLoad(): void {
  loadToken++;
  stopWorker();
  resetMedia();
  ui.fileName.textContent = 'Intonation Tracer';
  setStatus({ kind: 'empty' });
}

function fail(message: string): void {
  stopWorker();
  resetMedia();
  ui.fileName.textContent = 'Intonation Tracer';
  setStatus({ kind: 'empty', error: message });
}

let duration = 0;

function showTrack(name: string, track: PitchTrack): void {
  duration = Number.isFinite(player.duration) ? player.duration : track.duration;
  setStatus({ kind: 'ready' });
  traceView.setTrack(track);
  seekBar.setDuration(duration);
  ui.noVoice.hidden = !Number.isNaN(track.medianF0);
  ui.traceCanvas.setAttribute('aria-label', `Pitch trace of ${name}, ${spokenTime(duration)}`);
}

// ---- playback ----

function seekTo(t: number): void {
  player.seek(t);
  traceView.reveal(t);
}

ui.play.addEventListener('click', () => player.toggle());

function syncPlayButton(): void {
  const playing = player.playing;
  ui.play.textContent = playing ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}
for (const ev of ['play', 'pause', 'ended']) ui.audio.addEventListener(ev, syncPlayButton);

function frame(): void {
  if (getStatus().kind === 'ready') {
    const t = scrubTime ?? player.time();
    if (scrubTime === null && player.playing) traceView.follow(t);
    traceView.drawPlayhead(t);
    seekBar.update(t);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- keyboard (one global handler; spec §8) ----

document.addEventListener(
  'keydown',
  (e) => {
    if (getStatus().kind !== 'ready') return;
    if (e.target === ui.fileInput || e.metaKey || e.ctrlKey || e.altKey) return;
    const now = player.time();
    const jump = e.shiftKey ? 10 : 2;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!e.repeat) player.toggle();
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
    if (e.key === ' ' && getStatus().kind === 'ready') e.preventDefault();
  },
  { capture: true },
);

// ---- status → UI ----

subscribe((s) => {
  ui.dropZone.hidden = s.kind !== 'empty';
  ui.progress.hidden = s.kind !== 'loading';
  ui.viewer.hidden = s.kind !== 'ready';
  ui.loadAnother.hidden = s.kind !== 'ready';

  ui.error.hidden = !(s.kind === 'empty' && s.error);
  ui.error.textContent = s.kind === 'empty' ? (s.error ?? '') : '';

  if (s.kind === 'loading') {
    ui.progressLabel.textContent = s.step === 'decoding' ? 'Decoding…' : 'Analyzing pitch…';
    if (s.step === 'decoding') ui.progressBar.removeAttribute('value'); // indeterminate
    else ui.progressBar.value = s.progress;
  }
  if (s.kind === 'ready') syncPlayButton();
});
