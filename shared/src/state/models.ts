// Model selection helpers: the per-driver model list cache (fetched from GET /drivers/:id/models and
// shared by every select on screen) and pure option/label derivations. No React here: each client
// wraps ModelListCache in its own hook (useSyncExternalStore).

import type { DriverInfo, DriverModels, ModelInfo, Project, PublicSettings } from "../protocol";
import { DEFAULT_TRIAGE_CHOICE, replaceModels, type TriageChoice } from "../watchers";
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
  /** The Default option (value ""), naming what it resolves to; null when it isn't offered (see onlyDriver) */
  default: ModelOption | null;
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
 * listed default). A driver picked without a model gets a "<driver> default" entry (naming
 * `inheritedModel(driver)` when given, else the list's default), and a model the list doesn't have
 * is kept as "(custom)". `onlyDriver` lists that one driver alone (a ticket mid-run can change its
 * model but not its driver); Default is then only offered when it resolves to that driver.
 */
export function driverModelChoices(
  drivers: ChoiceDriver[],
  models: Record<string, ModelInfo[] | undefined>,
  value: TriageChoice,
  resolved: TriageChoice,
  opts: { defaultLabel?: string; onlyDriver?: string; inheritedModel?: (driver: string) => string | null } = {},
): ChoiceOptions {
  const only = opts.onlyDriver;
  const shown = only ? drivers.filter((d) => d.id === only) : drivers.filter((d) => (d.available && d.authenticated) || d.id === value.driver);
  const keep = only ?? value.driver;
  if (keep && !shown.some((d) => d.id === keep)) shown.push({ id: keep, name: keep, available: false, authenticated: false });
  const flat = shown.length <= 1;
  const name = (id: string) => drivers.find((d) => d.id === id)?.name ?? id;
  const defaultModelName = (driver: string, model: string | null) => {
    const list = models[driver];
    const id = model ?? opts.inheritedModel?.(driver) ?? null;
    return id ? modelName(list, id) : list?.find((m) => m.default)?.name;
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
  const def: ModelOption | null = only && resolved.driver !== only ? null : { value: "", label: parts.length ? `${label} (${parts.join(" · ")})` : label };

  const picked = encodeChoice(value);
  const all = [...(def ? [def] : []), ...groups.flatMap((g) => g.options)];
  const pickedOption = all.find((o) => o.value === picked);
  const selectedLabel = !pickedOption
    ? (def?.label ?? label)
    : pickedOption === def || flat || !value.model
      ? pickedOption.label
      : `${name(value.driver!)} · ${pickedOption.label}`;
  return { default: def, groups, selectedLabel };
}

// ---------------------------------------------------------------------------
// The combined select on tickets, projects and settings: what it shows and what a pick saves
// ---------------------------------------------------------------------------

type ModelSettings = Pick<PublicSettings, "defaultDriver" | "defaultModels">;
type ModelProject = Pick<Project, "defaultDriver" | "defaultModels">;

/** The driver a project's new tickets use: its own default, else the settings default. */
export function projectDriver(project: Pick<Project, "defaultDriver"> | null | undefined, settings: Pick<PublicSettings, "defaultDriver"> | null | undefined): string {
  return project?.defaultDriver || settings?.defaultDriver || "";
}

/** What a ticket's Default resolves to: the project's driver with the model it would inherit there. */
export function ticketResolvedChoice(project: ModelProject | null | undefined, settings: ModelSettings | null | undefined): TriageChoice {
  const driver = projectDriver(project, settings);
  return driver ? { driver, model: inheritedModel(driver, "ticket", project, settings) } : DEFAULT_TRIAGE_CHOICE;
}

/**
 * A ticket's pick in the combined select. It always has a driver, so it shows as Default only
 * when it sits on its project's driver without a model of its own.
 */
export function ticketChoice(ticket: { driver: string; model: string | null }, project: ModelProject | null | undefined, settings: ModelSettings | null | undefined): TriageChoice {
  if (!ticket.model && ticket.driver === projectDriver(project, settings)) return DEFAULT_TRIAGE_CHOICE;
  return { driver: ticket.driver, model: ticket.model };
}

/** The ticket PATCH for a pick. Default puts it back on the project's driver with no model of its own. */
export function ticketChoicePatch(choice: TriageChoice, project: ModelProject | null | undefined, settings: ModelSettings | null | undefined): { driver?: string; model: string | null } {
  const driver = choice.driver ?? projectDriver(project, settings);
  return driver ? { driver, model: choice.model } : { model: null };
}

/**
 * A project's default pick. A pinned driver shows with its model. Without one, a model stored for
 * the settings' driver still shows as that pick; otherwise Default (inherit both from settings).
 */
export function projectChoice(project: ModelProject, settings: ModelSettings | null | undefined): TriageChoice {
  if (project.defaultDriver) return { driver: project.defaultDriver, model: project.defaultModels?.[project.defaultDriver] || null };
  const driver = settings?.defaultDriver;
  const model = driver ? project.defaultModels?.[driver] : null;
  return driver && model ? { driver, model } : DEFAULT_TRIAGE_CHOICE;
}

/** The project PATCH for a pick: the driver, and a models map holding only that driver's model. */
export function projectChoicePatch(choice: TriageChoice, project: ModelProject): { defaultDriver: string | null; defaultModels: Record<string, string | null> } {
  return { defaultDriver: choice.driver, defaultModels: replaceModels(project.defaultModels, choice) };
}

/** Settings' default pick. The driver is always set, so Default means that driver's own default model. */
export function settingsChoice(settings: ModelSettings): TriageChoice {
  const model = settings.defaultModels[settings.defaultDriver] || null;
  return model ? { driver: settings.defaultDriver, model } : DEFAULT_TRIAGE_CHOICE;
}

/** The settings PATCH for a pick. Default keeps the driver and clears the models. */
export function settingsChoicePatch(choice: TriageChoice, settings: ModelSettings): { defaultDriver: string; defaultModels: Record<string, string | null> } {
  const driver = choice.driver ?? settings.defaultDriver;
  return { defaultDriver: driver, defaultModels: replaceModels(settings.defaultModels, { driver, model: choice.model }) };
}

/**
 * The groups a type-ahead query leaves: every word of the query must appear (case-insensitive) in
 * the option's label, its model id, or its driver's name, so "claude op" finds Opus under Claude
 * Code and "gpt" finds gpt-4o by id. Groups with no match are dropped; an empty query keeps all.
 */
export function filterChoiceGroups(groups: ChoiceGroup[], query: string, driverNames: Record<string, string> = {}): ChoiceGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  return groups
    .map((g) => {
      const driver = `${g.label ?? ""} ${driverNames[g.driver] ?? ""} ${g.driver}`;
      const options = g.options.filter((o) => {
        const hay = `${o.label} ${decodeChoice(o.value).model ?? ""} ${driver}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      return { ...g, options };
    })
    .filter((g) => g.options.length > 0);
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
