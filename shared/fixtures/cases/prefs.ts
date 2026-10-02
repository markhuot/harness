// The preferences blob for HarnessKit's Prefs.swift. HIDE_CHILDREN_DEFAULT comes from shared/src
// and is computed; DEFAULT_PREFS and normalizePrefs (from the retired RN app, now only in Swift) are
// frozen. Their inputs were anything storage could hand back: older builds' blobs, hand-damaged
// JSON, non-objects.
import { HIDE_CHILDREN_DEFAULT } from "../../src/state";
import { frozen } from "../case";

export const defaults = { DEFAULT_PREFS: frozen<{ DEFAULT_PREFS: unknown }>("prefs", "defaults").DEFAULT_PREFS, HIDE_CHILDREN_DEFAULT };

export const normalizePrefsCases = frozen("prefs", "normalizePrefsCases");
