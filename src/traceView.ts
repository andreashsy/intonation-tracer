// Canvas drawing of the pitch trace, axes and playhead, plus click/drag to seek (M0 spec §7, §8),
// phrase selection (M1 §4), and the semitone/Hz aids (pitch-axis spec): unit modes, a right-hand
// axis in the other unit, a labelled typical-pitch line, voice range guides, and the readout.
// Two stacked canvases: the trace layer redraws only on view/size changes; the overlay layer
// (playhead and readout guide) redraws every animation frame.

import { TRACE_OFFSET_SECONDS, VIEW, type VoiceRange } from './config.ts';
import { formatTime } from './format.ts';
import { normalizeSpan, type Span } from './phrases.ts';
import {
  type AxisUnit,
  formatHz,
  formatSt,
  guidePosition,
  hzDomain,
  hzTicks,
  hzToSt,
  noteName,
  noteTicks,
  stToHz,
} from './pitchAxis.ts';
import { Readout } from './readout.ts';
import type { PitchTrack } from './types.ts';

const MARGIN = { left: 56, right: 56, top: 12, bottom: 28 };
const EDGE_GRAB_PX = 8;
/** A clip shorter than this still gets this much width (so a tiny clip isn't stretched absurdly). */
const MIN_WINDOW_SECONDS = 1;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10];
const MIN_TICK_PX = 80;

export interface TraceViewCallbacks {
  /** Pointer released: seek to this time. */
  onSeek(t: number): void;
  /** Scrubbing preview time, or null when scrubbing ends. */
  onScrub(t: number | null): void;
  /** Select mode: the selection changed (null = cleared). `final` is true on pointer release. */
  onSelect(span: Span | null, final: boolean): void;
  /** Select mode: a click (no drag) at this time. */
  onPick(t: number): void;
}

interface Colors {
  trace: string;
  select: string;
  band: string;
  grid: string;
  zero: string;
  text: string;
  playhead: string;
  shade: string;
}

export class TraceView {
  private readonly trace: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly cb: TraceViewCallbacks;
  private readonly readout: Readout;
  private track: PitchTrack | null = null;
  private range: number = VIEW.minSemitoneRange; // ± semitones shown in 'st' mode
  private hzLo = 75; // log-Hz domain in 'hz'/'notes' modes
  private hzHi = 400;
  private unit: AxisUnit = 'st';
  private guide: VoiceRange | null = null;
  private viewStart = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private colors: Colors | null = null;
  private mode: 'seek' | 'select' = 'seek';
  private selection: Span | null = null;
  private bands: Span[] = [];
  /** Readout position in canvas pixels, or null when hidden. */
  private readoutX: number | null = null;
  private readoutY = 0;

  // Pointer state
  private pointerId: number | null = null;
  private downX = 0;
  private scrubbing = false;
  /** Select-mode drag: the fixed end of the selection being made. */
  private anchor: number | null = null;

