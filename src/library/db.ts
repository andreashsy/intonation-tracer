// Phrase library in IndexedDB (M1 spec §6). Phrases reference shared video sources,
// so several phrases cut from one video store it once.

export type Role = 'model' | 'me';

export interface Phrase {
  id: string;
  name: string;
  role: Role;
  language?: string;
  modelId?: string;
  createdAt: number;
  duration: number;
  audio: Blob;
  f0: Float32Array;
  hopSeconds: number;
  frameCenterOffset: number;
  medianF0: number;
  voiceRange: { minF0: number; maxF0: number };
  sourceId?: string;
  sourceStart: number;
  sourceName: string;
}

export interface Source {
  id: string;
  name: string;
  type: string;
  size: number;
  lastModified: number; // kept so a re-opened source has the same id when saved again
  blob: Blob;
}

/** Library entry with the size info the UI needs. */
export interface PhraseInfo {
  phrase: Phrase;
  videoSize: number; // 0 if no video
  videoSharedBy: number; // phrases using the same source
}

const DB_NAME = 'intonation-tracer';
const VERSION = 1;

export class LibraryUnavailable extends Error {}
export class LibraryFull extends Error {}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, VERSION);
    } catch {
      reject(new LibraryUnavailable());
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('phrases')) {
        db.createObjectStore('phrases', { keyPath: 'id' }).createIndex('role', 'role');
      }
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new LibraryUnavailable());
    req.onblocked = () => reject(new LibraryUnavailable());
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** True if IndexedDB can be opened here (fails in some private windows). */
export async function libraryAvailable(): Promise<boolean> {
  try {
    await open();
    return true;
  } catch {
    return false;
  }
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => {
      const name = tx.error?.name ?? '';
      reject(name === 'QuotaExceededError' ? new LibraryFull() : (tx.error ?? new Error('Library error')));
    };
  });
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function sourceKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** Saves a phrase, storing its video source once if given. */
export async function savePhrase(phrase: Phrase, video?: File): Promise<void> {
  const db = await open();
  const tx = db.transaction(['phrases', 'sources'], 'readwrite');
  if (video) {
    const id = sourceKey(video);
    const sources = tx.objectStore('sources');
    const existing = await req(sources.getKey(id));
    if (existing === undefined) {
      sources.put({
        id,
        name: video.name,
        type: video.type,
        size: video.size,
        lastModified: video.lastModified,
        blob: video,
      } satisfies Source);
    }
    phrase.sourceId = id;
  }
  tx.objectStore('phrases').put(phrase);
  await done(tx);
  // Ask the browser not to evict the library under storage pressure (best effort).
  void navigator.storage?.persist?.().catch(() => {});
}

export async function listPhrases(): Promise<PhraseInfo[]> {
  const db = await open();
  const tx = db.transaction(['phrases', 'sources'], 'readonly');
  const phrases = (await req(tx.objectStore('phrases').getAll())) as Phrase[];
  // Read only the size of each source (not the blob into memory beyond what IDB returns lazily).
  const sizes = new Map<string, number>();
  const users = new Map<string, number>();
  for (const p of phrases) if (p.sourceId) users.set(p.sourceId, (users.get(p.sourceId) ?? 0) + 1);
  for (const id of users.keys()) {
    const s = (await req(tx.objectStore('sources').get(id))) as Source | undefined;
    sizes.set(id, s?.size ?? 0);
  }
  phrases.sort((a, b) => b.createdAt - a.createdAt);
  return phrases.map((p) => ({
    phrase: p,
    videoSize: p.sourceId ? (sizes.get(p.sourceId) ?? 0) : 0,
    videoSharedBy: p.sourceId ? (users.get(p.sourceId) ?? 1) : 0,
  }));
}

export async function getPhrase(id: string): Promise<Phrase | undefined> {
  const db = await open();
  return (await req(db.transaction('phrases').objectStore('phrases').get(id))) as Phrase | undefined;
}

export async function getSource(id: string): Promise<Source | undefined> {
  const db = await open();
  return (await req(db.transaction('sources').objectStore('sources').get(id))) as Source | undefined;
}

/** Updates fields of a saved phrase (e.g. its trace after re-analysis with a new voice range). */
export async function updatePhrase(id: string, patch: Partial<Omit<Phrase, 'id'>>): Promise<void> {
  const db = await open();
  const tx = db.transaction('phrases', 'readwrite');
  const store = tx.objectStore('phrases');
  const p = (await req(store.get(id))) as Phrase | undefined;
  if (p) store.put({ ...p, ...patch });
  await done(tx);
}

/** Total bytes the library stores: phrase audio plus each source once. */
export function totalBytes(items: PhraseInfo[]): number {
  let total = 0;
  const counted = new Set<string>();
  for (const { phrase, videoSize } of items) {
    total += phrase.audio.size + phrase.f0.byteLength;
    if (phrase.sourceId && !counted.has(phrase.sourceId)) {
      counted.add(phrase.sourceId);
      total += videoSize;
    }
  }
  return total;
}

/** Detaches the video from a phrase; deletes the source if nothing else uses it. Returns bytes freed. */
export async function removeVideo(phraseId: string): Promise<number> {
  return detach(phraseId, false);
}

/** Deletes a phrase (and its source if unused). Unlinks Me phrases that pointed at it. Returns bytes freed. */
export async function deletePhrase(phraseId: string): Promise<number> {
  return detach(phraseId, true);
}

async function detach(phraseId: string, deleteIt: boolean): Promise<number> {
  const db = await open();
  const tx = db.transaction(['phrases', 'sources'], 'readwrite');
  const phrases = tx.objectStore('phrases');
  const sources = tx.objectStore('sources');
  const p = (await req(phrases.get(phraseId))) as Phrase | undefined;
  let freed = 0;
  if (p) {
    const all = (await req(phrases.getAll())) as Phrase[];
    if (p.sourceId) {
      const othersUsing = all.some((q) => q.id !== p.id && q.sourceId === p.sourceId);
      if (!othersUsing) {
        const s = (await req(sources.get(p.sourceId))) as Source | undefined;
        freed += s?.size ?? 0;
        sources.delete(p.sourceId);
      }
    }
    if (deleteIt) {
      freed += p.audio.size + p.f0.byteLength;
      phrases.delete(p.id);
      for (const q of all) {
        if (q.modelId === p.id) phrases.put({ ...q, modelId: undefined });
      }
    } else {
      phrases.put({ ...p, sourceId: undefined });
    }
  }
  await done(tx);
  return freed;
}
