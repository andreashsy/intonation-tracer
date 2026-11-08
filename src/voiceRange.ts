// Voice range controls: a preset menu plus Min/Max Hz inputs.
// Picking a preset fills the inputs; editing an input switches the menu to Custom.
// The choice can be remembered in this browser (best effort) under a storage key; several
// independent instances can exist (the player's, and Practice's model and "my voice" ranges).

import { RANGE_LIMITS, RANGE_PRESETS, type RangePresetId, type VoiceRange, validateRange } from './config.ts';

const DEFAULT_KEY = 'intonation-tracer.voiceRange';

interface Saved {
  preset: RangePresetId;
  range: VoiceRange;
}

export class VoiceRangeControls {
  private readonly preset: HTMLSelectElement;
  private readonly min: HTMLInputElement;
  private readonly max: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly onChange: (range: VoiceRange) => void;
  private readonly storageKey: string | null;
  private applied: VoiceRange;

  /** storageKey: where to remember the choice; null = don't remember (set from outside instead). */
  constructor(
    preset: HTMLSelectElement,
    min: HTMLInputElement,
    max: HTMLInputElement,
    status: HTMLElement,
    onChange: (range: VoiceRange) => void,
    storageKey: string | null = DEFAULT_KEY,
  ) {
    this.onChange = onChange;
    this.storageKey = storageKey;
    this.preset = preset;
    this.min = min;
    this.max = max;
    this.status = status;

    for (const input of [min, max]) {
      input.min = String(RANGE_LIMITS.floor);
      input.max = String(RANGE_LIMITS.ceiling);
      input.step = '5';
    }
    preset.replaceChildren(
      ...Object.entries(RANGE_PRESETS).map(([id, p]) => new Option(`${p.label} (${p.minF0}–${p.maxF0} Hz)`, id)),
      new Option('Custom', 'custom'),
    );

    const saved = load(storageKey);
    this.applied = saved.range;
    preset.value = saved.preset;
    this.showRange(saved.range);

    preset.addEventListener('change', () => {
      const id = preset.value as RangePresetId;
      if (id === 'custom') {
        min.focus();
        return;
      }
      const p = RANGE_PRESETS[id];
      this.showRange(p);
      this.apply(p);
    });

    for (const input of [min, max]) {
      input.addEventListener('input', () => {
        this.preset.value = 'custom';
      });
      // Apply on commit (Enter, blur, spinner release), not on every keystroke.
      input.addEventListener('change', () => this.applyInputs());
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.applyInputs();
      });
    }
  }

  get range(): VoiceRange {
    return this.applied;
  }

  /**
   * Reports the range being edited (typed or picked, before it's applied) while focus is
   * inside `container`, and null when focus leaves — used to draw range guides on the chart.
   */
  onEditing(fn: (r: VoiceRange | null) => void, container: HTMLElement): void {
    container.addEventListener('focusin', () => fn(this.pending()));
    container.addEventListener('focusout', () => {
      // Focus may be moving to another control in the same group; check after it settles.
      setTimeout(() => {
        if (!container.contains(document.activeElement)) fn(null);
      }, 0);
    });
    for (const input of [this.min, this.max]) input.addEventListener('input', () => fn(this.pending()));
    this.preset.addEventListener('change', () => fn(this.pending()));
  }

  /** The range currently shown in the inputs if it's usable, else the applied one. */
  private pending(): VoiceRange {
    const r = { minF0: this.min.valueAsNumber, maxF0: this.max.valueAsNumber };
    return Number.isFinite(r.minF0) && Number.isFinite(r.maxF0) && r.minF0 > 0 && r.maxF0 > r.minF0 ? r : this.applied;
  }

  /** Shows a range without triggering onChange (e.g. the range a saved model was traced with). */
  set(r: VoiceRange): void {
    this.applied = { minF0: r.minF0, maxF0: r.maxF0 };
    const match = Object.entries(RANGE_PRESETS).find(([, p]) => p.minF0 === r.minF0 && p.maxF0 === r.maxF0);
    this.preset.value = match ? match[0] : 'custom';
    this.showRange(r);
    this.setStatus('', false);
  }

  setDisabled(disabled: boolean): void {
    for (const el of [this.preset, this.min, this.max]) el.disabled = disabled;
  }

  setBusy(busy: boolean): void {
    if (busy) this.setStatus('Re-analyzing…', false);
    else if (this.status.dataset.kind !== 'error') this.setStatus('', false);
  }

  private applyInputs(): void {
    const r = { minF0: this.min.valueAsNumber, maxF0: this.max.valueAsNumber };
    const error = validateRange(r);
    this.min.setAttribute('aria-invalid', String(Boolean(error)));
    this.max.setAttribute('aria-invalid', String(Boolean(error)));
    if (error) {
      this.setStatus(error, true);
      return;
    }
    // Snap the menu back to a preset if the numbers match one.
    const match = Object.entries(RANGE_PRESETS).find(([, p]) => p.minF0 === r.minF0 && p.maxF0 === r.maxF0);
    this.preset.value = match ? match[0] : 'custom';
    this.apply(r);
  }

  private apply(r: VoiceRange): void {
    this.setStatus('', false);
    this.min.setAttribute('aria-invalid', 'false');
    this.max.setAttribute('aria-invalid', 'false');
    if (r.minF0 === this.applied.minF0 && r.maxF0 === this.applied.maxF0) return;
    this.applied = { minF0: r.minF0, maxF0: r.maxF0 };
    if (this.storageKey) save(this.storageKey, { preset: this.preset.value as RangePresetId, range: this.applied });
    this.onChange(this.applied);
  }

  private showRange(r: VoiceRange): void {
    this.min.value = String(r.minF0);
    this.max.value = String(r.maxF0);
  }

  private setStatus(text: string, isError: boolean): void {
    this.status.textContent = text;
    this.status.dataset.kind = isError ? 'error' : '';
  }
}

function load(key: string | null): Saved {
  const fallback: Saved = { preset: 'any', range: { minF0: RANGE_PRESETS.any.minF0, maxF0: RANGE_PRESETS.any.maxF0 } };
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Saved;
    if (!s?.range || validateRange(s.range)) return fallback;
    const preset = (['any', 'lower', 'higher', 'custom'] as const).includes(s.preset) ? s.preset : 'custom';
    return { preset, range: { minF0: s.range.minF0, maxF0: s.range.maxF0 } };
  } catch {
    return fallback;
  }
}

function save(key: string, s: Saved): void {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode, blocked): the setting just isn't remembered.
  }
}
