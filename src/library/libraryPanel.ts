// Library drawer (M1 spec §7): the user's Models with their linked takes, other takes,
// sizes and actions, then built-in samples at the bottom (§7.1, read-only, grouped by
// language, absent when there are none).

import { formatTime } from '../format.ts';
import { formatBytes, sparklinePath } from '../phrases.ts';
import { downloadBlob, extensionFor, safeFileName } from '../download.ts';
import { deletePhrase, getSource, listPhrases, type Phrase, type PhraseInfo, removeVideo, totalBytes } from './db.ts';
import { isSampleId } from './samples.ts';

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
  /** Built-in samples, analyzed and ready; `samplesPending` are still loading. */
  private samples: Phrase[] = [];
  private samplesPending: { name: string; language: string }[] = [];
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

  /** The user's saved phrases (IndexedDB only). */
  get phrases(): PhraseInfo[] {
    return this.items;
  }

  /** The user's phrases followed by samples: what Practice and the save dialog can pick from. */
  get allPhrases(): PhraseInfo[] {
    return [...this.items, ...this.samples.map((phrase) => ({ phrase, videoSize: 0, videoSharedBy: 0 }))];
  }

  /** Updates the built-in samples (ready ones, plus ones still being prepared). */
  setSamples(ready: Phrase[], pending: { name: string; language: string }[]): void {
    this.samples = ready;
    this.samplesPending = pending;
    this.render();
    this.actions.changed(this.allPhrases);
  }

  disable(reason: string): void {
    this.button.disabled = true;
    this.button.title = reason;
  }

  /** Storage is unavailable but there are samples: allow opening the library for them. */
  enableForSamples(): void {
    this.button.disabled = false;
    this.button.title = '';
    this.usage.textContent = "Your own library isn't available in this browser window, but the samples are.";
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
    this.actions.changed(this.allPhrases);
    return this.items;
  }

  private render(): void {
    const models = this.items.filter((i) => i.phrase.role === 'model');
    const modelIds = new Set([...models.map((m) => m.phrase.id), ...this.samples.map((s) => s.id)]);
    const takes = this.items.filter((i) => i.phrase.role === 'me');
    const nodes: Node[] = [];
    const sampleNodes: Node[] = [];
    const hasSamples = this.samples.length > 0 || this.samplesPending.length > 0;

    // ---- The user's own phrases first; "My library" is only labelled when samples follow ----
    if (hasSamples) {
      const mine = document.createElement('h3');
      mine.className = 'lib-section';
      mine.textContent = 'My library';
      nodes.push(mine);
    }

    // ---- Samples at the bottom (only when the app ships some) ----
    if (hasSamples) {
      const nodes = sampleNodes;
      const h = document.createElement('h3');
      h.className = 'lib-section';
      h.textContent = 'Samples';
      nodes.push(h);
      const byLanguage = new Map<string, Node[]>();
      const add = (language: string, node: Node) => {
        if (!byLanguage.has(language)) byLanguage.set(language, []);
        byLanguage.get(language)!.push(node);
      };
      for (const sp of this.samples) {
        const group = document.createElement('div');
        group.className = 'lib-group sample';
        group.append(this.row({ phrase: sp, videoSize: 0, videoSharedBy: 0 }, false));
        for (const t of takes.filter((t) => t.phrase.modelId === sp.id)) group.append(this.row(t, true));
        add(sp.language ?? '', group);
      }
      for (const pend of this.samplesPending) {
        const row = document.createElement('div');
        row.className = 'lib-row sample-pending';
        row.textContent = `${pend.name} — preparing…`;
        add(pend.language, row);
      }
      for (const [language, rows] of byLanguage) {
        if (byLanguage.size > 1 || language) {
          const lh = document.createElement('h4');
          lh.className = 'lib-subhead';
          lh.textContent = language || 'Other';
          nodes.push(lh);
        }
        nodes.push(...rows);
      }
    }

    if (!this.items.length) {
      const p = document.createElement('p');
      p.className = 'library-empty';
      p.textContent = hasSamples
        ? 'No saved phrases yet. Try a sample below, or load a clip, press "Select phrase", pick a sentence and "Save phrase…".'
        : 'No saved phrases yet. Load a clip or record yourself, press "Select phrase", pick a sentence, then "Save phrase…". Then press "Practice" on a Model to record yourself and match it.';
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
    this.list.replaceChildren(...nodes, ...sampleNodes);
  }

  private row(info: PhraseInfo, indented: boolean): HTMLElement {
    const p = info.phrase;
    const row = document.createElement('article');
    const sample = isSampleId(p.id);
    row.className = `lib-row${indented ? ' take' : ''}${sample ? ' sample' : ''}`;
    row.setAttribute('aria-label', `${sample ? 'Sample' : p.role === 'model' ? 'Model' : 'Me'}: ${p.name}`);

    const badge = document.createElement('span');
    badge.className = `badge ${sample ? 'sample' : p.role}`;
    badge.textContent = sample ? 'Sample' : p.role === 'model' ? 'Model' : 'Me';

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
    const date = sample ? 'built in' : new Date(p.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    meta.textContent = [formatTime(p.duration), date, sample ? '' : p.language].filter(Boolean).join(' · ');

    const size = document.createElement('div');
    size.className = 'lib-size';
    const parts = [sample ? (p.credit ?? 'Not stored in your library') : `Audio ${formatBytes(p.audio.size)}`];
    if (info.videoSize) {
      parts.push(
        `Video ${formatBytes(info.videoSize)}${info.videoSharedBy > 1 ? `, shared by ${info.videoSharedBy} phrases` : ''}`,
      );
    }
    size.textContent = parts.join(' · ');

    main.append(name);
    if (p.transcript) {
      const said = document.createElement('p');
      said.className = 'lib-transcript';
      said.textContent = p.transcript;
      if (p.lang) said.lang = p.lang;
      main.append(said);
      if (p.translation) {
        const tr = document.createElement('p');
        tr.className = 'lib-translation';
        tr.textContent = p.translation;
        tr.style.margin = '0';
        main.append(tr);
      }
    }
    main.append(svg, meta, size);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    actions.append(
      this.actionButton('Open', () => {
        this.close();
        this.actions.open(p.id);
      }),
    );
    // Practice: on Models, and on takes that are linked to a Model.
    const linked =
      p.role === 'model' ||
      (!!p.modelId && (this.items.some((i) => i.phrase.id === p.modelId) || this.samples.some((s) => s.id === p.modelId)));
    if (linked) {
      actions.append(
        this.actionButton('Practice', () => {
          this.close();
          this.actions.practice(p.id);
        }),
      );
    }
    actions.append(this.downloadMenu(p, info.videoSize));
    if (sample) {
      // Built-in samples can't be changed or removed.
      row.append(badge, main, actions);
      return row;
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

  /**
   * "Download ▾": the phrase's audio (WAV, just the phrase) and, when the video was kept,
   * the original video file (the whole clip; the phrase starts at the time shown).
   */
  private downloadMenu(p: Phrase, videoSize: number): HTMLElement {
    // Samples download their original file (whatever format it was shipped in).
    const audioName = isSampleId(p.id)
      ? `${safeFileName(p.name)}.${extensionFor(p.audio.type, p.sourceName)}`
      : `${safeFileName(p.name)}.wav`;
    const audio = () => downloadBlob(p.audio, audioName);
    if (!videoSize) {
      const b = this.actionButton('Download', audio);
      b.title = `Save "${audioName}" (${formatBytes(p.audio.size)})`;
      return b;
    }
    const menu = document.createElement('details');
    menu.className = 'dl-menu';
    const summary = document.createElement('summary');
    summary.className = 'secondary small button';
    summary.textContent = 'Download ▾';
    const list = document.createElement('div');
    list.className = 'dl-list';
    const item = (label: string, detail: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dl-item';
      const l = document.createElement('span');
      l.textContent = label;
      const d = document.createElement('span');
      d.className = 'hint';
      d.textContent = detail;
      b.append(l, d);
      b.addEventListener('click', () => {
        menu.open = false;
        onClick();
      });
      return b;
    };
    list.append(
      item('Phrase audio (WAV)', `${formatTime(p.duration)} · ${formatBytes(p.audio.size)}`, audio),
      item('Original video', `whole clip · ${formatBytes(videoSize)} · phrase starts at ${formatTime(p.sourceStart)}`, async () => {
        const src = p.sourceId ? await getSource(p.sourceId) : undefined;
        if (!src) return;
        const base = safeFileName(src.name.replace(/\.[^.]+$/, ''), safeFileName(p.name));
        downloadBlob(src.blob, `${base}.${extensionFor(src.type, src.name)}`);
      }),
    );
    menu.append(summary, list);
    // Close when focus or a click goes elsewhere.
    menu.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!menu.contains(document.activeElement)) menu.open = false;
      }, 0);
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.open) {
        e.stopPropagation(); // don't also close the library
        menu.open = false;
        summary.focus();
      }
    });
    return menu;
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