  constructor(wrap: HTMLElement, trace: HTMLCanvasElement, overlay: HTMLCanvasElement, cb: TraceViewCallbacks) {
    this.trace = trace;
    this.overlay = overlay;
    this.cb = cb;
    this.readout = new Readout(wrap);

    new ResizeObserver(() => this.resize(wrap)).observe(wrap);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.colors = null;
      this.drawTrace();
    });

    overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    overlay.addEventListener('pointermove', (e) => this.onMove(e));
    overlay.addEventListener('pointerup', (e) => this.onUp(e));
    overlay.addEventListener('pointercancel', () => {
      this.readout.pointerUp();
      this.hideReadout();
      this.endPointer(true);
    });
    overlay.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && this.pointerId === null) this.hideReadout();
    });
    // Long-press on touch would otherwise open the browser's context menu.
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /**
   * Seconds shown across the chart: the whole clip when it's shorter than the usual
   * window (so a 1.5 s phrase fills the width instead of sitting at the left), but at
   * least 1 s.
   */
  get windowSeconds(): number {
    const d = this.track?.duration ?? 0;
    return d > 0 ? Math.min(VIEW.windowSeconds, Math.max(MIN_WINDOW_SECONDS, d)) : VIEW.windowSeconds;
  }

  get start(): number {
    return this.viewStart;
  }

  /** The clip's typical (median) pitch in Hz, or NaN. */
  get typicalHz(): number {
    return this.track?.medianF0 ?? NaN;
  }

  setUnit(unit: AxisUnit): void {
    this.unit = unit;
    this.drawTrace();
  }

  /** Voice range limits to draw while the range control is being edited (null hides them). */
  setRangeGuide(range: VoiceRange | null): void {
    this.guide = range;
    this.drawTrace();
  }

  /** 'select': click picks a phrase, drag selects a span. 'seek': click/drag seek. */
  setMode(mode: 'seek' | 'select'): void {
    this.mode = mode;
    this.overlay.classList.toggle('selecting', mode === 'select');
    this.drawTrace();
  }

  /** Detected phrases, shown as faint bands in select mode. */
  setBands(bands: Span[]): void {
    this.bands = bands;
    this.drawTrace();
  }

  setSelection(span: Span | null): void {
    this.selection = span;
    this.drawTrace();
  }

  /** keepView: leave the visible window where it is (used when re-analyzing the same clip). */
  setTrack(track: PitchTrack, keepView = false): void {
    this.track = track;
    const voicedSt: number[] = [];
    const voicedHz: number[] = [];
    for (const f of track.f0) {
      if (Number.isNaN(f)) continue;
      voicedHz.push(f);
      voicedSt.push(hzToSt(f, track.medianF0));
    }
    // Widen past ±12 in 6-semitone steps if the 1st–99th percentile needs it.
    this.range = VIEW.minSemitoneRange;
    if (voicedSt.length) {
      voicedSt.sort((a, b) => a - b);
      const p1 = voicedSt[Math.floor(voicedSt.length * 0.01)];
      const p99 = voicedSt[Math.min(voicedSt.length - 1, Math.floor(voicedSt.length * 0.99))];
      const extent = Math.max(Math.abs(p1), Math.abs(p99));
      this.range = Math.max(VIEW.minSemitoneRange, Math.ceil(extent / VIEW.semitoneStep) * VIEW.semitoneStep);
    }
    [this.hzLo, this.hzHi] = hzDomain(voicedHz);
    if (!keepView) this.viewStart = 0;
    this.drawTrace();
  }

  clear(): void {
    this.track = null;
    this.selection = null;
    this.bands = [];
    this.hideReadout();
    this.drawTrace();
    this.drawPlayhead(NaN);
  }

  /** Sets the left edge of the visible window (clamped). Returns true if it changed. */
  setViewStart(start: number): boolean {
    const duration = this.track?.duration ?? 0;
    const max = Math.max(0, duration - this.windowSeconds);
    const clamped = Math.min(Math.max(0, start), max);
    if (Math.abs(clamped - this.viewStart) < 1e-6) return false;
    this.viewStart = clamped;
    this.drawTrace();
    if (this.readoutX !== null) this.updateReadout();
    return true;
  }

  /** Keeps a playing playhead in view: past 75% → move it back to 25%. */
  follow(t: number): void {
    const span = this.windowSeconds;
    if (t > this.viewStart + VIEW.scrollTrigger * span || t < this.viewStart) {
      this.setViewStart(t - VIEW.scrollTarget * span);
    }
  }

  /** After a seek: move the view only if t is off screen. */
  reveal(t: number): void {
    const span = this.windowSeconds;
    if (t < this.viewStart || t > this.viewStart + span) this.setViewStart(t - VIEW.scrollTarget * span);
  }

  /** Draws the playhead and, if active, the readout guide line and dot. Called every frame. */
  drawPlayhead(t: number): void {
    const ctx = this.overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.track) return;
    const c = this.getColors();
    const right = this.width - MARGIN.right;
    if (!Number.isNaN(t)) {
      const x = this.timeToX(t);
      if (x >= MARGIN.left - 1 && x <= right + 1) {
        ctx.strokeStyle = c.playhead;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, MARGIN.top);
        ctx.lineTo(Math.round(x) + 0.5, this.height - MARGIN.bottom);
        ctx.stroke();
      }
    }
    if (this.readoutX !== null) {
      const x = Math.round(this.readoutX) + 0.5;
      ctx.strokeStyle = c.text;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, MARGIN.top);
      ctx.lineTo(x, this.height - MARGIN.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const f = this.f0At(this.xToTime(this.readoutX));
      if (!Number.isNaN(f)) {
        ctx.fillStyle = c.trace;
        ctx.strokeStyle = getComputedStyle(this.trace).getPropertyValue('--surface').trim() || '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.readoutX, this.hzToY(f), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
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
    const plotTop = MARGIN.top;
    const plotBottom = this.height - MARGIN.bottom;
    const typical = this.track.medianF0;
    const hasTypical = !Number.isNaN(typical);
    const narrow = plotRight - MARGIN.left < 360;

    // ---- y gridlines: left labels in the chosen unit, right labels in the other ----
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const gridLine = (y: number, strong: boolean, left: string, right: string) => {
      const yy = Math.round(y) + 0.5;
      ctx.strokeStyle = strong ? c.zero : c.grid;
      ctx.lineWidth = strong ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, yy);
      ctx.lineTo(plotRight, yy);
      ctx.stroke();
      ctx.fillStyle = c.text;
      ctx.textAlign = 'right';
      ctx.fillText(left, MARGIN.left - 8, yy);
      if (right) {
        ctx.textAlign = 'left';
        ctx.fillText(right, plotRight + 6, yy);
      }
    };
    if (this.unit === 'st') {
      let k = 0;
      for (let st = -this.range; st <= this.range; st += VIEW.semitoneStep, k++) {
        const showRight = hasTypical && (!narrow || k % 2 === 0 || st === 0);
        gridLine(this.stToY(st), st === 0, st === 0 ? 'typical' : formatSt(st), showRight ? formatHz(stToHz(st, typical)) : '');
      }
    } else {
      const ticks =
        this.unit === 'hz'
          ? hzTicks(this.hzLo, this.hzHi).map((hz) => ({ hz, label: formatHz(hz).replace(' Hz', '') }))
          : noteTicks(this.hzLo, this.hzHi);
      ticks.forEach((t, k) => {
        const right = !hasTypical || (narrow && k % 2) ? '' : this.unit === 'hz' ? formatSt(hzToSt(t.hz, typical)) : formatHz(t.hz);
        gridLine(this.hzToY(t.hz), false, this.unit === 'hz' ? `${t.label} Hz` : t.label, right);
      });
      // Typical pitch as its own dashed, labelled line.
      if (hasTypical) {
        const y = Math.round(this.hzToY(typical)) + 0.5;
        ctx.strokeStyle = c.trace;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(MARGIN.left, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        this.tag(ctx, `typical ${formatHz(typical)}`, MARGIN.left + 6, y - 9, c.trace);
      }
    }

    // ---- time ticks: the smallest round step that leaves room for the labels ----
    const pxPerSec = (plotRight - MARGIN.left) / this.windowSeconds;
    const step = TICK_STEPS.find((st) => st * pxPerSec >= MIN_TICK_PX) ?? 10;
    ctx.textBaseline = 'top';
    const firstK = Math.ceil(this.viewStart / step - 1e-6);
    const lastK = Math.floor((this.viewStart + this.windowSeconds) / step + 1e-6);
    for (let k = firstK; k <= lastK; k++) {
      const t = k * step;
      const x = Math.round(this.timeToX(t)) + 0.5;
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotBottom);
      ctx.lineTo(x, plotBottom + 4);
      ctx.stroke();
      ctx.fillStyle = c.text;
      const m = Math.floor(t / 60);
      const s = Math.round(t - m * 60);
      ctx.textAlign = 'center';
      // Sub-second steps need tenths ("0:00.5"); whole seconds stay short ("0:01").
      ctx.fillText(step < 1 ? formatTime(t) : `${m}:${String(s).padStart(2, '0')}`, x, plotBottom + 8);
    }

    // ---- phrase bands (select mode) and the selection, behind the trace ----
    const shade = (span: Span, color: string) => {
      const x0 = Math.max(MARGIN.left, this.timeToX(span.start));
      const x1 = Math.min(plotRight, this.timeToX(span.end));
      if (x1 <= x0) return;
      ctx.fillStyle = color;
      ctx.fillRect(x0, plotTop, x1 - x0, plotBottom - plotTop);
    };
    if (this.mode === 'select') for (const b of this.bands) shade(b, c.band);
    if (this.selection) {
      shade(this.selection, c.select);
      ctx.strokeStyle = c.trace;
      ctx.lineWidth = 2;
      for (const edge of [this.selection.start, this.selection.end]) {
        const x = this.timeToX(edge);
        if (x < MARGIN.left || x > plotRight) continue;
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
        ctx.fillStyle = c.trace;
        ctx.fillRect(x - 4, plotTop + (plotBottom - plotTop) / 2 - 12, 8, 24);
      }
    }

    // ---- voice range guides while the range is being edited ----
    if (this.guide && (hasTypical || this.unit !== 'st')) this.drawGuide(ctx, this.guide, c);

    // ---- the trace: connected segments, broken at unvoiced frames ----
    const { hopSeconds, frameCenterOffset } = this.track;
    const t0 = frameCenterOffset + TRACE_OFFSET_SECONDS;
    const firstFrame = Math.max(0, Math.floor((this.viewStart - t0) / hopSeconds) - 1);
    const lastFrame = Math.min(this.track.f0.length - 1, Math.ceil((this.viewStart + this.windowSeconds - t0) / hopSeconds) + 1);
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, plotTop, plotRight - MARGIN.left, plotBottom - plotTop);
    ctx.clip();
    ctx.strokeStyle = c.trace;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let penDown = false;
    for (let i = firstFrame; i <= lastFrame; i++) {
      const f = this.track.f0[i];
      if (Number.isNaN(f)) {
        penDown = false;
        continue;
      }
      const x = this.timeToX(t0 + i * hopSeconds);
      const y = this.hzToY(f);
      if (penDown) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Min/max of a voice range as dashed lines, with the area outside lightly shaded. */
  private drawGuide(ctx: CanvasRenderingContext2D, r: VoiceRange, c: Colors): void {
    const plotRight = this.width - MARGIN.right;
    const top = MARGIN.top;
    const bottom = this.height - MARGIN.bottom;
    const place = (hz: number): { y: number; clamped: -1 | 0 | 1 } => {
      if (this.unit === 'st') {
        const g = guidePosition(hz, this.track!.medianF0, this.range);
        return { y: this.stToY(g.st), clamped: g.clamped };
      }
      if (hz > this.hzHi) return { y: top, clamped: 1 };
      if (hz < this.hzLo) return { y: bottom, clamped: -1 };
      return { y: this.hzToY(hz), clamped: 0 };
    };
    const lo = place(r.minF0);
    const hi = place(r.maxF0);
    ctx.fillStyle = c.shade;
    if (hi.clamped !== 1) ctx.fillRect(MARGIN.left, top, plotRight - MARGIN.left, hi.y - top);
    if (lo.clamped !== -1) ctx.fillRect(MARGIN.left, lo.y, plotRight - MARGIN.left, bottom - lo.y);
    ctx.strokeStyle = c.trace;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 5]);
    for (const [p, label] of [
      [hi, `max ${formatHz(r.maxF0)}`],
      [lo, `min ${formatHz(r.minF0)}`],
    ] as const) {
      const y = Math.round(p.y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();
      const arrow = p.clamped === 1 ? ' ↑' : p.clamped === -1 ? ' ↓' : '';
      // Label just inside the kept area.
      this.tag(ctx, label + arrow, plotRight - 6, p === hi ? y + 10 : y - 10, c.trace, 'right');
    }
    ctx.setLineDash([]);
  }

  /** Small text label with a background, so it reads over gridlines. */
  private tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, align: 'left' | 'right' = 'left'): void {
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    const left = align === 'left' ? x : x - w;
    ctx.fillStyle = getComputedStyle(this.trace).getPropertyValue('--surface').trim() || '#fff';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(left, y - 9, w, 18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 5, y);
    ctx.font = '12px system-ui, sans-serif';
  }

  private getColors(): Colors {
    if (!this.colors) {
      const s = getComputedStyle(this.trace);
      const v = (name: string) => s.getPropertyValue(name).trim();
      this.colors = {
        trace: v('--trace'),
        select: v('--select'),
        band: v('--band'),
        grid: v('--grid'),
        zero: v('--grid-strong'),
        text: v('--text-muted'),
        playhead: v('--playhead'),
        shade: v('--guide-shade'),
      };
    }
    return this.colors;
  }

  private timeToX(t: number): number {
    const w = this.width - MARGIN.left - MARGIN.right;
    return MARGIN.left + ((t - this.viewStart) / this.windowSeconds) * w;
  }

  private xToTime(x: number): number {
    const w = this.width - MARGIN.left - MARGIN.right;
    const t = this.viewStart + ((x - MARGIN.left) / w) * this.windowSeconds;
    return Math.min(Math.max(0, t), this.track?.duration ?? 0);
  }

  private stToY(st: number): number {
    const h = this.height - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + ((this.range - st) / (2 * this.range)) * h;
  }

  /** y for a pitch in Hz, in the current unit. */
  private hzToY(hz: number): number {
    if (this.unit === 'st') return this.stToY(hzToSt(hz, this.track?.medianF0 ?? hz));
    const h = this.height - MARGIN.top - MARGIN.bottom;
    const lo = Math.log(this.hzLo);
    const hi = Math.log(this.hzHi);
    return MARGIN.top + ((hi - Math.log(hz)) / (hi - lo)) * h;
  }

  private f0At(t: number): number {
    if (!this.track) return NaN;
    const i = Math.round((t - this.track.frameCenterOffset - TRACE_OFFSET_SECONDS) / this.track.hopSeconds);
    return i >= 0 && i < this.track.f0.length ? this.track.f0[i] : NaN;
  }

  // ---- readout (pitch-axis spec §7) ----

  private showReadoutAt(x: number, y: number): void {
    if (!this.track) return;
    this.readoutX = Math.min(Math.max(x, MARGIN.left), this.width - MARGIN.right);
    this.readoutY = y;
    this.updateReadout();
  }

  private updateReadout(): void {
    if (this.readoutX === null || !this.track) return;
    const t = this.xToTime(this.readoutX);
    const f = this.f0At(t);
    const typical = this.track.medianF0;
    let text = 'no voice here';
    if (!Number.isNaN(f)) {
      const st = hzToSt(f, typical);
      text = `${formatHz(f)} · ${formatSt(st)} ${st >= 0 ? 'above' : 'below'} typical`;
      if (this.unit === 'notes') text = `${formatHz(f)} (${noteName(f)}) · ${formatSt(st)}`;
    }
    this.readout.show(this.readoutX, this.readoutY, `${formatTime(t)} · typical ${formatHz(typical)}`, [
      { color: this.getColors().trace, dashed: false, text },
    ]);
  }

  private hideReadout(): void {
    this.readoutX = null;
    this.readout.hide();
  }

  // ---- pointer: click (< 4 px) seeks; drag scrubs and seeks on release; hold reads ----

  private localPoint(e: PointerEvent): { x: number; y: number } {
    const r = this.overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    if (!this.track || e.button !== 0) return;
    this.pointerId = e.pointerId;
    this.downX = e.clientX;
    this.scrubbing = false;
    this.anchor = null;
    if (this.mode === 'select') {
      const { x } = this.localPoint(e);
      const sel = this.selection;
      // Grabbing an edge moves that edge; the other one stays put.
      if (sel && Math.abs(x - this.timeToX(sel.start)) <= EDGE_GRAB_PX) this.anchor = sel.end;
      else if (sel && Math.abs(x - this.timeToX(sel.end)) <= EDGE_GRAB_PX) this.anchor = sel.start;
      else this.anchor = this.xToTime(x);
    }
    this.overlay.setPointerCapture(e.pointerId);
    const p = this.localPoint(e);
    this.readout.pointerDown(e, p, () => this.showReadoutAt(p.x, p.y));
  }

  private onMove(e: PointerEvent): void {
    const p = this.localPoint(e);
    if (e.pointerId !== this.pointerId) {
      // Hover (mouse/pen with no button down): readout and edge cursor.
      if (e.pointerType !== 'touch') this.showReadoutAt(p.x, p.y);
      this.hoverCursor(e);
      return;
    }
    if (this.readout.holding) {
      this.showReadoutAt(p.x, p.y);
      return;
    }
    this.readout.pointerMove(e);
    if (this.readout.holdPending) return; // still deciding between hold and drag
    if (e.pointerType !== 'touch') this.hideReadout();
    if (!this.scrubbing && Math.abs(e.clientX - this.downX) >= VIEW.clickSlopPx) this.scrubbing = true;
    if (!this.scrubbing) return;
    const t = this.xToTime(p.x);
    if (this.mode === 'select' && this.anchor !== null) {
      this.selection = normalizeSpan(this.anchor, t, this.track?.duration ?? 0);
      this.drawTrace();
      this.cb.onSelect(this.selection, false);
    } else {
      this.cb.onScrub(t);
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    if (this.readout.pointerUp()) {
      // A touch-and-hold readout: don't seek or select.
      this.readoutX = null;
      this.endPointer(false);
      return;
    }
    const t = this.xToTime(this.localPoint(e).x);
    const dragged = this.scrubbing;
    const selecting = this.mode === 'select';
    this.endPointer(false);
    if (!selecting) this.cb.onSeek(t);
    else if (dragged) this.cb.onSelect(this.selection, true);
    else this.cb.onPick(t);
  }

  private hoverCursor(e: PointerEvent): void {
    if (this.mode !== 'select' || !this.selection) {
      this.overlay.style.cursor = '';
      return;
    }
    const { x } = this.localPoint(e);
    const near = [this.selection.start, this.selection.end].some((t) => Math.abs(x - this.timeToX(t)) <= EDGE_GRAB_PX);
    this.overlay.style.cursor = near ? 'ew-resize' : '';
  }

  private endPointer(cancelled: boolean): void {
    if (this.pointerId !== null && this.overlay.hasPointerCapture(this.pointerId)) {
      this.overlay.releasePointerCapture(this.pointerId);
    }
    const wasScrubbing = this.scrubbing;
    this.pointerId = null;
    this.scrubbing = false;
    this.anchor = null;
    if (this.mode === 'seek' && (wasScrubbing || cancelled)) this.cb.onScrub(null);
  }
}
