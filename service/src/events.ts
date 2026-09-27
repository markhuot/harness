// In-process typed event bus for HarnessEvent.

import type { HarnessEvent } from "@harness/shared";

export type HarnessEventKind = HarnessEvent["kind"];
export type EventOf<K extends HarnessEventKind> = Extract<HarnessEvent, { kind: K }>;
export type Listener = (event: HarnessEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private kindListeners = new Map<HarnessEventKind, Set<(e: HarnessEvent) => void>>();

  emit(event: HarnessEvent) {
    for (const l of [...this.listeners]) safe(l, event);
    const set = this.kindListeners.get(event.kind);
    if (set) for (const l of [...set]) safe(l, event);
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to one event kind. */
  onKind<K extends HarnessEventKind>(kind: K, listener: (e: EventOf<K>) => void): () => void {
    let set = this.kindListeners.get(kind);
    if (!set) this.kindListeners.set(kind, (set = new Set()));
    const l = listener as (e: HarnessEvent) => void;
    set.add(l);
    return () => set!.delete(l);
  }

  get listenerCount() {
    let n = this.listeners.size;
    for (const s of this.kindListeners.values()) n += s.size;
    return n;
  }
}

function safe(l: Listener, e: HarnessEvent) {
  try {
    l(e);
  } catch (err) {
    console.error("[events] listener failed", err);
  }
}
