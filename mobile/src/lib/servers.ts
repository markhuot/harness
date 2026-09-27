// Saved-server list operations (pure). A server is identified by its base URL: pairing the same
// Mac again replaces its token instead of adding a duplicate.

import type { SavedServer } from "./storage";
import { displayHost } from "./pair";

export function upsertServer(list: SavedServer[], baseUrl: string, now: number, makeId: () => string): { list: SavedServer[]; server: SavedServer; added: boolean } {
  const existing = list.find((s) => s.baseUrl === baseUrl);
  if (existing) return { list, server: existing, added: false };
  const server: SavedServer = { id: makeId(), name: displayHost(baseUrl), baseUrl, addedAt: now };
  return { list: [...list, server], server, added: true };
}

export function removeServer(list: SavedServer[], id: string, activeId: string | null): { list: SavedServer[]; active: string | null } {
  const next = list.filter((s) => s.id !== id);
  return { list: next, active: activeId === id ? (next[0]?.id ?? null) : activeId };
}

export function renameServer(list: SavedServer[], id: string, name: string): SavedServer[] {
  const n = name.trim();
  return list.map((s) => (s.id === id ? { ...s, name: n || displayHost(s.baseUrl) } : s));
}
