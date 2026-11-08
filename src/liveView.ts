// Scrolling live pitch trace while recording (PRD VZ-1). The newest pitch is at the
// right edge and older pitch scrolls left, like a pen on moving paper. The vertical axis
// is Hz on a log scale spanning the current voice range (the clip's median isn't known
// yet, so the semitone view is used only after recording).

import { VIEW, type VoiceRange } from './config.ts';

const MARGIN = { left: 64, right: 12, top: 12, bottom: 12 };
const GRID_HZ = [50, 75, 100, 150, 200, 300, 400, 600, 800, 1000];
const FRAMES_PER_SECOND = 100;

export class LiveView {
  private readonly canvas: HTMLCanvasElement;
  private f0 = new Float32Array(FRAMES_PER_SECOND * 60);
  private count = 0;
  private range: VoiceRange = { minF0: 50, maxF0: 800 };
  private width = 0;
  private height = 0;
  private dpr = 1;

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
  }

  reset(range: VoiceRange): void {
    this.range = range;
    this.count = 0;
    this.draw();
  }

  push(f0: number): void {
    if (this.count === this.f0.length) {
      const grown = new Float32Array(this.f0.length * 2);
      grown.set(this.f0);
      this.f0 = grown;
    }
    this.f0[this.count++] = f0;
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !this.width) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const s = getComputedStyle(this.canvas);
    const color = (n: string) => s.getPropertyValue(n).trim();
    const right = this.width - MARGIN.right;

    // Hz grid.
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const hz of GRID_HZ) {
      if (hz < this.range.minF0 || hz > this.range.maxF0) continue;
      const y = Math.round(this.hzToY(hz)) + 0.5;
      ctx.strokeStyle = color('--grid');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = color('--text-muted');
      ctx.fillText(`${hz} Hz`, MARGIN.left - 8, y);
    }

    // Trace: the last windowSeconds, newest at the right edge.
    const visible = VIEW.windowSeconds * FRAMES_PER_SECOND;
    const first = Math.max(0, this.count - visible);
    const pxPerFrame = (right - MARGIN.left) / visible;
    const xOf = (i: number) => right - (this.count - 1 - i) * pxPerFrame;
    ctx.strokeStyle = color('--trace');
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let penDown = false;
    for (let i = first; i < this.count; i++) {
      const f = this.f0[i];
      if (Number.isNaN(f)) {
        penDown = false;
        continue;
      }
      const x = xOf(i);
      const y = this.hzToY(f);
      if (penDown) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      penDown = true;
    }
    ctx.stroke();

    // Pen marker at "now".
    const latest = this.count ? this.f0[this.count - 1] : NaN;
    if (!Number.isNaN(latest)) {
      ctx.fillStyle = color('--playhead');
      ctx.beginPath();
      ctx.arc(right, this.hzToY(latest), 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private hzToY(hz: number): number {
    const lo = Math.log(this.range.minF0);
    const hi = Math.log(this.range.maxF0);
    const h = this.height - MARGIN.top - MARGIN.bottom;
    return MARGIN.top + ((hi - Math.log(hz)) / (hi - lo)) * h;
  }
}
