// App-level state that outlives a connection: preferences (appearance, board toggles), the saved
// servers and which one is active (tokens in the Keychain), and pairing.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Appearance, useColorScheme } from "react-native";
import * as SystemUI from "expo-system-ui";
import { resolveThemeChoice, type Theme as ColorTheme } from "@harness/shared/themes";
import type { Palette } from "../theme/tokens";
import { probeServer, type ProbeResult } from "../lib/connection";
import type { ServerAddress } from "../lib/pair";
import { removeServer, renameServer, upsertServer } from "../lib/servers";
import { DEFAULT_PREFS, deleteToken, loadPrefs, loadServers, loadToken, savePrefs, saveServers, saveToken, type Prefs, type SavedServer, type ThemePreference } from "../lib/storage";

export interface ActiveServer extends SavedServer {
  token: string;
}

interface AppCtx {
  loaded: boolean;
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void;
  servers: SavedServer[];
  active: ActiveServer | null;
  /** Probe, then save + activate. Returns the probe result (errors are for the caller to show). */
  pair: (a: ServerAddress, opts?: { skipProbe?: boolean }) => Promise<ProbeResult>;
  activate: (id: string) => Promise<void>;
  forget: (id: string) => Promise<void>;
  rename: (id: string, name: string) => void;
  /** Bumped to force the active connection to rebuild (e.g. after a re-pair with a new token). */
  connectionNonce: number;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

const newId = () => `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function AppProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [active, setActive] = useState<ActiveServer | null>(null);
  const [nonce, setNonce] = useState(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const serversRef = useRef(servers);
  serversRef.current = servers;

  useEffect(() => {
    void (async () => {
      const [p, list] = await Promise.all([loadPrefs(), loadServers()]);
      setPrefs(p);
      setServers(list);
      const current = list.find((s) => s.id === p.activeServer) ?? list[0];
      if (current) {
        const token = await loadToken(current.id).catch(() => null);
        if (token) setActive({ ...current, token });
      }
      setLoaded(true);
    })();
  }, []);

  const setPref = useCallback(<K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    const next = { ...prefsRef.current, [k]: v };
    prefsRef.current = next;
    setPrefs(next);
    void savePrefs(next);
  }, []);

  const activate = useCallback(
    async (id: string) => {
      const s = serversRef.current.find((x) => x.id === id);
      if (!s) return;
      const token = await loadToken(id);
      if (!token) return;
      setActive({ ...s, token });
      setPref("activeServer", id);
      setNonce((n) => n + 1);
    },
    [setPref],
  );

  const pair = useCallback(
    async (a: ServerAddress, opts: { skipProbe?: boolean } = {}) => {
      const result: ProbeResult = opts.skipProbe ? { ok: true, version: "" } : await probeServer(a.baseUrl, a.token);
      if (!result.ok) return result;
      const { list, server } = upsertServer(serversRef.current, a.baseUrl, Date.now(), newId);
      try {
        await saveToken(server.id, a.token);
        await saveServers(list);
      } catch (e) {
        return { ok: false, kind: "error", message: `Couldn't save the token to the Keychain: ${(e as Error).message}` } as const;
      }
      serversRef.current = list;
      setServers(list);
      setActive({ ...server, token: a.token });
      setPref("activeServer", server.id);
      setNonce((n) => n + 1);
      return result;
    },
    [setPref],
  );

  const forget = useCallback(
    async (id: string) => {
      const { list, active: nextActive } = removeServer(serversRef.current, id, prefsRef.current.activeServer ?? active?.id ?? null);
      await deleteToken(id).catch(() => {});
      await saveServers(list);
      serversRef.current = list;
      setServers(list);
      setPref("activeServer", nextActive);
      if (nextActive) {
        const s = list.find((x) => x.id === nextActive)!;
        const token = await loadToken(nextActive);
        setActive(token ? { ...s, token } : null);
      } else setActive(null);
      setNonce((n) => n + 1);
    },
    [active?.id, setPref],
  );

  const rename = useCallback((id: string, name: string) => {
    const list = renameServer(serversRef.current, id, name);
    serversRef.current = list;
    setServers(list);
    setActive((a) => (a && a.id === id ? { ...a, name: list.find((s) => s.id === id)!.name } : a));
    void saveServers(list);
  }, []);

  const value = useMemo<AppCtx>(
    () => ({ loaded, prefs, setPref, servers, active, pair, activate, forget, rename, connectionNonce: nonce }),
    [loaded, prefs, setPref, servers, active, pair, activate, forget, rename, nonce],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------------------------------------------------------------------
// Theme: follows the system unless Settings → Appearance overrides it; the light/dark theme
// picks decide the colors for each appearance
// ---------------------------------------------------------------------------

export interface Theme {
  /** Appearance preference: System / Light / Dark */
  preference: ThemePreference;
  resolved: "light" | "dark";
  /** The active color theme: the light pick when resolved is light, the dark pick when dark */
  theme: ColorTheme;
  c: Palette;
}

export function useTheme(): Theme {
  const { prefs } = useApp();
  const scheme = useColorScheme();
  const { theme: pref, lightTheme, darkTheme } = prefs;
  return useMemo(() => {
    const { appearance, theme } = resolveThemeChoice({ appearance: pref, lightTheme, darkTheme }, scheme === "dark");
    return { preference: pref, resolved: appearance, theme, c: theme.tokens };
  }, [pref, lightTheme, darkTheme, scheme]);
}

export const useColors = () => useTheme().c;

/** Push the preference into UIKit (alerts, action sheets, keyboards follow it) and paint the root. */
export function ThemeSync() {
  const { prefs, loaded } = useApp();
  const t = useTheme();
  useEffect(() => {
    if (!loaded) return;
    Appearance.setColorScheme(prefs.theme === "system" ? "unspecified" : prefs.theme);
  }, [prefs.theme, loaded]);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.c.bg).catch(() => {});
  }, [t.c.bg]);
  return null;
}
