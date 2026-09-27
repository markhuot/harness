// Model selection helpers: the per-driver model list (fetched from GET /drivers/:id/models and
// shared by every select on screen) and pure option/label derivations.

import { useEffect, useSyncExternalStore } from "react";
import type { DriverModels, HarnessClient, ModelInfo, Project, PublicSettings } from "@harness/shared";

export interface ModelOption {
  /** "" is the inherit / default option (sent as null) */
  value: string;
  label: string;
}

/** Display name for a model id: the list's name, else the id itself. */
export function modelName(models: ModelInfo[] | undefined, id: string): string {
  return models?.find((m) => m.id === id)?.name ?? id;
}

/**
 * The model a null choice falls back to, one level up from where the select sits:
 * ticket → project default → settings default (→ driver default, returned as null).
 */
export function inheritedModel(
  driver: string,
  level: "ticket" | "project" | "settings",
  project: Pick<Project, "defaultModels"> | null | undefined,
  settings: Pick<PublicSettings, "defaultModels"> | null | undefined,
): string | null {
  if (level === "ticket" && project?.defaultModels?.[driver]) return project.defaultModels[driver]!;
  if (level !== "settings" && settings?.defaultModels?.[driver]) return settings.defaultModels[driver]!;
  return null;
}

/**
 * Options for a model <select>: "Default (<what null resolves to>)" first, then the driver's
 * models (its own default marked), then the current value if the list doesn't have it
 * (a custom id, or the list failed to load) so the select never silently shows another model.
 */
export function modelOptions(
  models: ModelInfo[] | undefined,
  value: string | null,
  opts: { inherited?: string | null; defaultLabel?: string; /** don't name what the default resolves to */ plainDefault?: boolean } = {},
): ModelOption[] {
  const list = models ?? [];
  const label = opts.defaultLabel ?? "Default";
  const fallsBackTo = opts.plainDefault ? undefined : opts.inherited ? modelName(list, opts.inherited) : list.find((m) => m.default)?.name;
  const out: ModelOption[] = [{ value: "", label: fallsBackTo ? `${label} (${fallsBackTo})` : label }];
  for (const m of list) out.push({ value: m.id, label: m.default ? `${m.name} · default` : m.name });
  if (value && !list.some((m) => m.id === value)) out.push({ value, label: `${value} (custom)` });
  return out;
}

/** A model badge is only worth showing when the ticket picked a model itself. */
export function ticketModelBadge(model: string | null, models: ModelInfo[] | undefined): string | null {
  return model ? modelName(models, model) : null;
}

// ---------------------------------------------------------------------------
// Shared per-driver cache (one fetch per driver however many selects are mounted)
// ---------------------------------------------------------------------------

export interface ModelListState {
  data: DriverModels | null;
  loading: boolean;
  /** Request failure (network / unknown driver); driver failures arrive as data.error */
  error: string | null;
}

const EMPTY: ModelListState = { data: null, loading: false, error: null };

export class ModelListCache {
  private entries = new Map<string, ModelListState>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private epoch = 0;

  constructor(private readonly fetchModels: (driverId: string, refresh: boolean) => Promise<DriverModels>) {}

  get(driverId: string): ModelListState {
    return this.entries.get(driverId) ?? EMPTY;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Fetch unless already loaded (or loading); refresh forces a service-side re-query. */
  load(driverId: string, refresh = false): Promise<void> {
    if (!driverId) return Promise.resolve();
    const cur = this.get(driverId);
    if (!refresh && (cur.data || cur.error)) return Promise.resolve();
    const pending = this.inflight.get(driverId);
    if (pending && !refresh) return pending;
    this.set(driverId, { ...cur, loading: true });
    const p = this.fetchModels(driverId, refresh)
      .then((data) => this.set(driverId, { data, loading: false, error: null }))
      .catch((err) => this.set(driverId, { data: cur.data, loading: false, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => this.inflight.delete(driverId));
    this.inflight.set(driverId, p);
    return p;
  }

  /** A new connection epoch (reconnect) makes every cached list stale. */
  syncEpoch(epoch: number) {
    if (epoch <= this.epoch) return;
    this.epoch = epoch;
    this.entries.clear();
    this.inflight.clear();
  }

  private set(driverId: string, s: ModelListState) {
    this.entries.set(driverId, s);
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

const caches = new WeakMap<HarnessClient, ModelListCache>();

export function modelCacheFor(client: HarnessClient): ModelListCache {
  let c = caches.get(client);
  if (!c) {
    c = new ModelListCache((id, refresh) => client.listModels(id, { refresh }));
    caches.set(client, c);
  }
  return c;
}

/** The model list for a driver; refetches when the driver (or the connection epoch) changes. */
export function useDriverModels(client: HarnessClient, driverId: string, epoch = 0) {
  const cache = modelCacheFor(client);
  const state = useSyncExternalStore(cache.subscribe, () => cache.get(driverId));
  useEffect(() => {
    cache.syncEpoch(epoch);
    void cache.load(driverId);
  }, [cache, driverId, epoch]);
  return { ...state, refresh: () => cache.load(driverId, true) };
}
