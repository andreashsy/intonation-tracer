// Overlay chart for Compare (M1 spec §8): A solid, B dashed, both in semitones relative to
// their own median, on a shared aligned-time axis. Dragging sideways nudges B.

import { toSemitones } from '../phrases.ts';

export interface ChartTrace {
  f0: Float32Array;
  hopSeconds: number;
  frameCenterOffset: number;
  medianF0: number;
  duration: number;
  /** Shift applied when drawing: aligned time = phrase time − offset. */
  offset: number;
}

const MARGIN = { left: 56, right: 12, top: 12, bottom: 28 };
const SLOP_PX = 4;

export class CompareChart {
  private readonly canvas: HTMLCanvasElement;
  private a: ChartTrace | null = null;
  private b: ChartTrace | null = null;
  private stA: Float32Array = new Float32Array(0);
  private stB: Float32Array = new Float32Array(0);
  private range = 6;
  private x0 = 0;
  private x1 = 1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private playhead = NaN;
  private dragStartX: number | null = null;
  private dragStartOffset = 0;
  private dragging = false;
  /** Called with B's new offset while dragging. */
  onNudge: (offsetB: number) => void = () => {};

  constructor(wrap: HTMLElement, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
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

    canvas.addEventListener('pointerdown', (e) => {
      if (!this.b || e.button !== 0) return;
      this.dragStartX = e.clientX;
      this.dragStartOffset = this.b.offset;
      this.dragging = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragStartX === null || !this.b) return;
      const dx = e.clientX - this.dragStartX;
      if (!this.dragging && Math.abs(dx) < SLOP_PX) return;
      this.dragging = true;
      const secondsPerPx = (this.x1 - this.x0) / (this.width - MARGIN.left - MARGIN.right);
      // Dragging right moves B later, i.e. a smaller offset.
      this.b.offset = this.dragStartOffset - dx * secondsPerPx;
      this.draw(false);
      this.onNudge(this.b.offset);
    });
    const end = () => {
      this.dragStartX = null;
      if (this.dragging) this.draw(); // recompute the x domain after the drag
      this.dragging = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  set(a: ChartTrace | null, b: ChartTrace | null): void {
    this.a = a;
    this.b = b;
    this.stA = a ? toSemitones(a.f0, a.medianF0) : new Float32Array(0);
    this.stB = b ? toSemitones(b.f0, b.medianF0) : new Float32Array(0);
    const all = [...this.stA, ...this.stB].filter((x) => !Number.isNaN(x)).sort((x, y) => x - y);
    let extent = 6;
    if (all.length) {
      const p1 = all[Math.floor(all.length * 0.01)];
      const p99 = all[Math.min(all.length - 1, Math.floor(all.length * 0.99))];
      extent = Math.max(6, Math.ceil(Math.max(Math.abs(p1), Math.abs(p99)) / 3) * 3);
    }
    this.range = extent;
    this.draw();
  }

  setPlayhead(t: number): void {
    this.playhead = t;
    this.draw(false);
  }

  /** recomputeDomain: false keeps the x axis still while dragging/playing. */
  draw(recomputeDomain = true): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.width) return;
    if (recomputeDomain) this.computeDomain();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.a && !this.b) return;
    const s = getComputedStyle(this.canvas);
    const color = (n: string) => s.getPropertyValue(n).trim();
    const right = this.width - MARGIN.right;
    const bottom = this.height - MARGIN.bottom;

    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let st = -this.range; st <= this.range; st += 3) {
      const y = Math.round(this.stToY(st)) + 0.5;
      ctx.strokeStyle = st === 0 ? color('--grid-strong') : color('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      if (st % 6 === 0) {
        ctx.fillStyle = color('--text-muted');
        ctx.fillText(st === 0 ? '0 st' : `${st > 0 ? '+' : '−'}${Math.abs(st)} st`, MARGIN.left - 8, y);
      }
    }

    // Time ticks in seconds of aligned time.
    const span = this.x1 - this.x0;
    const step = span > 12 ? 2 : span > 5 ? 1 : 0.5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(this.x0 / step) * step; t <= this.x1 + 1e-9; t += step) {
      const x = this.tToX(t);
      ctx.fillStyle = color('--text-muted');
      ctx.fillText(`${t.toFixed(step < 1 ? 1 : 0)} s`, x, bottom + 8);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top, right - MARGIN.left, bottom - MARGIN.top);
    ctx.clip();
    if (this.a) this.drawTrace(ctx, this.a, this.stA, color('--trace'), []);
    if (this.b) this.drawTrace(ctx, this.b, this.stB, color('--trace-b'), [7, 5]);
    if (!Number.isNaN(this.playhead)) {
      const x = Math.round(this.tToX(this.playhead)) + 0.5;
      ctx.strokeStyle = color('--playhead');
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, MARGIN.top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawTrace(ctx: CanvasRenderingContext2D, t: ChartTrace, st: Float32Array, color: string, dash: number[]): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = dash.length ? 'butt' : 'round';
    ctx.setLineDash(dash);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < st.length; i++) {
      if (Number.isNaN(st[i])) {
        pen = false;
        continue;
      }
      const x = this.tToX(t.frameCenterOffset + i * t.hopSeconds - t.offset);
      const y = this.stToY(st[i]);
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private computeDomain(): void {
    const spans = [this.a, this.b].filter((x): x is ChartTrace => !!x).map((t) => [-t.offset, t.duration - t.offset]);
    if (!spans.length) return;
    this.x0 = Math.min(...spans.map((s) => s[0])) - 0.1;
    this.x1 = Math.max(...spans.map((s) => s[1])) + 0.1;
  }

  private tToX(t: number): number {
    return MARGIN.left + ((t - this.x0) / (this.x1 - this.x0)) * (this.width - MARGIN.left - MARGIN.right);
  }

  private stToY(st: number): number {
    const h = this.height - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + ((this.range - st) / (2 * this.range)) * h;
  }
}
