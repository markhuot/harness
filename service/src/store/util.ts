import { randomUUID } from "node:crypto";

export const newId = () => randomUUID();
export const now = () => Date.now();

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
