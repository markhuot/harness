// Everything the app persists lives in the iOS Keychain via expo-secure-store: the saved servers
// (tokens under their own keys) and a small preferences blob. Nothing secret ships in the app.

import * as SecureStore from "expo-secure-store";
import { normalizePrefs, type Prefs } from "./prefs";

export interface SavedServer {
  id: string;
  name: string;
  baseUrl: string;
  addedAt: number;
}

export { DEFAULT_PREFS, normalizePrefs, type Prefs, type ThemePreference } from "./prefs";

const SERVERS = "harness.servers";
const PREFS = "harness.prefs";
const tokenKey = (id: string) => `harness.token.${id}`;
const opts: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const v = await SecureStore.getItemAsync(key, opts);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const loadServers = () => readJson<SavedServer[]>(SERVERS, []);
export const saveServers = (list: SavedServer[]) => SecureStore.setItemAsync(SERVERS, JSON.stringify(list), opts);
export const loadToken = (id: string) => SecureStore.getItemAsync(tokenKey(id), opts);
export const saveToken = (id: string, token: string) => SecureStore.setItemAsync(tokenKey(id), token, opts);
export const deleteToken = (id: string) => SecureStore.deleteItemAsync(tokenKey(id), opts);

export async function loadPrefs(): Promise<Prefs> {
  return normalizePrefs(await readJson<Partial<Prefs>>(PREFS, {}));
}
export const savePrefs = (p: Prefs) => SecureStore.setItemAsync(PREFS, JSON.stringify(p), opts).catch(() => {});
