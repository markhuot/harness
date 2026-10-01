// Host side of the plugin bridge (shared/src/state/pluginBridge.ts) for HarnessKit's
// PluginBridge.swift. Each bridge case builds a real createPluginHostBridge with recording
// callbacks, replays a list of steps (load, frame messages, theme/ticket pushes, frame swaps), and
// records what each step posted and called back.
import { createPluginHostBridge, pluginUiUrl, themeFields, type HostTheme } from "../../src/state/pluginBridge";
import { findTheme, pluginThemeInfo } from "../../src/themes";
import type { Ticket as TicketT } from "../../src/protocol";
import { cases } from "../case";
import { Ticket } from "./protocol";

/** "light" / "dark", or a bundled theme by id (sent as its PluginThemeInfo). */
type ThemeSpec = "light" | "dark" | { themeId: string };

function hostTheme(spec: ThemeSpec): HostTheme {
  return typeof spec === "string" ? spec : pluginThemeInfo(findTheme(spec.themeId)!);
}

type Step =
  | { op: "load" }
  | { op: "message"; data: unknown; origin: string; source: "frame" | "other" | "none" }
  | { op: "sendTheme"; theme: ThemeSpec }
  | { op: "sendTicket"; ticket: TicketT }
  | { op: "setTheme"; theme: ThemeSpec }
  | { op: "detach" }
  | { op: "attach" };

interface BridgeInput {
  baseUrl: string;
  token: string;
  ticketKey: string;
  tabId: string;
  theme: ThemeSpec;
  steps: Step[];
}

function runBridge(input: BridgeInput) {
  let posted: { message: unknown; targetOrigin: string }[] = [];
  let navigated: string[] = [];
  let opened: string[] = [];
  let ready = 0;
  const frame = { postMessage: (message: unknown, targetOrigin: string) => void posted.push({ message: structuredClone(message), targetOrigin }) };
  const other = { postMessage() {} };
  let current: typeof frame | null = frame;
  let theme = input.theme;
  let bridge: ReturnType<typeof createPluginHostBridge>;
  try {
    bridge = createPluginHostBridge({
      baseUrl: input.baseUrl,
      token: input.token,
      ticketKey: input.ticketKey,
      tabId: input.tabId,
      frame: () => current,
      theme: () => hostTheme(theme),
      onNavigate: (k) => navigated.push(k),
      onOpenExternal: (u) => opened.push(u),
      onReady: () => ready++,
    });
  } catch {
    return null; // new URL(baseUrl) threw
  }
  const steps = input.steps.map((s) => {
    let accepted: boolean | null = null;
    switch (s.op) {
      case "load":
        bridge.onLoad();
        break;
      case "message":
        accepted = bridge.onMessage({ data: s.data, origin: s.origin, source: s.source === "frame" ? frame : s.source === "other" ? other : null });
        break;
      case "sendTheme":
        bridge.sendTheme(hostTheme(s.theme));
        break;
      case "sendTicket":
        bridge.sendTicket(s.ticket);
        break;
      case "setTheme":
        theme = s.theme;
        break;
      case "detach":
        current = null;
        break;
      case "attach":
        current = frame;
        break;
    }
    const out = { accepted, posted, navigated, opened, ready };
    posted = [];
    navigated = [];
    opened = [];
    return out;
  });
  return { serviceOrigin: bridge.serviceOrigin, steps };
}

const ORIGIN = "http://127.0.0.1:7801";
const base = { baseUrl: `${ORIGIN}/`, token: "secret", ticketKey: "HELLO-1", tabId: "changes", theme: "light" as ThemeSpec };
const msg = (data: unknown, origin = ORIGIN, source: "frame" | "other" | "none" = "frame"): Step => ({ op: "message", data, origin, source });
const ready = msg({ type: "harness:ready" });
const helloTicket: TicketT = { ...Ticket[0]!, key: "HELLO-1" };
const otherTicket: TicketT = { ...Ticket[1]!, key: "HELLO-2" };

