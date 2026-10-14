import { randomBytes, randomUUID } from "node:crypto";

/**
 * Where the service gets "the time" and "a new id". Production uses the real clock and random ids;
 * a test installs fixed ones with `useRuntime` so timestamps and ids are reproducible. The
 * stores and the orchestrator stamp and identify data through `now()`, `newId()` and
 * `newToken()`; the watchers, websocket ids, the auth token in config and the claude-code and copilot
 * drivers still use the real clock and random ids directly.
 */
export interface Runtime {
  now(): number;
  newId(): string;
  /** A random hex secret of `bytes` bytes (MCP tokens, auth tokens). */
  newToken(bytes: number): string;
}

const realRuntime: Runtime = {
  now: () => Date.now(),
  newId: () => randomUUID(),
  newToken: (bytes) => randomBytes(bytes).toString("hex"),
};

let runtime: Runtime = realRuntime;

/** Replace the clock and id source (any part); returns a function that puts the previous one back. */
export function useRuntime(next: Partial<Runtime>): () => void {
  const prev = runtime;
  runtime = { ...prev, ...next };
  return () => {
    runtime = prev;
  };
}

export const newId = () => runtime.newId();
export const now = () => runtime.now();
export const newToken = (bytes: number) => runtime.newToken(bytes);

export function toJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

export function fromJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const bool = (v: unknown) => v === 1 || v === true;
export const int = (v: boolean) => (v ? 1 : 0);
