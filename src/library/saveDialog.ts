// "Save phrase" dialog (M1 spec §5), built on the native <dialog> element.

import { formatBytes } from '../phrases.ts';
import type { Role } from './db.ts';

export interface SaveRequest {
  defaultName: string;
  summary: string; // e.g. "0:03.2–0:05.9 (2.7 s) from clip.mp4"
  defaultRole: Role;
  videoSize: number; // 0 when the source has no video
  models: { id: string; name: string }[]; // newest first
  languages: string[];
}

export interface SaveAnswer {
  name: string;
  role: Role;
  language?: string;
  modelId?: string;
  keepVideo: boolean;
}

const LANGUAGE_KEY = 'intonation-tracer.lastLanguage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class SaveDialog {
  private readonly dialog = $<HTMLDialogElement>('save-dialog');
  private readonly form = $<HTMLFormElement>('save-form');
  private readonly name = $<HTMLInputElement>('save-name');
  private readonly language = $<HTMLInputElement>('save-language');
  private readonly languageList = $<HTMLDataListElement>('language-list');
  private readonly linkField = $<HTMLLabelElement>('save-link-field');
  private readonly link = $<HTMLSelectElement>('save-link');
  private readonly videoField = $<HTMLLabelElement>('save-video-field');
  private readonly video = $<HTMLInputElement>('save-video');
  private readonly videoLabel = $<HTMLSpanElement>('save-video-label');
  private readonly summary = $<HTMLParagraphElement>('save-summary');
  private readonly error = $<HTMLParagraphElement>('save-error');
  private resolve: ((a: SaveAnswer | null) => void) | null = null;

  constructor() {
    this.form.addEventListener('change', () => this.syncRole());
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = this.name.value.trim();
      if (!name) {
        this.name.focus();
        return;
      }
      const role = this.role();
      const language = this.language.value.trim() || undefined;
      try {
        if (language) localStorage.setItem(LANGUAGE_KEY, language);
      } catch {
        // not remembered; fine
      }
      this.finish({
        name,
        role,
        language,
        modelId: role === 'me' && this.link.value ? this.link.value : undefined,
        keepVideo: !this.videoField.hidden && this.video.checked,
      });
    });
    $<HTMLButtonElement>('save-cancel').addEventListener('click', () => this.finish(null));
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault(); // Esc: close through finish() so the promise settles
      this.finish(null);
    });
  }

  /** Shows the dialog; resolves with the answers, or null if cancelled. */
  ask(req: SaveRequest): Promise<SaveAnswer | null> {
    this.name.value = req.defaultName;
    this.summary.textContent = req.summary;
    for (const r of this.form.querySelectorAll<HTMLInputElement>('input[name=role]')) r.checked = r.value === req.defaultRole;
    let last = '';
    try {
      last = localStorage.getItem(LANGUAGE_KEY) ?? '';
    } catch {
      // ignore
    }
    this.language.value = last;
    this.languageList.replaceChildren(...req.languages.map((l) => new Option(l)));
    this.link.replaceChildren(new Option('— None —', ''), ...req.models.map((m) => new Option(m.name, m.id)));
    if (req.models.length) this.link.value = req.models[0].id;
    this.videoField.hidden = req.videoSize <= 0;
    this.video.checked = true;
    this.videoLabel.textContent = `Keep video (${formatBytes(req.videoSize)})`;
    this.error.hidden = true;
    this.syncRole();
    this.dialog.showModal();
    this.name.select();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Shows an error inside the open dialog (e.g. storage full) and keeps it open. */
  showError(message: string): Promise<SaveAnswer | null> {
    this.error.textContent = message;
    this.error.hidden = false;
    if (!this.dialog.open) this.dialog.showModal();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
  }

  private role(): 'model' | 'me' {
    return (this.form.querySelector<HTMLInputElement>('input[name=role]:checked')?.value as 'model' | 'me') ?? 'model';
  }

  private syncRole(): void {
    this.linkField.hidden = this.role() !== 'me' || this.link.options.length <= 1;
  }

  private finish(answer: SaveAnswer | null): void {
    const r = this.resolve;
    this.resolve = null;
    // Keep the dialog open on save so an error can be shown; the caller closes it on success.
    if (!answer) this.close();
    r?.(answer);
  }
}
