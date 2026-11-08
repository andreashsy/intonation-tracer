// Range slider plus time labels (spec §8). While dragging, playback continues
// and only the label moves; the seek happens on release.

import { formatTime, spokenTime } from './format.ts';

export class SeekBar {
  private readonly input: HTMLInputElement;
  private readonly current: HTMLElement;
  private readonly total: HTMLElement;
  private dragging = false;
  private duration = 0;

  constructor(input: HTMLInputElement, current: HTMLElement, total: HTMLElement, onSeek: (t: number) => void) {
    this.input = input;
    this.current = current;
    this.total = total;

    input.addEventListener('pointerdown', () => {
      this.dragging = true;
    });
    input.addEventListener('input', () => {
      // Live label while dragging (or PageUp/PageDown); no seek yet.
      this.showTime(Number(input.value));
    });
    input.addEventListener('change', () => {
      this.dragging = false;
      onSeek(Number(input.value));
    });
    // A pointer released without a value change still ends the drag.
    input.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    input.addEventListener('pointercancel', () => {
      this.dragging = false;
    });
  }

  setDuration(d: number): void {
    this.duration = d;
    this.input.max = String(d);
    this.total.textContent = formatTime(d);
    this.update(0);
  }

  /** Follows playback unless the user is dragging. */
  update(t: number): void {
    if (this.dragging) return;
    this.input.value = String(t);
    this.showTime(t);
  }

  private showTime(t: number): void {
    this.current.textContent = formatTime(t);
    this.input.setAttribute('aria-valuetext', `${spokenTime(t)} of ${spokenTime(this.duration)}`);
  }
}
