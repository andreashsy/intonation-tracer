// Library drawer (M1 spec §7): Models with their linked takes, other takes, sizes and actions.

import { formatTime } from '../format.ts';
import { formatBytes, sparklinePath } from '../phrases.ts';
import { deletePhrase, listPhrases, type PhraseInfo, removeVideo, totalBytes } from './db.ts';

export interface LibraryActions {
  open(id: string): void;
  practice(id: string): void;
  /** Called after any change so other views (practice picker, save dialog) can refresh. */
  changed(items: PhraseInfo[]): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const SVG_NS = 'http://www.w3.org/2000/svg';
const CONFIRM_MS = 4000;

export class LibraryPanel {
  private readonly drawer = $<HTMLElement>('library');
  private readonly backdrop = $<HTMLDivElement>('library-backdrop');
  private readonly list = $<HTMLDivElement>('library-list');
  private readonly usage = $<HTMLParagraphElement>('library-usage');
  private readonly button = $<HTMLButtonElement>('open-library');
  private readonly count = $<HTMLSpanElement>('library-count');
  private readonly actions: LibraryActions;
  private items: PhraseInfo[] = [];
  private returnFocus: HTMLElement | null = null;

  constructor(actions: LibraryActions) {
    this.actions = actions;
    this.button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    $<HTMLButtonElement>('close-library').addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());
    this.drawer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.drawer.hidden;
  }

  get phrases(): PhraseInfo[] {
    return this.items;
  }

  disable(reason: string): void {
    this.button.disabled = true;
    this.button.title = reason;
  }

  async open(): Promise<void> {
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.drawer.hidden = false;
    this.backdrop.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    await this.refresh();
    this.drawer.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.drawer.hidden = true;
    this.backdrop.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    this.returnFocus?.focus?.();
  }

  async refresh(): Promise<PhraseInfo[]> {
    try {
      this.items = await listPhrases();
    } catch {
      this.items = [];
    }
    this.count.textContent = this.items.length ? `(${this.items.length})` : '';
    this.usage.textContent = this.items.length
      ? `Saved in this browser only · ${formatBytes(totalBytes(this.items))}`
      : 'Saved in this browser only.';
    this.render();
    this.actions.changed(this.items);
    return this.items;
  }

  private render(): void {
    const models = this.items.filter((i) => i.phrase.role === 'model');
    const modelIds = new Set(models.map((m) => m.phrase.id));
    const takes = this.items.filter((i) => i.phrase.role === 'me');
    const nodes: Node[] = [];

    if (!this.items.length) {
      const p = document.createElement('p');
      p.className = 'library-empty';
      p.textContent =
        'No saved phrases yet. Load a clip or record yourself, press "Select phrase", pick a sentence, then "Save phrase…". Then press "Practice" on a Model to record yourself and match it.';
      nodes.push(p);
    }

    for (const m of models) {
      const group = document.createElement('div');
      group.className = 'lib-group';
      group.append(this.row(m, false));
      for (const t of takes.filter((t) => t.phrase.modelId === m.phrase.id)) group.append(this.row(t, true));
      nodes.push(group);
    }
    const loose = takes.filter((t) => !t.phrase.modelId || !modelIds.has(t.phrase.modelId));
    if (loose.length) {
      const h = document.createElement('h3');
      h.className = 'lib-subhead';
      h.textContent = models.length ? 'Other takes' : 'My takes';
      nodes.push(h);
      for (const t of loose) nodes.push(this.row(t, false));
    }
    this.list.replaceChildren(...nodes);
  }

  private row(info: PhraseInfo, indented: boolean): HTMLElement {
    const p = info.phrase;
    const row = document.createElement('article');
    row.className = `lib-row${indented ? ' take' : ''}`;
    row.setAttribute('aria-label', `${p.role === 'model' ? 'Model' : 'Me'}: ${p.name}`);

    const badge = document.createElement('span');
    badge.className = `badge ${p.role}`;
    badge.textContent = p.role === 'model' ? 'Model' : 'Me';

    const main = document.createElement('div');
    main.className = 'lib-main';
    const name = document.createElement('div');
    name.className = 'lib-name';
    name.textContent = p.name;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', `spark ${p.role}`);
    svg.setAttribute('viewBox', '0 0 120 28');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', sparklinePath(p.f0, p.medianF0, 120, 28));
    svg.append(path);

    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const date = new Date(p.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    meta.textContent = [formatTime(p.duration), date, p.language].filter(Boolean).join(' · ');

    const size = document.createElement('div');
    size.className = 'lib-size';
    const parts = [`Audio ${formatBytes(p.audio.size)}`];
    if (info.videoSize) {
      parts.push(
        `Video ${formatBytes(info.videoSize)}${info.videoSharedBy > 1 ? `, shared by ${info.videoSharedBy} phrases` : ''}`,
      );
    }
    size.textContent = parts.join(' · ');

    main.append(name, svg, meta, size);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    actions.append(
      this.actionButton('Open', () => {
        this.close();
        this.actions.open(p.id);
      }),
    );
    // Practice: on Models, and on takes that are linked to a Model.
    const linked = p.role === 'model' || (!!p.modelId && this.items.some((i) => i.phrase.id === p.modelId));
    if (linked) {
      actions.append(
        this.actionButton('Practice', () => {
          this.close();
          this.actions.practice(p.id);
        }),
      );
    }
    if (info.videoSize) {
      const freed = info.videoSharedBy > 1 ? 0 : info.videoSize;
      const b = this.actionButton('Remove video', async () => {
        await removeVideo(p.id);
        await this.refresh();
      });
      b.title = freed ? `Frees ${formatBytes(freed)}` : 'Other phrases still use this video';
      actions.append(b);
    }
    const del = this.actionButton('Delete', async () => {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = 'Confirm delete';
        del.classList.add('danger');
        setTimeout(() => {
          if (!del.isConnected) return;
          del.dataset.confirm = '';
          del.textContent = 'Delete';
          del.classList.remove('danger');
        }, CONFIRM_MS);
        return;
      }
      await deletePhrase(p.id);
      await this.refresh();
      this.list.querySelector<HTMLButtonElement>('button')?.focus();
    });
    actions.append(del);

    row.append(badge, main, actions);
    return row;
  }

  private actionButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'secondary small';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }
}
