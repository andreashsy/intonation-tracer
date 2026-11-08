// Pitch readout (pitch-axis spec §7): a label near the pointer showing exact Hz and st,
// shown on hover (mouse/pen) or after touching and holding (touch), with a filling ring
// during the hold and a hint chip until the readout has been used once.

const HINT_KEY = 'intonation-tracer.readoutHintSeen';
export const HOLD_MS = 400;
const SLOP_PX = 4;

export interface ReadoutRow {
  color: string;
  dashed: boolean;
  text: string;
}

const allReadouts = new Set<Readout>();

function hintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Touch screens get "touch and hold"; everything else "hover". */
export function isTouchFirst(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export class Readout {
  private readonly wrap: HTMLElement;
  private readonly label: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdStart: { x: number; y: number; id: number } | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a touch-and-hold readout is showing (the finger is down). */
  holding = false;

  constructor(wrap: HTMLElement) {
    this.wrap = wrap;
    this.label = document.createElement('div');
    this.label.className = 'readout';
    this.label.hidden = true;
    this.label.setAttribute('aria-hidden', 'true');
    this.ring = document.createElement('div');
    this.ring.className = 'hold-ring';
    this.ring.hidden = true;
    this.ring.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
    this.hint = document.createElement('div');
    this.hint.className = 'readout-hint';
    const text = document.createElement('span');
    text.textContent = isTouchFirst() ? '☝ Touch and hold to read the pitch' : 'Hover over the trace to read the pitch';
    const help = document.createElement('button');
    help.type = 'button';
    help.className = 'link-button';
    help.textContent = "What's st?";
    help.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-axis-help')));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'hint-close';
    close.setAttribute('aria-label', 'Dismiss hint');
    close.textContent = '✕';
    close.addEventListener('click', () => Readout.markUsed());
    this.hint.append(text, help, close);
    this.hint.hidden = hintSeen();
    wrap.append(this.label, this.ring, this.hint);
    allReadouts.add(this);
  }

  /** The readout has been used (or the hint closed): hide every hint for good. */
  static markUsed(): void {
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      // ignore
    }
    for (const r of allReadouts) r.hint.hidden = true;
  }

  /** Shows the label for a pointer at (x, y) in wrap pixels. */
  show(x: number, y: number, header: string, rows: ReadoutRow[]): void {
    const l = this.label;
    l.replaceChildren();
    const h = document.createElement('div');
    h.className = 'readout-head';
    h.textContent = header;
    l.append(h);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'readout-row';
      const sw = document.createElement('span');
      sw.className = `readout-swatch${r.dashed ? ' dashed' : ''}`;
      sw.style.borderTopColor = r.color;
      const t = document.createElement('span');
      t.textContent = r.text;
      row.append(sw, t);
      l.append(row);
    }
    l.hidden = false;
    // A hover that lasts a moment counts as having found the feature.
    if (!this.holding && !this.hint.hidden && !this.hoverTimer) this.hoverTimer = setTimeout(() => Readout.markUsed(), 800);
    // Keep it inside the chart and away from the finger/pointer.
    const w = this.wrap.clientWidth;
    const lw = l.offsetWidth;
    const lh = l.offsetHeight;
    const gap = this.holding ? 28 : 14;
    let left = x + gap;
    if (left + lw > w - 4) left = x - gap - lw;
    left = Math.max(4, left);
    let top = y - lh - (this.holding ? 48 : 12);
    if (top < 4) top = Math.min(this.wrap.clientHeight - lh - 4, y + gap);
    l.style.left = `${left}px`;
    l.style.top = `${Math.max(4, top)}px`;
  }

  hide(): void {
    this.label.hidden = true;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
  }

  // ---- touch and hold ----

  /**
   * Call on pointerdown. For touch, starts the hold; `onHold` fires after HOLD_MS if the
   * finger hasn't moved. Returns true if a hold was started.
   */
  pointerDown(e: PointerEvent, local: { x: number; y: number }, onHold: () => void): boolean {
    this.cancelHold();
    if (e.pointerType !== 'touch') return false;
    this.holdStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
    this.ring.style.left = `${local.x}px`;
    this.ring.style.top = `${local.y}px`;
    this.ring.hidden = false;
    this.ring.classList.remove('filling');
    void this.ring.offsetWidth; // restart the CSS animation
    this.ring.classList.add('filling');
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.ring.hidden = true;
      this.holding = true;
      navigator.vibrate?.(10);
      Readout.markUsed();
      onHold();
    }, HOLD_MS);
    return true;
  }

  /** Call on pointermove. Returns true if the move cancelled a pending hold (normal gesture continues). */
  pointerMove(e: PointerEvent): boolean {
    if (!this.holdTimer || !this.holdStart || e.pointerId !== this.holdStart.id) return false;
    if (Math.hypot(e.clientX - this.holdStart.x, e.clientY - this.holdStart.y) >= SLOP_PX) {
      this.cancelHold();
      return true;
    }
    return false;
  }

  /** Call on pointerup/cancel. Returns true if a hold readout was showing (so the gesture shouldn't seek etc.). */
  pointerUp(): boolean {
    const was = this.holding;
    this.cancelHold();
    this.holding = false;
    if (was) this.hide();
    return was;
  }

  get holdPending(): boolean {
    return this.holdTimer !== null;
  }

  private cancelHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.holdStart = null;
    this.ring.hidden = true;
  }
}
