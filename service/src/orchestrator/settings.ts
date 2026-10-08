import type { ListenSetting, NotificationSettings, PhaseModels, PhaseModelsPatch, PromptId, PublicSettings, Settings } from "@harness/shared";
import { applyLegacySettings, legacySettingsFields, mergePhaseModels, PHASES, DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_CATEGORIES, branchNameError, CLASSIFIER_BACKENDS, DEFAULT_BASE_BRANCH, DEFAULT_BROWSER_IDLE_TAB_MINUTES, MAX_BROWSER_IDLE_TAB_MINUTES, LISTEN_MODES, PERMISSION_MODES, PROMPT_IDS, RENAMED_PROMPT_IDS } from "@harness/shared";
import { badRequest } from "./errors";
import { isPromptId, promptTemplateError } from "./prompt-templates";

/** Every prompt id unset: runs use the built-in prompts. */
function unsetPrompts(): Record<PromptId, string | null> {
  return Object.fromEntries(PROMPT_IDS.map((id) => [id, null])) as Record<PromptId, string | null>;
}

export const DEFAULT_SETTINGS: Settings = {
  phaseModels: {},
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  permissionMode: "auto",
  classifier: "claude-cli",
  defaultModels: {},
  reviewModels: {},
  watcherDriver: null,
  watcherModels: {},
  anthropicApiKey: null,
  claudeOauthToken: null,
  copilotGithubToken: null,
  listen: { mode: "localhost" },
  baseBranch: DEFAULT_BASE_BRANCH,
  browserIdleTabMinutes: DEFAULT_BROWSER_IDLE_TAB_MINUTES,
  prompts: unsetPrompts(),
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
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
  const { anthropicApiKey, claudeOauthToken, copilotGithubToken, ...rest } = s;
  return { ...rest, anthropicApiKeySet: !!anthropicApiKey, claudeOauthTokenSet: !!claudeOauthToken, copilotGithubTokenSet: !!copilotGithubToken };
}

/** The settings keys that were the app's model choice before per-phase choices (now derived from phaseModels). */
export const LEGACY_MODEL_KEYS = ["defaultDriver", "defaultModels", "reviewModels"] as const;

/** A validated PATCH /settings: settings, except phaseModels is a per-phase patch (null clears). */
export type SettingsUpdate = Partial<Omit<Settings, "phaseModels">> & { phaseModels?: PhaseModelsPatch };

/**
 * Merge stored values over defaults, ignoring unknown/invalid stored keys. Legacy model keys still
 * in storage (written before migration 38, or straight to the store) apply over phaseModels, and
 * the legacy fields are then derived from the result.
 */
export function resolveSettings(stored: Record<string, unknown>): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  const { prompts, phaseModels, defaultDriver, defaultModels, reviewModels, ...rest } = pick(stored);
  const validate = (values: Record<string, unknown>): SettingsUpdate => {
    try {
      return validateSettingsPatch(values);
    } catch {
      // one bad stored value shouldn't take the whole service down; validate per key instead
      const ok: SettingsUpdate = {};
      for (const [k, v] of Object.entries(values)) {
        try {
          Object.assign(ok, validateSettingsPatch({ [k]: v }));
        } catch {}
      }
      return ok;
    }
  };
  const { phaseModels: _pm, ...valid } = validate(rest);
  Object.assign(out, valid);
  const legacy = validate(Object.fromEntries(Object.entries({ defaultDriver, defaultModels, reviewModels }).filter(([, v]) => v !== undefined)));
  out.phaseModels = applyLegacySettings(storedPhaseModels(phaseModels), legacy);
  Object.assign(out, legacySettingsFields(out.phaseModels));
  out.watcherModels = mergeModelMap({}, out.watcherModels ?? {});
  out.prompts = resolvePrompts(prompts);
  return out;
}

/** Stored phaseModels, keeping each phase that still validates. */
function storedPhaseModels(value: unknown): PhaseModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: PhaseModels = {};
  for (const [phase, choice] of Object.entries(value as Record<string, unknown>)) {
    try {
      Object.assign(out, mergePhaseModels({}, validatePhaseModels("phaseModels", { [phase]: choice })));
    } catch {}
  }
  return out;
}

