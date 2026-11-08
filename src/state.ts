// A tiny store: one status value plus subscribers.

export type Status =
  | { kind: 'empty'; error?: string }
  | { kind: 'loading'; step: 'decoding' | 'analyzing'; progress: number }
  // waiting: asking for mic permission · ready: mic open, waiting for Start · live: recording
  | { kind: 'recording'; phase: 'waiting' | 'ready' | 'live' }
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