export const bridgeCases = cases(runBridge, {
  "init on load and on every ready; onReady once": { ...base, theme: "dark", steps: [{ op: "load" }, ready, ready] },
  "rejects other windows, origins, and junk": {
    ...base,
    steps: [
      msg({ type: "harness:ready" }, ORIGIN, "other"),
      msg({ type: "harness:ready" }, ORIGIN, "none"),
      msg({ type: "harness:ready" }, "https://evil.example"),
      msg({ type: "harness:ready" }, "http://127.0.0.1:9999"),
      msg({ type: "harness:ready" }, "null"),
      msg({ type: "harness:ready" }, `${ORIGIN}/`),
      msg({ type: "harness:ready" }, "HTTP://127.0.0.1:7801"),
      msg(null),
      msg("harness:ready"),
      msg(3),
      msg([]),
      msg({}),
      msg({ type: "harness:bogus" }),
      msg({ type: 1 }),
      { op: "detach" },
      ready,
      { op: "attach" },
      ready,
    ],
  },
  "openExternal and navigate are validated": {
    ...base,
    steps: [
      msg({ type: "harness:openExternal", url: "https://github.com/x" }),
      msg({ type: "harness:openExternal", url: "mailto:a@b.c" }),
      msg({ type: "harness:openExternal", url: "HTTPS://EXAMPLE.COM" }),
      msg({ type: "harness:openExternal", url: "Http://x" }),
      msg({ type: "harness:openExternal", url: "MailTo:x" }),
      msg({ type: "harness:openExternal", url: "http:/x" }),
      msg({ type: "harness:openExternal", url: "https:" }),
      msg({ type: "harness:openExternal", url: " https://x" }),
      msg({ type: "harness:openExternal", url: "file:///etc/passwd" }),
      msg({ type: "harness:openExternal", url: "javascript:alert(1)" }),
      msg({ type: "harness:openExternal", url: "ftp://x" }),
      msg({ type: "harness:openExternal", url: "httpſ://x" }),
      msg({ type: "harness:openExternal" }),
      msg({ type: "harness:openExternal", url: 3 }),
      msg({ type: "harness:navigate", ticketKey: "OTHER-12" }),
      msg({ type: "harness:navigate", ticketKey: "A_1-0" }),
      msg({ type: "harness:navigate", ticketKey: "A-1\n" }),
      msg({ type: "harness:navigate", ticketKey: "other-12" }),
      msg({ type: "harness:navigate", ticketKey: "1A-2" }),
      msg({ type: "harness:navigate", ticketKey: "A-" }),
      msg({ type: "harness:navigate", ticketKey: "A-١" }),
      msg({ type: "harness:navigate", ticketKey: "ÄB-1" }),
      msg({ type: "harness:navigate", ticketKey: "../settings" }),
      msg({ type: "harness:navigate", ticketKey: 3 }),
      msg({ type: "harness:navigate" }),
    ],
  },
  "theme and ticket pushes; tickets for other keys are dropped": {
    ...base,
    steps: [
      { op: "sendTheme", theme: "dark" },
      { op: "sendTicket", ticket: helloTicket },
      { op: "sendTicket", ticket: otherTicket },
      { op: "setTheme", theme: "dark" },
      { op: "load" },
      { op: "detach" },
      { op: "sendTheme", theme: "light" },
      { op: "sendTicket", ticket: helloTicket },
      { op: "load" },
    ],
  },
  "full themes add appearance, id, syntax theme and tokens": {
    ...base,
    theme: { themeId: "catppuccin-mocha" },
    steps: [{ op: "load" }, { op: "sendTheme", theme: { themeId: "one-light" } }, { op: "sendTheme", theme: { themeId: "tokyo-night-day" } }, { op: "sendTheme", theme: "light" }],
  },
  "base URL without a trailing slash, default port, path": {
    ...base,
    baseUrl: "HTTPS://Mac.Local:443/harness/",
    steps: [{ op: "load" }, msg({ type: "harness:ready" }, "https://mac.local"), msg({ type: "harness:ready" }, "https://mac.local:443")],
  },
  "base URL with two trailing slashes keeps one": { ...base, baseUrl: "http://h:1//", steps: [{ op: "load" }] },
  "ipv6 base URL": { ...base, baseUrl: "http://[FD7A::1]:7717", steps: [{ op: "load" }, msg({ type: "harness:ready" }, "http://[fd7a::1]:7717")] },
  "token with quotes and unicode": { ...base, token: `a"b\\c\n é😀`, steps: [{ op: "load" }] },
  "invalid base URL throws": { ...base, baseUrl: "not a url", steps: [] },
});

export const originCases = cases(
  (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  },
  {
    plain: "http://127.0.0.1:7801/",
    "trailing path and query": "http://127.0.0.1:7801/plugins/git/ui/index.html?tab=changes#x",
    "default http port dropped": "http://example.com:80/",
    "default https port dropped": "https://example.com:443",
    "non-default port kept": "https://example.com:80",
    "leading zero port": "http://example.com:0080",
    "upper-case scheme and host": "HTTP://EXAMPLE.com",
    "ipv6": "http://[FD7A::1]:7717/x",
    "userinfo is not part of the origin": "http://user:pw@h:1/",
    "ws": "ws://h:80/",
    "wss non-default": "wss://h:8443/",
    "file is opaque": "file:///etc/passwd",
    "mailto is opaque": "mailto:a@b.c",
    "about:blank": "about:blank",
    "not a url": "not a url",
    "empty host": "http://",
    "port out of range": "http://h:65536",
    "max port": "http://h:65535",
    "tailscale": "http://100.64.1.2:7717",
    "surrounding spaces are stripped": "  http://h:1/  ",
  },
);

export const pluginUiUrlCases = cases(
  ({ baseUrl, pluginId, tabId }: { baseUrl: string; pluginId: string; tabId: string }) => pluginUiUrl(baseUrl, pluginId, tabId),
  {
    "the TS test": { baseUrl: "http://127.0.0.1:7717/", pluginId: "git", tabId: "changes" },
    "no trailing slash": { baseUrl: "http://127.0.0.1:7717", pluginId: "git", tabId: "changes" },
    "only one slash stripped": { baseUrl: "http://h//", pluginId: "git", tabId: "x" },
    "ids are URI-encoded": { baseUrl: "http://h", pluginId: "my plugin/é", tabId: "a&b=c?d#e" },
    "unreserved marks are kept": { baseUrl: "http://h", pluginId: "a-_.!~*'()", tabId: "😀" },
  },
);

export const themeFieldsCases = cases((spec: ThemeSpec) => themeFields(hostTheme(spec)), {
  light: "light",
  dark: "dark",
  "catppuccin-mocha": { themeId: "catppuccin-mocha" },
  "null syntax theme": { themeId: "tokyo-night-day" },
});