/**
 * Stored prompt overrides over every id unset. Ids this version doesn't have are dropped; an
 * override that no longer validates (it names a variable the prompt lost, say) is kept, so the
 * user's text survives, and runs use the built-in until it's fixed (renderPrompt, GET /prompts).
 */
function resolvePrompts(stored: unknown): Record<PromptId, string | null> {
  const out = unsetPrompts();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  const entries = Object.entries(stored as Record<string, unknown>);
  // An override saved under a prompt's old id applies to its new one (unless that has its own).
  for (const [old, id] of Object.entries(RENAMED_PROMPT_IDS)) {
    const text = (stored as Record<string, unknown>)[old];
    if (typeof text === "string" && text.trim() && !(stored as Record<string, unknown>)[id]) out[id] = text;
  }
  for (const [id, text] of entries) {
    if (isPromptId(id) && typeof text === "string" && text.trim()) out[id] = text;
  }
  return out;
}

/**
 * { promptId: template | null }. null / blank → the built-in. Unknown ids and invalid templates are
 * refused, except an override sent back exactly as `current` has it: clients may echo the whole
 * settings object, and one that went stale in an update mustn't block saving other settings.
 */
export function validatePrompts(value: unknown, current?: Settings["prompts"]): Partial<Record<PromptId, string | null>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("prompts must be an object of prompt id → template text or null");
  const out: Partial<Record<PromptId, string | null>> = {};
  for (const [sent, text] of Object.entries(value as Record<string, unknown>)) {
    // A renamed prompt's old id (an older client, a saved settings file) means its new one.
    const id = RENAMED_PROMPT_IDS[sent] ?? sent;
    if (!isPromptId(id)) throw badRequest(`Unknown prompt: ${id} (GET /prompts lists them)`);
    if (text === null || (typeof text === "string" && !text.trim())) {
      out[id] = null;
      continue;
    }
    if (typeof text !== "string") throw badRequest(`prompts.${id} must be template text or null`);
    if (current?.[id] === text) continue;
    const error = promptTemplateError(id, text);
    if (error) throw badRequest(`prompts.${id}: ${error}`);
    out[id] = text;
  }
  return out;
}

function pick(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k in DEFAULT_SETTINGS));
}

/** Validate a PATCH /settings body. Unknown keys are rejected. */
export function validateSettingsPatch(body: unknown, knownDrivers?: string[], current?: Settings): SettingsUpdate {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("settings body must be an object");
  const out: SettingsUpdate = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    switch (key) {
      case "phaseModels":
        out.phaseModels = validatePhaseModels("phaseModels", value, knownDrivers);
        break;
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
      case "browserIdleTabMinutes":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_BROWSER_IDLE_TAB_MINUTES)
          throw badRequest(`browserIdleTabMinutes must be an integer between 0 (never) and ${MAX_BROWSER_IDLE_TAB_MINUTES}`);
        out.browserIdleTabMinutes = value;
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
      case "claudeOauthToken":
        if (value !== null && typeof value !== "string") throw badRequest("claudeOauthToken must be a string or null");
        out.claudeOauthToken = value ? (value as string).trim() || null : null;
        break;
      case "copilotGithubToken":
        if (value !== null && typeof value !== "string") throw badRequest("copilotGithubToken must be a string or null");
        out.copilotGithubToken = value ? (value as string).trim() || null : null;
        break;
      case "listen":
        out.listen = validateListen(value);
        break;
      case "baseBranch":
        out.baseBranch = validateBranchName("baseBranch", value, false)!;
        break;
      case "prompts":
        out.prompts = validatePrompts(value, current?.prompts);
        break;
      case "notifications":
        out.notifications = validateNotifications(value, current?.notifications);
        break;
      case "anthropicApiKeySet":
      case "claudeOauthTokenSet":
      case "copilotGithubTokenSet":
        break; // echoed back from PublicSettings; ignore
      default:
        throw badRequest(`Unknown setting: ${key}`);
    }
  }
  return out;
}

/**
 * A partial { enabled, categories, apnsKeyDir, apnsTeamId } merged over `current` (categories per
 * category), so a client can flip one switch without sending the rest.
 */
