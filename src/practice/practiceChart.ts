// Practice chart (M2 spec §5 + pitch-axis spec): model (solid), current take (dashed),
// previous take (faint ghost) and the live line while recording. In semitones each line is
// relative to its own typical pitch; in Hz/Notes all lines share an absolute log-Hz axis.
// Also: a right-hand axis for the chosen speaker (Model/Me), typical-pitch tags, voice range
// guides while editing, a hover / touch-and-hold readout, and drag-to-shift for the take.

import { formatTime } from '../format.ts';
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
} from '../pitchAxis.ts';
import type { VoiceRange } from '../config.ts';
import { Readout } from '../readout.ts';

export type LayerKind = 'model' | 'take' | 'ghost' | 'live';
export type Speaker = 'model' | 'me';

export interface Layer {
  kind: LayerKind;
  f0: ArrayLike<number>;
  count?: number; // frames to draw (live layers grow); defaults to f0.length
  hopSeconds: number;
  frameCenterOffset: number;
  medianF0: number;
  duration: number;
  /** Aligned time = phrase time − offset. */
  offset: number;
}

const MARGIN = { left: 56, right: 56, top: 12, bottom: 28 };
const SLOP_PX = 4;

export class PracticeChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly readout: Readout;
  private layers: Layer[] = [];
  private range = 6;
  private hzLo = 75;
  private hzHi = 400;
  private unit: AxisUnit = 'st';
  private hzFor: Speaker = 'model';
  private guide: { range: VoiceRange; who: Speaker } | null = null;
  private x0 = 0;
  private x1 = 1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private playhead = NaN;
  private modelFaded = false;
  private countIn = '';
  private readoutX: number | null = null;
  private readoutY = 0;
  private pointerId: number | null = null;
  private dragStartX: number | null = null;
  private dragStartOffset = 0;
  private dragging = false;
  /** Called with the current take's new offset while dragging. */
  onShift: (offset: number) => void = () => {};

  constructor(wrap: HTMLElement, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.readout = new Readout(wrap);
    new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.width = r.width;
      this.height = r.height;
      canvas.width = Math.round(r.width * this.dpr);
      canvas.height = Math.round(r.height * this.dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      this.draw();
    }).observe(wrap);

    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', () => {
      this.readout.pointerUp();
      this.hideReadout();
      this.endDrag();
    });
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && this.pointerId === null) this.hideReadout();
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Replaces all layers and fits the axes to them. */
  setLayers(layers: Layer[]): void {
    this.layers = layers;
    this.fit();
  }

  /** Adds or replaces the live layer without refitting the axes (keeps them still while recording). */
  setLive(live: Layer | null): void {
    this.layers = this.layers.filter((l) => l.kind !== 'live');
    if (live) {
      this.layers.push(live);
      const end = this.frameTime(live, (live.count ?? live.f0.length) - 1) + 0.2;
      if (end > this.x1) this.x1 = end;
    }
    this.draw();
  }

  setUnit(unit: AxisUnit): void {
    this.unit = unit;
    this.fit();
  }

  /** Whose typical pitch the right-hand axis uses. */
  setHzFor(who: Speaker): void {
    this.hzFor = who;
    this.draw();
  }

  /** A voice range being edited (drawn in that speaker's color), or null. */
  setGuide(g: { range: VoiceRange; who: Speaker } | null): void {
    this.guide = g;
    this.draw();
  }

  setModelFaded(faded: boolean): void {
    this.modelFaded = faded;
    this.draw();
  }

  setCountIn(text: string): void {
    this.countIn = text;
    this.draw();
  }

  setPlayhead(t: number): void {
    this.playhead = t;
    this.draw();
  }

  private layer(kind: LayerKind): Layer | undefined {
    return this.layers.find((l) => l.kind === kind);
  }

  /** The speaker's typical pitch: the model's, or the current take's (live while recording). */
  private typicalOf(who: Speaker): number {
    const l = who === 'model' ? this.layer('model') : (this.layer('take') ?? this.layer('live'));
    return l?.medianF0 ?? NaN;
  }

  private frameTime(l: Layer, i: number): number {
    return l.frameCenterOffset + i * l.hopSeconds - l.offset;
  }

  private fit(): void {
    const fixed = this.layers.filter((l) => l.kind !== 'live');
    if (fixed.length) {
      this.x0 = Math.min(...fixed.map((l) => -l.offset)) - 0.1;
      this.x1 = Math.max(...fixed.map((l) => l.duration - l.offset)) + 0.1;
      const model = this.layer('model');
      if (model && fixed.length === 1) this.x1 = Math.max(this.x1, model.duration * 1.3 - model.offset);
    }
    const st: number[] = [];
    const hz: number[] = [];
    for (const l of fixed) {
      const n = l.count ?? l.f0.length;
      for (let i = 0; i < n; i++) {
        const f = l.f0[i];
        if (Number.isNaN(f)) continue;
        hz.push(f);
        st.push(hzToSt(f, l.medianF0));
      }
    }
    st.sort((a, b) => a - b);
    let extent = 6;
    if (st.length) {
      const p1 = st[Math.floor(st.length * 0.01)];
      const p99 = st[Math.min(st.length - 1, Math.floor(st.length * 0.99))];
      extent = Math.max(6, Math.ceil(Math.max(Math.abs(p1), Math.abs(p99)) / 3) * 3);
    }
    this.range = extent;
    [this.hzLo, this.hzHi] = hzDomain(hz);
    this.draw();
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.width) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.layers.length) return;
    const s = getComputedStyle(this.canvas);
    const color = (n: string) => s.getPropertyValue(n).trim();
    const right = this.width - MARGIN.right;
    const top = MARGIN.top;
    const bottom = this.height - MARGIN.bottom;
    const narrow = right - MARGIN.left < 360;
    const ref = this.typicalOf(this.hzFor);
    const refColor = this.hzFor === 'model' ? color('--trace') : color('--trace-b');

    // ---- y gridlines ----
    ctx.font = '12px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const gridLine = (y: number, strong: boolean, left: string, rightLabel: string) => {
      const yy = Math.round(y) + 0.5;
      ctx.strokeStyle = strong ? color('--grid-strong') : color('--grid');
      ctx.lineWidth = strong ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      ctx.fillStyle = color('--text-muted');
      ctx.textAlign = 'right';
      if (left) ctx.fillText(left, MARGIN.left - 8, yy);
      if (rightLabel) {
        ctx.fillStyle = refColor;
        ctx.textAlign = 'left';
        ctx.fillText(rightLabel, right + 6, yy);
      }
    };
    if (this.unit === 'st') {
      let k = 0;
      for (let st = -this.range; st <= this.range; st += 3, k++) {
        const major = st % 6 === 0;
        const left = major ? (st === 0 ? 'typical' : formatSt(st)) : '';
        const showRight = !Number.isNaN(ref) && major && (!narrow || st % 12 === 0);
        gridLine(this.stToY(st), st === 0, left, showRight ? formatHz(stToHz(st, ref)) : '');
      }
    } else {
      const ticks =
        this.unit === 'hz'
          ? hzTicks(this.hzLo, this.hzHi).map((hz) => ({ hz, label: `${Math.round(hz)} Hz` }))
          : noteTicks(this.hzLo, this.hzHi);
      ticks.forEach((t, k) => {
        const rightLabel =
          Number.isNaN(ref) || (narrow && k % 2) ? '' : this.unit === 'hz' ? formatSt(hzToSt(t.hz, ref)) : formatHz(t.hz);
        gridLine(this.hzToY(t.hz, NaN), false, t.label, rightLabel);
      });
    }

    // ---- time ticks ----
    const span = this.x1 - this.x0;
    const step = span > 12 ? 2 : span > 5 ? 1 : 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = color('--text-muted');
    for (let t = Math.ceil(this.x0 / step) * step; t <= this.x1 + 1e-9; t += step) {
      ctx.fillText(`${t.toFixed(step < 1 ? 1 : 0)} s`, this.tToX(t), bottom + 8);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, top, right - MARGIN.left, bottom - top);
    ctx.clip();

    // ---- range guide (behind the lines) ----
    if (this.guide) this.drawGuide(ctx, color);

    // ---- typical pitch: Hz/Notes get a dashed line per speaker ----
    if (this.unit !== 'st') {
      for (const who of ['model', 'me'] as const) {
        const t = this.typicalOf(who);
        if (Number.isNaN(t)) continue;
        const y = Math.round(this.hzToY(t, NaN)) + 0.5;
        ctx.strokeStyle = who === 'model' ? color('--trace') : color('--trace-b');
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(MARGIN.left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // ---- the lines ----
    for (const kind of ['ghost', 'model', 'take', 'live'] as LayerKind[]) {
      const l = this.layer(kind);
      if (!l) continue;
      ctx.globalAlpha = kind === 'ghost' ? 0.4 : kind === 'model' && this.modelFaded ? 0.35 : 1;
      this.drawLayer(
        ctx,
        l,
        kind === 'model' ? color('--trace') : color('--trace-b'),
        kind === 'model' ? [] : kind === 'ghost' ? [3, 5] : [7, 5],
        kind === 'ghost' ? 2 : 3,
      );
    }
    ctx.globalAlpha = 1;

    // ---- playhead ----
    if (!Number.isNaN(this.playhead)) {
      const x = Math.round(this.tToX(this.playhead)) + 0.5;
      ctx.strokeStyle = color('--playhead');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }

    // ---- readout guide line and dots ----
    if (this.readoutX !== null) {
      const x = Math.round(this.readoutX) + 0.5;
      ctx.strokeStyle = color('--text-muted');
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      const tau = this.xToT(this.readoutX);
      for (const kind of ['model', 'take'] as const) {
        const l = this.layer(kind);
        const f = l ? this.f0At(l, tau) : NaN;
        if (!l || Number.isNaN(f)) continue;
        ctx.fillStyle = kind === 'model' ? color('--trace') : color('--trace-b');
        ctx.strokeStyle = color('--surface');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.readoutX, this.hzToY(f, l.medianF0), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();

    // ---- typical-pitch tags (on top) ----
    const tags: [string, string, number][] = [];
    // On a narrow chart, side-by-side tags would run into the right-hand axis: shorten them.
    for (const who of ['model', 'me'] as const) {
      const t = this.typicalOf(who);
      if (Number.isNaN(t)) continue;
      const label = narrow
        ? `${who === 'model' ? 'Model' : 'You'} ${formatHz(t)}`
        : `${who === 'model' ? 'Model' : 'Your'} typical ${formatHz(t)}`;
      const y = this.unit === 'st' ? this.stToY(0) : this.hzToY(t, NaN);
      tags.push([label, who === 'model' ? color('--trace') : color('--trace-b'), y]);
    }
    let tx = MARGIN.left + 6;
    for (const [label, c, y] of tags) {
      // In semitones both sit on the same line, so put them side by side above it.
      const w = this.tag(ctx, label, tx, y - 11, c, color('--surface'));
      if (this.unit === 'st') tx += w + 6;
    }

    if (this.countIn) {
      ctx.fillStyle = color('--text');
      ctx.font = '600 72px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.countIn, (MARGIN.left + right) / 2, (top + bottom) / 2);
    }
  }

  private drawGuide(ctx: CanvasRenderingContext2D, color: (n: string) => string): void {
    const g = this.guide!;
    const typical = this.typicalOf(g.who);
    if (this.unit === 'st' && Number.isNaN(typical)) return; // no take yet to measure from
    const right = this.width - MARGIN.right;
    const top = MARGIN.top;
    const bottom = this.height - MARGIN.bottom;
    const c = g.who === 'model' ? color('--trace') : color('--trace-b');
    const place = (hz: number): { y: number; clamped: -1 | 0 | 1 } => {
      if (this.unit === 'st') {
        const p = guidePosition(hz, typical, this.range);
        return { y: this.stToY(p.st), clamped: p.clamped };
      }
      if (hz > this.hzHi) return { y: top, clamped: 1 };
      if (hz < this.hzLo) return { y: bottom, clamped: -1 };
      return { y: this.hzToY(hz, NaN), clamped: 0 };
    };
    const lo = place(g.range.minF0);
    const hi = place(g.range.maxF0);
    ctx.fillStyle = color('--guide-shade');
    if (hi.clamped !== 1) ctx.fillRect(MARGIN.left, top, right - MARGIN.left, hi.y - top);
    if (lo.clamped !== -1) ctx.fillRect(MARGIN.left, lo.y, right - MARGIN.left, bottom - lo.y);
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 5]);
    for (const [p, label, below] of [
      [hi, `max ${formatHz(g.range.maxF0)}`, true],
      [lo, `min ${formatHz(g.range.minF0)}`, false],
    ] as const) {
      const y = Math.round(p.y) + 0.5;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      const arrow = p.clamped === 1 ? ' ↑' : p.clamped === -1 ? ' ↓' : '';
      ctx.setLineDash([]);
      const w = this.measureTag(ctx, label + arrow);
      this.tag(ctx, label + arrow, right - 6 - w, below ? y + 11 : y - 11, c, color('--surface'));
      ctx.setLineDash([8, 5]);
    }
    ctx.setLineDash([]);
  }

  private measureTag(ctx: CanvasRenderingContext2D, text: string): number {
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.font = '12px system-ui, sans-serif';
    return w;
  }

  /** Text label with a background so it reads over lines. Returns its width. */
  private tag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, c: string, bg: string): number {
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = bg;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x, y - 9, w, 18);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 5, y);
    ctx.font = '12px system-ui, sans-serif';
    return w;
  }

  private drawLayer(ctx: CanvasRenderingContext2D, l: Layer, c: string, dash: number[], width: number): void {
    if (Number.isNaN(l.medianF0)) return;
    ctx.strokeStyle = c;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = dash.length ? 'butt' : 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    let pen = false;
    const n = l.count ?? l.f0.length;
    for (let i = 0; i < n; i++) {
      const f = l.f0[i];
      if (Number.isNaN(f)) {
        pen = false;
        continue;
      }
      const x = this.tToX(this.frameTime(l, i));
      const y = this.hzToY(f, l.medianF0);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private tToX(t: number): number {
    return MARGIN.left + ((t - this.x0) / (this.x1 - this.x0)) * (this.width - MARGIN.left - MARGIN.right);
  }

  private xToT(x: number): number {
    return this.x0 + ((x - MARGIN.left) / (this.width - MARGIN.left - MARGIN.right)) * (this.x1 - this.x0);
  }

  private stToY(st: number): number {
    const h = this.height - MARGIN.top - MARGIN.bottom;
    const c = Math.max(-this.range, Math.min(this.range, st)); // keep live outliers inside
    return MARGIN.top + ((this.range - c) / (2 * this.range)) * h;
  }

  /** y for a pitch: relative to `typical` in semitones, or absolute (log Hz) otherwise. */
  private hzToY(hz: number, typical: number): number {
    if (this.unit === 'st') return this.stToY(hzToSt(hz, typical));
    const h = this.height - MARGIN.top - MARGIN.bottom;
    const lo = Math.log(this.hzLo);
    const hi = Math.log(this.hzHi);
    const v = Math.max(lo, Math.min(hi, Math.log(hz)));
    return MARGIN.top + ((hi - v) / (hi - lo)) * h;
  }

  private f0At(l: Layer, tau: number): number {
    const i = Math.round((tau + l.offset - l.frameCenterOffset) / l.hopSeconds);
    const n = l.count ?? l.f0.length;
    return i >= 0 && i < n ? l.f0[i] : NaN;
  }

  // ---- readout ----

  private showReadoutAt(x: number, y: number): void {
    if (!this.layer('model')) return;
    this.readoutX = Math.min(Math.max(x, MARGIN.left), this.width - MARGIN.right);
    this.readoutY = y;
    const tau = this.xToT(this.readoutX);
    const s = getComputedStyle(this.canvas);
    const rows = (['model', 'take'] as const)
      .map((kind) => {
        const l = this.layer(kind);
        if (!l) return null;
        const f = this.f0At(l, tau);
        const who = kind === 'model' ? 'Model' : 'You';
        let text = `${who}: no voice here`;
        if (!Number.isNaN(f)) {
          const note = this.unit === 'notes' ? ` (${noteName(f)})` : '';
          text = `${who}  ${formatHz(f)}${note} · ${formatSt(hzToSt(f, l.medianF0))}`;
        }
        return { color: s.getPropertyValue(kind === 'model' ? '--trace' : '--trace-b').trim(), dashed: kind !== 'model', text };
      })
      .filter((r): r is NonNullable<typeof r> => !!r);
    this.readout.show(this.readoutX, this.readoutY, `${tau < 0 ? '−' : ''}${formatTime(Math.abs(tau))} from the first sound`, rows);
    this.draw();
  }

  private hideReadout(): void {
    if (this.readoutX === null) return;
    this.readoutX = null;
    this.readout.hide();
    this.draw();
  }

  // ---- pointer: drag shifts the take; hover / touch-and-hold reads ----

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.pointerId = e.pointerId;
    const p = this.local(e);
    const take = this.layer('take');
    this.dragStartX = take ? e.clientX : null;
    this.dragStartOffset = take?.offset ?? 0;
    this.dragging = false;
    this.canvas.setPointerCapture(e.pointerId);
    this.readout.pointerDown(e, p, () => this.showReadoutAt(p.x, p.y));
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (e.pointerId !== this.pointerId) {
      if (e.pointerType !== 'touch') this.showReadoutAt(p.x, p.y);
      return;
    }
    if (this.readout.holding) {
      this.showReadoutAt(p.x, p.y);
      return;
    }
    this.readout.pointerMove(e);
    if (this.readout.holdPending) return;
    const take = this.layer('take');
    if (this.dragStartX === null || !take) return;
    const dx = e.clientX - this.dragStartX;
    if (!this.dragging && Math.abs(dx) < SLOP_PX) return;
    this.dragging = true;
    this.hideReadout();
    const secondsPerPx = (this.x1 - this.x0) / (this.width - MARGIN.left - MARGIN.right);
    take.offset = this.dragStartOffset - dx * secondsPerPx; // right = later
    this.draw();
    this.onShift(take.offset);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.pointerId) return;
    if (this.readout.pointerUp()) this.readoutX = null;
    this.endDrag();
  }

  private endDrag(): void {
    if (this.pointerId !== null && this.canvas.hasPointerCapture(this.pointerId)) this.canvas.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    this.dragStartX = null;
    if (this.dragging) this.fit();
    this.dragging = false;
    this.draw();
  }
}
