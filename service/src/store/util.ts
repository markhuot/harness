import { randomUUID } from "node:crypto";

export const newId = () => randomUUID();

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

/**
 * A TEXT column as a string. A value written from outside the service can be a BLOB (sqlite3's `readfile()` returns
 * one), which bun:sqlite reads back as bytes, and string code (`.trim()`, `.split()`) then throws on it.
 */
export function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return v == null ? "" : String(v);
}
