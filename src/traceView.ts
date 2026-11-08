// Canvas drawing of the pitch trace, axes and playhead, plus click/drag to seek (spec §7, §8).
// Two stacked canvases: the trace layer redraws only on view/size changes;
// the overlay layer (playhead) redraws every animation frame.

import { TRACE_OFFSET_SECONDS, VIEW } from './config.ts';
import type { PitchTrack } from './types.ts';

const MARGIN = { left: 56, right: 12, top: 12, bottom: 28 };

export interface TraceViewCallbacks {
  /** Pointer released: seek to this time. */
  onSeek(t: number): void;
  /** Scrubbing preview time, or null when scrubbing ends. */
  onScrub(t: number | null): void;
}

interface Colors {
  trace: string;
  grid: string;
  zero: string;
  text: string;
  playhead: string;
}

export class TraceView {
  private readonly trace: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly cb: TraceViewCallbacks;
  private track: PitchTrack | null = null;
  private semis: Float32Array = new Float32Array(0);
  private range: number = VIEW.minSemitoneRange;
  private viewStart = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private colors: Colors | null = null;

  // Pointer state
  private pointerId: number | null = null;
  private downX = 0;
  private scrubbing = false;

  constructor(wrap: HTMLElement, trace: HTMLCanvasElement, overlay: HTMLCanvasElement, cb: TraceViewCallbacks) {
    this.trace = trace;
    this.overlay = overlay;
    this.cb = cb;

    new ResizeObserver(() => this.resize(wrap)).observe(wrap);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.colors = null;
      this.drawTrace();
    });

    overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    overlay.addEventListener('pointermove', (e) => this.onMove(e));
    overlay.addEventListener('pointerup', (e) => this.onUp(e));
    overlay.addEventListener('pointercancel', () => this.endPointer(true));
  }

  get windowSeconds(): number {
    return VIEW.windowSeconds;
  }

  get start(): number {
    return this.viewStart;
  }

  /** keepView: leave the visible window where it is (used when re-analyzing the same clip). */
  setTrack(track: PitchTrack, keepView = false): void {
    this.track = track;
    const n = track.f0.length;
    this.semis = new Float32Array(n);
    const voiced: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = track.f0[i];
      const st = Number.isNaN(f) ? NaN : 12 * Math.log2(f / track.medianF0);
      this.semis[i] = st;
      if (!Number.isNaN(st)) voiced.push(st);
    }
    // Widen past ±12 in 6-semitone steps if the 1st–99th percentile needs it.
    this.range = VIEW.minSemitoneRange;
    if (voiced.length) {
      voiced.sort((a, b) => a - b);
      const p1 = voiced[Math.floor(voiced.length * 0.01)];
      const p99 = voiced[Math.min(voiced.length - 1, Math.floor(voiced.length * 0.99))];
      const extent = Math.max(Math.abs(p1), Math.abs(p99));
      this.range = Math.max(VIEW.minSemitoneRange, Math.ceil(extent / VIEW.semitoneStep) * VIEW.semitoneStep);
    }
    if (!keepView) this.viewStart = 0;
    this.drawTrace();
  }

  clear(): void {
    this.track = null;
    this.semis = new Float32Array(0);
    this.drawTrace();
    this.drawPlayhead(NaN);
  }

  /** Sets the left edge of the visible window (clamped). Returns true if it changed. */
  setViewStart(start: number): boolean {
    const duration = this.track?.duration ?? 0;
    const max = Math.max(0, duration - VIEW.windowSeconds);
    const clamped = Math.min(Math.max(0, start), max);
    if (Math.abs(clamped - this.viewStart) < 1e-6) return false;
    this.viewStart = clamped;
    this.drawTrace();
    return true;
  }

  /** Keeps a playing playhead in view: past 75% → move it back to 25%. */
  follow(t: number): void {
    const span = VIEW.windowSeconds;
    if (t > this.viewStart + VIEW.scrollTrigger * span || t < this.viewStart) {
      this.setViewStart(t - VIEW.scrollTarget * span);
    }
  }

  /** After a seek: move the view only if t is off screen. */
  reveal(t: number): void {
    const span = VIEW.windowSeconds;
    if (t < this.viewStart || t > this.viewStart + span) this.setViewStart(t - VIEW.scrollTarget * span);
  }

  drawPlayhead(t: number): void {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.track || Number.isNaN(t)) return;
    const x = this.timeToX(t);
    if (x < MARGIN.left - 1 || x > this.width - MARGIN.right + 1) return;
    const c = this.getColors();
    ctx.strokeStyle = c.playhead;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, MARGIN.top);
    ctx.lineTo(Math.round(x) + 0.5, this.height - MARGIN.bottom);
    ctx.stroke();
  }

  // ---- drawing ----

  private resize(wrap: HTMLElement): void {
    const rect = wrap.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    for (const c of [this.trace, this.overlay]) {
      c.width = Math.round(rect.width * this.dpr);
      c.height = Math.round(rect.height * this.dpr);
      c.style.width = `${rect.width}px`;
      c.style.height = `${rect.height}px`;
    }
    this.drawTrace();
  }

  private drawTrace(): void {
    const ctx = this.trace.getContext('2d');
    if (!ctx || !this.width) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.track) return;

    const c = this.getColors();
    const plotRight = this.width - MARGIN.right;
    const plotBottom = this.height - MARGIN.bottom;

    // Semitone grid and labels.
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let st = -this.range; st <= this.range; st += VIEW.semitoneStep) {
      const y = Math.round(this.stToY(st)) + 0.5;
      ctx.strokeStyle = st === 0 ? c.zero : c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      ctx.fillStyle = c.text;
      const label = st === 0 ? '0 st' : `${st > 0 ? '+' : '−'}${Math.abs(st)} st`;
      ctx.fillText(label, MARGIN.left - 8, y);
    }

    // Time ticks: every second, or every 2 s when cramped.
    const pxPerSec = (plotRight - MARGIN.left) / VIEW.windowSeconds;
    const step = pxPerSec < 50 ? 2 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const first = Math.ceil(this.viewStart / step) * step;
    for (let t = first; t <= this.viewStart + VIEW.windowSeconds + 1e-6; t += step) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 4);
      ctx.stroke();
      ctx.fillStyle = c.text;
      const m = Math.floor(t / 60);
      const s = Math.round(t - m * 60);
      // Keep the label inside the canvas at the right edge.
      ctx.textAlign = x + 18 > this.width ? 'right' : 'center';
      ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, ctx.textAlign === 'right' ? this.width - 2 : x, plotBottom + 8);
    }

    // The trace: connected segments, broken at unvoiced frames.
    const { hopSeconds, frameCenterOffset } = this.track;
    const t0 = frameCenterOffset + TRACE_OFFSET_SECONDS;
    const firstFrame = Math.max(0, Math.floor((this.viewStart - t0) / hopSeconds) - 1);
    const lastFrame = Math.min(
      this.semis.length - 1,
      Math.ceil((this.viewStart + VIEW.windowSeconds - t0) / hopSeconds) + 1,
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, plotRight - MARGIN.left, plotBottom - MARGIN.top);
    ctx.clip();
    ctx.strokeStyle = c.trace;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let penDown = false;
    for (let i = firstFrame; i <= lastFrame; i++) {
      const st = this.semis[i];
      if (Number.isNaN(st)) {
        penDown = false;
        continue;
      }
      const x = this.timeToX(t0 + i * hopSeconds);
      const y = this.stToY(st);
      if (penDown) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
    }
    ctx.stroke();
    ctx.restore();
  }

  private getColors(): Colors {
    if (!this.colors) {
      const s = getComputedStyle(this.trace);
      const v = (name: string) => s.getPropertyValue(name).trim();
      this.colors = {
        trace: v('--trace'),
        grid: v('--grid'),
        zero: v('--grid-strong'),
        text: v('--text-muted'),
        playhead: v('--playhead'),
      };
    }
    return this.colors;
  }

  private timeToX(t: number): number {
    const w = this.width - MARGIN.left - MARGIN.right;
    return MARGIN.left + ((t - this.viewStart) / VIEW.windowSeconds) * w;
  }

  private xToTime(x: number): number {
    const w = this.width - MARGIN.left - MARGIN.right;
    const t = this.viewStart + ((x - MARGIN.left) / w) * VIEW.windowSeconds;
    return Math.min(Math.max(0, t), this.track?.duration ?? 0);
  }

  private stToY(st: number): number {
    const h = this.height - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + ((this.range - st) / (2 * this.range)) * h;
  }

  // ---- pointer: click (< 4 px) seeks; drag scrubs and seeks on release ----

  private localX(e: PointerEvent): number {
    return e.clientX - this.overlay.getBoundingClientRect().left;
  }

  private onDown(e: PointerEvent): void {
    if (!this.track || e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.downX = e.clientX;
    this.scrubbing = false;
    this.overlay.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    if (!this.scrubbing && Math.abs(e.clientX - this.downX) >= VIEW.clickSlopPx) this.scrubbing = true;
    if (this.scrubbing) this.cb.onScrub(this.xToTime(this.localX(e)));
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    const t = this.xToTime(this.localX(e));
    this.endPointer(false);
    this.cb.onSeek(t);
  }

  private endPointer(cancelled: boolean): void {
    if (this.pointerId !== null && this.overlay.hasPointerCapture(this.pointerId)) {
      this.overlay.releasePointerCapture(this.pointerId);
    }
    const wasScrubbing = this.scrubbing;
    this.pointerId = null;
    this.scrubbing = false;
    if (wasScrubbing || cancelled) this.cb.onScrub(null);
  }
}
