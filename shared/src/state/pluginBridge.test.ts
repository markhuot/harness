import { expect, test } from "bun:test";
import type { Ticket } from "../index";
import { findTheme, pluginThemeInfo } from "../themes";
import { createPluginHostBridge, pluginUiUrl, type HostTheme } from "./pluginBridge";

function setup(theme: HostTheme = "light") {
  const posted: { message: any; targetOrigin: string }[] = [];
  const frame = { postMessage: (message: unknown, targetOrigin: string) => void posted.push({ message, targetOrigin }) };
  const other = { postMessage() {} };
  const navigated: string[] = [];
  const opened: string[] = [];
  let ready = 0;
  let current: typeof frame | null = frame;
  let t = theme;
  const bridge = createPluginHostBridge({
    baseUrl: "http://127.0.0.1:7801/",
    token: "secret",
    ticketKey: "HELLO-1",
    tabId: "changes",
    frame: () => current,
    theme: () => t,
    onNavigate: (k) => navigated.push(k),
    onOpenExternal: (u) => opened.push(u),
    onReady: () => ready++,
  });
  const origin = "http://127.0.0.1:7801";
  return { bridge, posted, frame, other, navigated, opened, origin, ready: () => ready, setTheme: (x: typeof t) => (t = x), detach: () => (current = null) };
}

test("init goes only to the service origin, on load and on every ready", () => {
  const s = setup("dark");
  expect(s.bridge.serviceOrigin).toBe(s.origin);
  s.bridge.onLoad();
  expect(s.posted).toEqual([
    { message: { type: "harness:init", baseUrl: "http://127.0.0.1:7801", token: "secret", ticketKey: "HELLO-1", tabId: "changes", theme: "dark" }, targetOrigin: s.origin },
  ]);
  expect(s.bridge.onMessage({ data: { type: "harness:ready" }, origin: s.origin, source: s.frame as never })).toBe(true);
  expect(s.bridge.onMessage({ data: { type: "harness:ready" }, origin: s.origin, source: s.frame as never })).toBe(true);
  expect(s.posted).toHaveLength(3);
  expect(s.posted.every((p) => p.targetOrigin === s.origin)).toBe(true);
  expect(s.ready()).toBe(1);
});

test("rejects messages from other windows or origins (a navigated-away or foreign frame never gets the token)", () => {
  const s = setup();
  const ready = { type: "harness:ready" };
  expect(s.bridge.onMessage({ data: ready, origin: s.origin, source: s.other as never })).toBe(false);
  expect(s.bridge.onMessage({ data: ready, origin: "https://evil.example", source: s.frame as never })).toBe(false);
  expect(s.bridge.onMessage({ data: ready, origin: "http://127.0.0.1:9999", source: s.frame as never })).toBe(false);
  expect(s.bridge.onMessage({ data: ready, origin: "null", source: s.frame as never })).toBe(false);
  expect(s.bridge.onMessage({ data: null, origin: s.origin, source: s.frame as never })).toBe(false);
  expect(s.bridge.onMessage({ data: { type: "harness:bogus" }, origin: s.origin, source: s.frame as never })).toBe(false);
  expect(s.posted).toEqual([]);
  s.detach();
  expect(s.bridge.onMessage({ data: ready, origin: s.origin, source: s.frame as never })).toBe(false);
});

test("openExternal and navigate are validated", () => {
  const s = setup();
  const send = (data: unknown) => s.bridge.onMessage({ data, origin: s.origin, source: s.frame as never });
  expect(send({ type: "harness:openExternal", url: "https://github.com/x" })).toBe(true);
  expect(send({ type: "harness:openExternal", url: "mailto:a@b.c" })).toBe(true);
  expect(send({ type: "harness:openExternal", url: "file:///etc/passwd" })).toBe(false);
  expect(send({ type: "harness:openExternal", url: "javascript:alert(1)" })).toBe(false);
  expect(send({ type: "harness:openExternal" })).toBe(false);
  expect(send({ type: "harness:navigate", ticketKey: "OTHER-12" })).toBe(true);
  expect(send({ type: "harness:navigate", ticketKey: "../settings" })).toBe(false);
  expect(send({ type: "harness:navigate", ticketKey: 3 })).toBe(false);
  expect(s.opened).toEqual(["https://github.com/x", "mailto:a@b.c"]);
  expect(s.navigated).toEqual(["OTHER-12"]);
});

test("theme and ticket pushes; tickets for other keys are dropped", () => {
  const s = setup();
  s.bridge.sendTheme("dark");
  s.bridge.sendTicket({ key: "HELLO-1", busy: true } as Ticket);
  s.bridge.sendTicket({ key: "HELLO-2" } as Ticket);
  expect(s.posted.map((p) => p.message.type)).toEqual(["harness:theme", "harness:ticket"]);
  expect(s.posted[0]!.message.theme).toBe("dark");
  s.setTheme("dark");
  s.bridge.onLoad();
  expect(s.posted.at(-1)!.message.theme).toBe("dark"); // init reads the theme at send time
});

test("a full theme adds appearance, id, syntax theme and tokens next to the old light/dark field", () => {
  const mocha = pluginThemeInfo(findTheme("catppuccin-mocha")!);
  const s = setup(mocha);
  s.bridge.onLoad();
  const init = s.posted[0]!.message;
  expect(init).toMatchObject({ type: "harness:init", token: "secret", theme: "dark", appearance: "dark", themeId: "catppuccin-mocha", themeName: "Catppuccin Mocha", syntaxTheme: "catppuccin-mocha" });
  expect(init.tokens.bg).toBe(mocha.tokens.bg);
  s.bridge.sendTheme(pluginThemeInfo(findTheme("one-light")!));
  expect(s.posted.at(-1)!.message).toMatchObject({ type: "harness:theme", theme: "light", appearance: "light", themeId: "one-light", syntaxTheme: "one-light" });
  // The payload is a copy: a plugin (or a later edit) can't reach back into the registry.
  s.posted.at(-1)!.message.tokens.bg = "#000";
  expect(findTheme("one-light")!.tokens.bg).not.toBe("#000");
  // A bare appearance still produces exactly the old message.
  s.bridge.sendTheme("light");
  expect(s.posted.at(-1)!.message).toEqual({ type: "harness:theme", theme: "light" });
});

test("helpers", () => {
  expect(pluginUiUrl("http://127.0.0.1:7717/", "git", "changes")).toBe("http://127.0.0.1:7717/plugins/git/ui/index.html?tab=changes");
});
