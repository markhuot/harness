import type { ListenSetting, PublicSettings, Settings } from "@harness/shared";
import { branchNameError, CLASSIFIER_BACKENDS, DEFAULT_BASE_BRANCH, LISTEN_MODES, PERMISSION_MODES } from "@harness/shared";
import { badRequest } from "./errors";

export const DEFAULT_SETTINGS: Settings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: {},
  reviewModels: {},
  watcherDriver: null,
  watcherModels: {},
  anthropicApiKey: null,
  listen: { mode: "localhost" },
  baseBranch: DEFAULT_BASE_BRANCH,
};

/**
 * A branch name from a request body, trimmed. null / "" → null (inherit) when `nullable`,
 * otherwise refused. Invalid names (git check-ref-format --branch rules) are refused.
 */
export function validateBranchName(field: string, value: unknown, nullable = true): string | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    if (nullable) return null;
    throw badRequest(`${field} must be a branch name`);
  }
  if (typeof value !== "string") throw badRequest(`${field} must be a branch name${nullable ? " or null" : ""}`);
  const name = value.trim();
  const error = branchNameError(name);
  if (error) throw badRequest(`${field} "${name}" isn't a valid branch name: ${error}`);
  return name;
}

/**
 * The pre-PermissionMode setting (claude-code CLI modes), still accepted from older clients.
 * Same translation as migration 4: auto → auto, dontAsk → read_only (it denies anything not
 * pre-approved, i.e. every write), acceptEdits / bypassPermissions / anything else → ask.
 */
export function legacyPermissionMode(value: unknown): Settings["permissionMode"] {
  return value === "auto" ? "auto" : value === "dontAsk" ? "read_only" : "ask";
}

export function toPublicSettings(s: Settings): PublicSettings {
  const { anthropicApiKey, ...rest } = s;
  return { ...rest, anthropicApiKeySet: !!anthropicApiKey };
}

/** Merge stored values over defaults, ignoring unknown/invalid stored keys. */
export function resolveSettings(stored: Record<string, unknown>): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  try {
    Object.assign(out, validateSettingsPatch(pick(stored)));
  } catch {
    // one bad stored value shouldn't take the whole service down; validate per key instead
    for (const [k, v] of Object.entries(pick(stored))) {
      try {
        Object.assign(out, validateSettingsPatch({ [k]: v }));
      } catch {}
    }
  }
  out.defaultModels = mergeModelMap({}, out.defaultModels);
  out.reviewModels = mergeModelMap({}, out.reviewModels);
  out.watcherModels = mergeModelMap({}, out.watcherModels ?? {});
  return out;
}

function pick(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k in DEFAULT_SETTINGS));
}

/** Validate a PATCH /settings body. Unknown keys are rejected. */
export function validateSettingsPatch(body: unknown, knownDrivers?: string[]): Partial<Settings> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("settings body must be an object");
  const out: Partial<Settings> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    switch (key) {
      case "defaultDriver":
        if (typeof value !== "string" || !value) throw badRequest("defaultDriver must be a non-empty string");
        if (knownDrivers && !knownDrivers.includes(value)) throw badRequest(`Unknown driver: ${value}`);
        out.defaultDriver = value;
        break;
      case "maxConcurrentRuns":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 64)
          throw badRequest("maxConcurrentRuns must be an integer between 1 and 64");
        out.maxConcurrentRuns = value;
        break;
      case "permissionMode":
        if (!(PERMISSION_MODES as readonly unknown[]).includes(value)) throw badRequest(`permissionMode must be one of ${PERMISSION_MODES.join(", ")}`);
        out.permissionMode = value as Settings["permissionMode"];
        break;
      case "claudePermissionMode":
        // Older app builds; an explicit permissionMode in the same body wins.
        if (!("permissionMode" in (body as object))) out.permissionMode = legacyPermissionMode(value);
        break;
      case "classifier":
        if (!(CLASSIFIER_BACKENDS as readonly unknown[]).includes(value)) throw badRequest(`classifier must be one of ${CLASSIFIER_BACKENDS.join(", ")}`);
        out.classifier = value as Settings["classifier"];
        break;
      case "watcherDriver":
        // null / "" → follow defaultDriver
        if (value !== null && value !== "" && typeof value !== "string") throw badRequest("watcherDriver must be a driver id or null");
        if (value && knownDrivers && !knownDrivers.includes(value as string)) throw badRequest(`Unknown driver: ${value}`);
        out.watcherDriver = (value as string) || null;
        break;
      case "defaultModels":
      case "reviewModels":
      case "watcherModels":
        out[key] = validateModelMap(key, value, knownDrivers);
        break;
      case "anthropicApiKey":
        if (value !== null && typeof value !== "string") throw badRequest("anthropicApiKey must be a string or null");
        out.anthropicApiKey = value ? (value as string).trim() || null : null;
        break;
      case "listen":
        out.listen = validateListen(value);
        break;
      case "baseBranch":
        out.baseBranch = validateBranchName("baseBranch", value, false)!;
        break;
      case "anthropicApiKeySet":
        break; // echoed back from PublicSettings; ignore
      default:
        throw badRequest(`Unknown setting: ${key}`);
    }
  }
  return out;
}