export function validateNotifications(value: unknown, current: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS): NotificationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("notifications must be an object");
  const out: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS, ...current, categories: { ...DEFAULT_NOTIFICATION_SETTINGS.categories, ...current.categories } };
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    switch (key) {
      case "enabled":
        if (typeof v !== "boolean") throw badRequest("notifications.enabled must be true or false");
        out.enabled = v;
        break;
      case "categories":
        if (!v || typeof v !== "object" || Array.isArray(v)) throw badRequest("notifications.categories must be an object of category → true or false");
        for (const [cat, on] of Object.entries(v as Record<string, unknown>)) {
          if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(cat)) throw badRequest(`Unknown notification category: ${cat} (one of ${NOTIFICATION_CATEGORIES.join(", ")})`);
          if (typeof on !== "boolean") throw badRequest(`notifications.categories.${cat} must be true or false`);
          out.categories[cat as keyof NotificationSettings["categories"]] = on;
        }
        break;
      case "apnsKeyDir":
        if (v !== null && typeof v !== "string") throw badRequest("notifications.apnsKeyDir must be a folder path or null");
        out.apnsKeyDir = (v as string | null)?.trim() || null;
        break;
      case "apnsTeamId":
        if (typeof v !== "string" || !/^[A-Z0-9]{10}$/.test(v.trim())) throw badRequest("notifications.apnsTeamId must be a 10-character Apple team id");
        out.apnsTeamId = v.trim();
        break;
      default:
        throw badRequest(`Unknown notifications setting: ${key}`);
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

/**
 * { phase: { driver, model } | null }. Phases must be plan / work / review / complete, drivers known
 * when the list is given (clearing a phase is always fine), and models valid ids (null / "" → the
 * driver's default).
 */
export function validatePhaseModels(field: string, value: unknown, knownDrivers?: string[]): PhaseModelsPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${field} must be an object of phase (${PHASES.join(", ")}) → { driver, model } or null`);
  const out: PhaseModelsPatch = {};
  for (const [phase, choice] of Object.entries(value as Record<string, unknown>)) {
    if (!(PHASES as readonly string[]).includes(phase)) throw badRequest(`Unknown phase in ${field}: ${phase} (one of ${PHASES.join(", ")})`);
    const p = phase as (typeof PHASES)[number];
    if (choice === null) {
      out[p] = null;
      continue;
    }
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) throw badRequest(`${field}.${phase} must be { driver, model } or null`);
    const { driver, model } = choice as { driver?: unknown; model?: unknown };
    if (typeof driver !== "string" || !driver.trim()) throw badRequest(`${field}.${phase}.driver must be a driver id`);
    if (knownDrivers && !knownDrivers.includes(driver.trim())) throw badRequest(`Unknown driver in ${field}.${phase}: ${driver}`);
    out[p] = { driver: driver.trim(), model: validateModelId(`${field}.${phase}.model`, model) };
  }
  return out;
}

/**
 * Apply a validated PATCH /settings over the current settings: the values to store. Model maps merge
 * per driver. The model choice is stored only as phaseModels: legacy fields in the patch apply to it
 * first, then its own phases; the caller drops the legacy keys from storage (LEGACY_MODEL_KEYS).
 */
export function applySettingsPatch(current: Settings, patch: SettingsUpdate): Partial<Settings> {
  const { phaseModels, defaultDriver, defaultModels, reviewModels, ...rest } = patch;
  const out: Partial<Settings> = { ...rest };
  if (phaseModels || defaultDriver !== undefined || defaultModels || reviewModels) {
    const legacy = applyLegacySettings(current.phaseModels, { defaultDriver, defaultModels, reviewModels });
    out.phaseModels = mergePhaseModels(legacy, phaseModels ?? {});
  }
  if (patch.watcherModels) out.watcherModels = mergeModelMap(current.watcherModels ?? {}, patch.watcherModels);
  // Stored compactly: only the ids with an override (a null in the patch removes one).
  if (patch.prompts) {
    const merged = { ...current.prompts, ...patch.prompts };
    out.prompts = Object.fromEntries(Object.entries(merged).filter(([, text]) => text)) as Settings["prompts"];
  }
  return out;
}
