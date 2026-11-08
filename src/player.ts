// <audio> wrapper with a smoothed clock (spec §7.3).
// audio.currentTime updates coarsely in some browsers, so time() interpolates
// with performance.now() between updates and never runs backwards while playing.

export class Player {
  readonly el: HTMLAudioElement;
  private anchorMedia = 0;
  private anchorPerf = 0;
  private lastSeen = -1;
  private lastReturned = 0;

  constructor(el: HTMLAudioElement) {
    this.el = el;
    for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'ended']) {
      el.addEventListener(ev, () => this.resync());
    }
  }

  /** Loads a URL and resolves with its duration (may be Infinity for some WebM files). */
  load(url: string): Promise<number> {
    const el = this.el;
    return new Promise((resolve, reject) => {
      const done = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onError);
      };
      const onMeta = () => {
        done();
        resolve(el.duration);
      };
      const onError = () => {
        done();
        reject(new Error('This file cannot be played in this browser.'));
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('error', onError);
      el.src = url;
      el.load();
      this.resync(0);
    });
  }

  unload(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.resync(0);
  }

  get playing(): boolean {
    return !this.el.paused && !this.el.ended;
  }

  get duration(): number {
    return this.el.duration;
  }

  async play(): Promise<void> {
    if (this.el.ended) this.seek(0);
    try {
      await this.el.play();
    } catch {
      // Autoplay or interruption errors: leave paused.
    }
  }

  pause(): void {
    this.el.pause();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(t: number): void {
    const d = Number.isFinite(this.el.duration) ? this.el.duration : t;
    const clamped = Math.min(Math.max(0, t), d);
    if (!Number.isFinite(clamped)) return;
    this.el.currentTime = clamped;
    this.resync(clamped);
  }

  /** Smoothed current time in seconds. */
  time(): number {
    const ct = this.el.currentTime;
    if (!this.playing) {
      this.lastReturned = ct;
      return ct;
    }
    const now = performance.now();
    if (ct !== this.lastSeen) {
      this.lastSeen = ct;
      this.anchorMedia = ct;
      this.anchorPerf = now;
    }
    let t = this.anchorMedia + ((now - this.anchorPerf) / 1000) * this.el.playbackRate;
    // Don't run far ahead of the element if it stalls (buffering, etc.).
    if (t - ct > 0.25) t = ct + 0.25;
    // Small backward corrections look like jitter; hold instead.
    if (t < this.lastReturned && this.lastReturned - t < 0.1) t = this.lastReturned;
    const d = this.el.duration;
    if (Number.isFinite(d)) t = Math.min(t, d);
    this.lastReturned = t;
    return t;
  }

  private resync(t = this.el.currentTime): void {
    this.anchorMedia = t;
    this.anchorPerf = performance.now();
    this.lastSeen = this.el.currentTime;
    this.lastReturned = t;
  }
}