const HOSTNAME = /^[A-Za-z0-9.:%_-]{1,253}$/;

/** { mode, host? }: host is required for "custom" (a hostname or IP, no scheme/port) and dropped otherwise. */
export function validateListen(value: unknown): ListenSetting {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("listen must be an object { mode, host? }");
  const { mode, host } = value as { mode?: unknown; host?: unknown };
  if (!(LISTEN_MODES as readonly unknown[]).includes(mode)) throw badRequest(`listen.mode must be one of ${LISTEN_MODES.join(", ")}`);
  if (mode !== "custom") return { mode: mode as ListenSetting["mode"] };
  if (typeof host !== "string" || !host.trim()) throw badRequest("listen.host is required for custom mode");
  const h = host.trim().replace(/^\[(.*)\]$/, "$1");
  if (!HOSTNAME.test(h)) throw badRequest("listen.host must be a hostname or IP address (no scheme or port)");
  return { mode: "custom", host: h };
}

const MODEL_ID = /^[^\s]{1,200}$/;

/** A model id as accepted from clients: trimmed, non-empty, no whitespace. null / "" → null. */
export function validateModelId(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw badRequest(`${field} must be a string or null`);
  const id = value.trim();
  if (!id) return null;
  if (!MODEL_ID.test(id)) throw badRequest(`${field} must be a model id without spaces`);
  return id;
}

/** { driverId: modelId | null }. Keys must be known drivers when the list is given. */
export function validateModelMap(field: string, value: unknown, knownDrivers?: string[]): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${field} must be an object of driver id → model id`);
  const out: Record<string, string | null> = {};
  for (const [driver, model] of Object.entries(value as Record<string, unknown>)) {
    // Clearing (null / "") is fine for any key, so an entry left by a removed driver can be dropped.
    if (knownDrivers && !knownDrivers.includes(driver) && model !== null && model !== "") throw badRequest(`Unknown driver in ${field}: ${driver}`);
    out[driver] = validateModelId(`${field}.${driver}`, model);
  }
  return out;
}

/** Merge a per-driver model patch over the current map; null entries remove a driver. */
export function mergeModelMap(current: Record<string, string | null>, patch: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [driver, model] of Object.entries({ ...current, ...patch })) if (model) out[driver] = model;
  return out;
}

/** Apply a validated PATCH /settings over the current settings (model maps merge per driver). */
export function applySettingsPatch(current: Settings, patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = { ...patch };
  if (patch.defaultModels) out.defaultModels = mergeModelMap(current.defaultModels, patch.defaultModels);
  if (patch.reviewModels) out.reviewModels = mergeModelMap(current.reviewModels, patch.reviewModels);
  if (patch.watcherModels) out.watcherModels = mergeModelMap(current.watcherModels ?? {}, patch.watcherModels);
  return out;
}
