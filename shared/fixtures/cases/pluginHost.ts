// WebView transport for the plugin host bridge (mobile/src/lib/pluginHost.ts) for HarnessKit's
// PluginHost.swift. The injected script must be byte-identical to what TS builds, so these cases
// pin JSON.stringify's escaping and number formatting, and the U+2028/U+2029 fix-up.
//
// JSON.stringify writes keys in insertion order (array-index keys first, ascending), and a Swift
// JSONValue has no order, so the Swift side writes keys in a canonical order: index keys
// numerically, then the rest sorted by UTF-16 code units. Every message here goes through
// sortKeys (that canonical order) before buildInjection, so both sides see the same object.
import { buildInjection, webViewMessageEvent } from "../../../mobile/src/lib/pluginHost";
import { createPluginHostBridge, type FrameWindow } from "../../src/state/pluginBridge";
import { findTheme, pluginThemeInfo } from "../../src/themes";
import { cases } from "../case";
import { Ticket } from "./protocol";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

const SERVICE = "http://100.64.1.2:7717";
const nasty = `a"b'c\\d\ne\r f g</script><script>globalThis.pwned=1</script>\`\${x}\``;

export const injectionCases = cases(({ msg, origin }: { msg: unknown; origin: string }) => buildInjection(sortKeys(msg), origin), {
  "init message": { msg: { type: "harness:init", baseUrl: SERVICE, token: "secret", ticketKey: "HELLO-1", tabId: "changes", theme: "dark" }, origin: SERVICE },
  "the TS test's hostile token": { msg: { type: "harness:init", token: nasty, nested: { list: [1, null, "\u0000"] } }, origin: SERVICE },
  "every control character": { msg: { s: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join("") + "\u007f" }, origin: SERVICE },
  "slash, non-ASCII and emoji stay raw": { msg: { s: "a/b é ü 😀   ﻿ \u0085" }, origin: SERVICE },
  numbers: { msg: { list: [0, -0, 1, -1, 0.1, 0.1 + 0.2, 2.5, 1e21, 1e-7, 123456789012345680000, 1759190400000, -1.5e-10, 5e-324, 1.7976931348623157e308] }, origin: SERVICE },
  "booleans, null and empty containers": { msg: { t: true, f: false, n: null, a: [], o: {} }, origin: SERVICE },
  "index keys come first, numerically": { msg: { b: 1, "10": 2, "2": 3, a: 4, "01": 5, "-1": 6, "1.5": 7, "4294967295": 8, "4294967294": 9, "0": 10 }, origin: SERVICE },
  "keys sort by UTF-16 code units": { msg: { "￿": 1, "😀": 2, é: 3, Z: 4, a: 5, "": 6 }, origin: SERVICE },
  "top-level string": { msg: "hello", origin: SERVICE },
  "top-level null": { msg: null, origin: SERVICE },
  "origin that tries to break out": { msg: { token: "secret" }, origin: `x" || true || "` },
  "origin with backslash and line separator": { msg: {}, origin: "a\\b c" },
});

/** A frame that records TS buildInjection over a key-sorted copy of each message. */
function sortedInjectionFrame(scripts: string[]): FrameWindow {
  return { postMessage: (m, o) => void scripts.push(buildInjection(sortKeys(m), o)) };
}

export const bridgeInjectionCases = cases(
  ({ theme, token }: { theme: string; token: string }) => {
    const scripts: string[] = [];
    const frame = sortedInjectionFrame(scripts);
    const bridge = createPluginHostBridge({
      baseUrl: `${SERVICE}/`,
      token,
      ticketKey: "NYTIMES-31",
      tabId: "changes",
      frame: () => frame,
      theme: () => (theme === "light" || theme === "dark" ? theme : pluginThemeInfo(findTheme(theme)!)),
      onNavigate: () => {},
      onOpenExternal: () => {},
    });
    bridge.onLoad();
    bridge.sendTheme("light");
    bridge.sendTicket(Ticket[0]!);
    return scripts;
  },
  {
    "appearance only": { theme: "dark", token: "secret" },
    "full theme and a hostile token": { theme: "catppuccin-mocha", token: nasty },
    "theme without a syntax theme": { theme: "tokyo-night-day", token: "t" },
  },
);

export const messageEventCases = cases(({ data, url }: { data: string; url: string }) => {
  const e = webViewMessageEvent({ data, url }, null);
  return e && { data: e.data, origin: e.origin };
}, {
  "ready from the plugin page": { data: '{"type":"harness:ready"}', url: `${SERVICE}/plugins/git/ui/index.html?tab=changes` },
  "bad JSON": { data: "{nope", url: SERVICE },
  "bad URL": { data: "{}", url: "not a url" },
  "empty data": { data: "", url: SERVICE },
  "top-level number": { data: "3", url: SERVICE },
  "top-level null": { data: "null", url: SERVICE },
  "surrounding whitespace": { data: ' \n{"a":1}\t', url: SERVICE },
  "about:blank has an opaque origin": { data: "{}", url: "about:blank" },
  "default port dropped": { data: "{}", url: "https://h:443/x" },
  "escapes decoded": { data: '{"s":"\\u00e9\\n\\ud83d\\ude00"}', url: SERVICE },
});
