import type { PublicSettings, Settings } from "@harness/shared";
import { badRequest } from "./errors";

export const DEFAULT_SETTINGS: Settings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 4,
  claudePermissionMode: "acceptEdits",
  claudeModel: null,
  anthropicModel: "claude-sonnet-5",
  anthropicApiKey: null,
};

const PERMISSION_MODES: Settings["claudePermissionMode"][] = ["bypassPermissions", "acceptEdits", "auto", "dontAsk"];

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
      case "claudePermissionMode":
        if (!PERMISSION_MODES.includes(value as Settings["claudePermissionMode"]))
          throw badRequest(`claudePermissionMode must be one of ${PERMISSION_MODES.join(", ")}`);
        out.claudePermissionMode = value as Settings["claudePermissionMode"];
        break;
      case "claudeModel":
        if (value !== null && typeof value !== "string") throw badRequest("claudeModel must be a string or null");
        out.claudeModel = value ? (value as string) : null;
        break;
      case "anthropicModel":
        if (typeof value !== "string" || !value) throw badRequest("anthropicModel must be a non-empty string");
        out.anthropicModel = value;
        break;
      case "anthropicApiKey":
        if (value !== null && typeof value !== "string") throw badRequest("anthropicApiKey must be a string or null");
        out.anthropicApiKey = value ? (value as string).trim() || null : null;
        break;
      case "anthropicApiKeySet":
        break; // echoed back from PublicSettings; ignore
      default:
        throw badRequest(`Unknown setting: ${key}`);
    }
  }
  return out;
}
