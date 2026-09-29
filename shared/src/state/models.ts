// Model selection helpers: the per-driver model list cache (fetched from GET /drivers/:id/models and
// shared by every select on screen) and pure option/label derivations. No React here: each client
// wraps ModelListCache in its own hook (useSyncExternalStore).

import type { DriverInfo, DriverModels, ModelInfo, Project, PublicSettings } from "../protocol";
import type { TriageChoice } from "../watchers";
import type { HarnessClient } from "../client";

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
// Combined driver + model select (watchers): models grouped under their driver
// ---------------------------------------------------------------------------

const SEP = "\u0001";

/** A TriageChoice as a <select> value: "" for Default, else "driver\u0001model" ("driver\u0001" → the driver's default). */
export function encodeChoice(c: TriageChoice): string {
  return c.driver ? `${c.driver}${SEP}${c.model ?? ""}` : "";
}

export function decodeChoice(v: string): TriageChoice {
  if (!v) return { driver: null, model: null };
  const i = v.indexOf(SEP);
  if (i < 0) return { driver: v, model: null };
  return { driver: v.slice(0, i), model: v.slice(i + 1) || null };
}

export interface ChoiceGroup {
  driver: string;
  /** The driver's name, or null when the list collapses to one driver (no group heading) */
  label: string | null;
  options: ModelOption[];
}

export interface ChoiceOptions {
  /** The Default option (value ""), naming what it resolves to */
  default: ModelOption;
  groups: ChoiceGroup[];
  /** Label of the picked option (for triggers that show text, like the iOS menu) */
  selectedLabel: string;
}

type ChoiceDriver = Pick<DriverInfo, "id" | "name" | "available" | "authenticated">;

/**
 * Options for the combined Model select. Drivers that are installed and signed in each get a
 * group of their models; the picked driver is kept even when it isn't signed in, so the select
 * never hides the current value. With a single group the heading is dropped and the models show as
 * a flat list. `resolved` is what Default falls back to (driver + model; model null → the driver's
 * listed default). A driver picked without a model gets a "<driver> default" entry, and a model the
 * list doesn't have is kept as "(custom)".
 */
export function driverModelChoices(
  drivers: ChoiceDriver[],
  models: Record<string, ModelInfo[] | undefined>,
  value: TriageChoice,
  resolved: TriageChoice,
  opts: { defaultLabel?: string } = {},
): ChoiceOptions {
  const shown = drivers.filter((d) => (d.available && d.authenticated) || d.id === value.driver);
  if (value.driver && !shown.some((d) => d.id === value.driver)) shown.push({ id: value.driver, name: value.driver, available: false, authenticated: false });
  const flat = shown.length <= 1;
  const name = (id: string) => drivers.find((d) => d.id === id)?.name ?? id;
  const defaultModelName = (driver: string, model: string | null) => {
    const list = models[driver];
    return model ? modelName(list, model) : list?.find((m) => m.default)?.name;
  };

  const groups: ChoiceGroup[] = shown.map((d) => {
    const list = models[d.id] ?? [];
    const options: ModelOption[] = [];
    if (value.driver === d.id && !value.model) {
      const fallback = defaultModelName(d.id, null);
      options.push({ value: encodeChoice({ driver: d.id, model: null }), label: fallback ? `${d.name} default (${fallback})` : `${d.name} default` });
    }
    for (const m of list) options.push({ value: encodeChoice({ driver: d.id, model: m.id }), label: m.name });
    if (value.driver === d.id && value.model && !list.some((m) => m.id === value.model)) options.push({ value: encodeChoice(value), label: `${value.model} (custom)` });
    return { driver: d.id, label: flat ? null : d.name, options };
  });

  const label = opts.defaultLabel ?? "Default";
  const parts = resolved.driver ? [flat && shown[0]?.id === resolved.driver ? null : name(resolved.driver), defaultModelName(resolved.driver, resolved.model)].filter(Boolean) : [];
  const def: ModelOption = { value: "", label: parts.length ? `${label} (${parts.join(" · ")})` : label };

  const picked = encodeChoice(value);
  const all = [def, ...groups.flatMap((g) => g.options)];
  const pickedOption = all.find((o) => o.value === picked);
  const selectedLabel = !pickedOption
    ? def.label
    : pickedOption === def || flat || !value.model
      ? pickedOption.label
      : `${name(value.driver!)} · ${pickedOption.label}`;
  return { default: def, groups, selectedLabel };
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

  /** Bumped on every change; a stable snapshot for hooks that read several drivers at once. */
  version = 0;

  private emit() {
    this.version++;
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
