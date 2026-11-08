// A tiny store: one status value plus subscribers.

export type Status =
  | { kind: 'empty'; error?: string }
  | { kind: 'loading'; step: 'decoding' | 'analyzing'; progress: number }
  | { kind: 'recording'; live: boolean } // live: false while waiting for mic permission
  | { kind: 'ready' }
  | { kind: 'practice' };

type Listener = (status: Status) => void;

let status: Status = { kind: 'empty' };
const listeners = new Set<Listener>();

export function getStatus(): Status {
  return status;
}

export function setStatus(next: Status): void {
  status = next;
  for (const l of listeners) l(status);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}
