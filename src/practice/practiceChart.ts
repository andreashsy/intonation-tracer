// Practice chart (M2 spec §5): model (solid), current take (dashed), previous take (faint
// ghost) and the live line while recording, each in semitones relative to its own median,
// on a shared aligned-time axis. Dragging sideways shifts the current take.

export type LayerKind = 'model' | 'take' | 'ghost' | 'live';

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

const MARGIN = { left: 56, right: 12, top: 12, bottom: 28 };
const SLOP_PX = 4;

export class PracticeChart {
  private readonly canvas: HTMLCanvasElement;
  private layers: Layer[] = [];
  private range = 6;
  private x0 = 0;
  private x1 = 1;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private playhead = NaN;
  private modelFaded = false;
  private countIn = '';
  private dragStartX: number | null = null;
  private dragStartOffset = 0;
  private dragging = false;
  /** Called with the current take's new offset while dragging. */
  onShift: (offset: number) => void = () => {};

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
      const take = this.layer('take');
      if (!take || e.button !== 0) return;
      this.dragStartX = e.clientX;
      this.dragStartOffset = take.offset;
      this.dragging = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const take = this.layer('take');
      if (this.dragStartX === null || !take) return;
      const dx = e.clientX - this.dragStartX;
      if (!this.dragging && Math.abs(dx) < SLOP_PX) return;
      this.dragging = true;
      const secondsPerPx = (this.x1 - this.x0) / (this.width - MARGIN.left - MARGIN.right);
      take.offset = this.dragStartOffset - dx * secondsPerPx; // right = later
      this.draw();
      this.onShift(take.offset);
    });
    const end = () => {
      this.dragStartX = null;
      if (this.dragging) this.fit();
      this.dragging = false;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
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
      // Grow the x axis only if the live line runs past it.
      const end = this.frameTime(live, (live.count ?? live.f0.length) - 1) + 0.2;
      if (end > this.x1) this.x1 = end;
    }
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

  private frameTime(l: Layer, i: number): number {
    return l.frameCenterOffset + i * l.hopSeconds - l.offset;
  }

  private fit(): void {
    const fixed = this.layers.filter((l) => l.kind !== 'live');
    if (fixed.length) {
      this.x0 = Math.min(...fixed.map((l) => -l.offset)) - 0.1;
      this.x1 = Math.max(...fixed.map((l) => l.duration - l.offset)) + 0.1;
      // Leave room for a take that may be longer than the model.
      const model = this.layer('model');
      if (model && fixed.length === 1) this.x1 = Math.max(this.x1, model.duration * 1.3 - model.offset);
    }
    const st: number[] = [];
    for (const l of fixed) {
      const n = l.count ?? l.f0.length;
      for (let i = 0; i < n; i++) if (!Number.isNaN(l.f0[i])) st.push(12 * Math.log2(l.f0[i] / l.medianF0));
    }
    st.sort((a, b) => a - b);
    let extent = 6;
    if (st.length) {
      const p1 = st[Math.floor(st.length * 0.01)];
      const p99 = st[Math.min(st.length - 1, Math.floor(st.length * 0.99))];
      extent = Math.max(6, Math.ceil(Math.max(Math.abs(p1), Math.abs(p99)) / 3) * 3);
    }
    this.range = extent;
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
    ctx.rect(MARGIN.left, MARGIN.top, right - MARGIN.left, bottom - MARGIN.top);
    ctx.clip();
    const order: LayerKind[] = ['ghost', 'model', 'take', 'live'];
    for (const kind of order) {
      const l = this.layer(kind);
      if (!l) continue;
      ctx.globalAlpha = kind === 'ghost' ? 0.4 : kind === 'model' && this.modelFaded ? 0.35 : 1;
      const isB = kind !== 'model';
      this.drawLayer(ctx, l, isB ? color('--trace-b') : color('--trace'), kind === 'model' ? [] : kind === 'ghost' ? [3, 5] : [7, 5], kind === 'ghost' ? 2 : 3);
    }
    ctx.globalAlpha = 1;
    if (!Number.isNaN(this.playhead)) {
      const x = Math.round(this.tToX(this.playhead)) + 0.5;
      ctx.strokeStyle = color('--playhead');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, MARGIN.top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.restore();

    if (this.countIn) {
      ctx.fillStyle = color('--text');
      ctx.font = '600 72px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.countIn, (MARGIN.left + right) / 2, (MARGIN.top + bottom) / 2);
    }
  }

  private drawLayer(ctx: CanvasRenderingContext2D, l: Layer, color: string, dash: number[], width: number): void {
    if (Number.isNaN(l.medianF0)) return;
    ctx.strokeStyle = color;
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
      const y = this.stToY(12 * Math.log2(f / l.medianF0));
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

  private stToY(st: number): number {
    const h = this.height - MARGIN.top - MARGIN.bottom;
    // Clamp so a live outlier can't draw outside the plot.
    const c = Math.max(-this.range, Math.min(this.range, st));
    return MARGIN.top + ((this.range - c) / (2 * this.range)) * h;
  }
}
