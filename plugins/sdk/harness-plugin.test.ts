import { describe, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { connect, HarnessPluginError, isAllowedHostOrigin, pluginIdFromPath, readThemeInfo, tokenCssVar, type BridgeWindow } from "./harness-plugin";

type Listener = (e: MessageEvent) => void;

function fakeWindow(pathname = "/plugins/git/ui/index.html") {
  const listeners = new Set<Listener>();
  const posted: { message: any; targetOrigin: string }[] = [];
  const parent = { postMessage: (message: unknown, targetOrigin: string) => void posted.push({ message, targetOrigin }) };
  const stranger = { postMessage() {} };
  const win: BridgeWindow = {
    parent,
    location: { pathname, search: "?tab=changes" },
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    document: { documentElement: { dataset: {}, style: {} } },
  };
  const send = (data: unknown, origin = "file://", source: unknown = parent) => {
    for (const l of [...listeners]) l({ data, origin, source } as MessageEvent);
  };
  return { win, posted, send, parent, stranger, listeners };
}

const init = { type: "harness:init", baseUrl: "http://127.0.0.1:7801/", token: "tok", ticketKey: "HELLO-1", tabId: "changes", theme: "dark" } as const;
const ticket = (key: string) => ({ key, status: "in_progress" }) as Ticket;

describe("plugin sdk bridge", () => {
  test("announces ready, resolves on init from the parent, applies the theme", async () => {
    const f = fakeWindow();
    const p = connect({ window: f.win });
    expect(f.posted).toEqual([{ message: { type: "harness:ready" }, targetOrigin: "*" }]);
    f.send(init);
    const h = await p;
    expect(h).toMatchObject({ baseUrl: "http://127.0.0.1:7801", token: "tok", ticketKey: "HELLO-1", tabId: "changes", pluginId: "git", theme: "dark" });
    expect(f.win.document!.documentElement.dataset.theme).toBe("dark");
    expect(f.win.document!.documentElement.style.colorScheme).toBe("dark");
  });

  test("ignores messages from other windows, disallowed origins and malformed data", async () => {
    const f = fakeWindow();
    let resolved = false;
    const p = connect({ window: f.win, timeoutMs: 200 }).then((h) => ((resolved = true), h));
    f.send(init, "file://", f.stranger); // not window.parent
    f.send(init, "https://evil.example"); // parent, but a remote origin
    f.send({ ...init, token: 42 }); // malformed
    f.send("harness:init");
    f.send(null);
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    f.send(init, "null"); // opaque file origin is fine
    expect((await p).token).toBe("tok");
  });

  test("after init only the origin that sent init is trusted", async () => {
    const f = fakeWindow();
    const p = connect({ window: f.win });
    f.send(init, "http://localhost:5173");
    const h = await p;
    const themes: string[] = [];
    h.onTheme((t) => themes.push(t));
    f.send({ type: "harness:theme", theme: "light" }, "file://"); // allowed origin in general, but not the host's
    f.send({ type: "harness:theme", theme: "light" }, "http://localhost:5173");
    expect(themes).toEqual(["light"]);
    expect(h.theme).toBe("light");
    h.openExternal("https://example.com");
    expect(f.posted.at(-1)).toEqual({ message: { type: "harness:openExternal", url: "https://example.com" }, targetOrigin: "http://localhost:5173" });
  });

  test("theme and ticket callbacks: filtering, validation, unsubscribe", async () => {
    const f = fakeWindow();
    const p = connect({ window: f.win });
    f.send(init);
    const h = await p;
    const themes: string[] = [];
    const tickets: string[] = [];
    const offTheme = h.onTheme((t) => themes.push(t));
    h.onTicket((t) => tickets.push(t.key));
    f.send({ type: "harness:theme", theme: "light" });
    f.send({ type: "harness:theme", theme: "sepia" }); // invalid
    f.send({ type: "harness:ticket", ticket: ticket("HELLO-1") });
    f.send({ type: "harness:ticket", ticket: ticket("OTHER-2") }); // someone else's ticket
    f.send({ type: "harness:ticket" });
    offTheme();
    f.send({ type: "harness:theme", theme: "dark" });
    expect(themes).toEqual(["light"]);
    expect(tickets).toEqual(["HELLO-1"]);
    expect(f.win.document!.documentElement.dataset.theme).toBe("dark"); // still applied without listeners
    h.navigate("OTHER-2");
    expect(f.posted.at(-1)).toEqual({ message: { type: "harness:navigate", ticketKey: "OTHER-2" }, targetOrigin: "*" });
    h.close();
    expect(f.listeners.size).toBe(0);
  });

  test("a second init refreshes the token and theme without re-resolving", async () => {
    const f = fakeWindow();
    const p = connect({ window: f.win });
    f.send(init);
    const h = await p;
    const themes: string[] = [];
    h.onTheme((t) => themes.push(t));
    f.send({ ...init, token: "tok2", theme: "light" });
    expect(h.token).toBe("tok2");
    expect(themes).toEqual(["light"]);
  });

  test("api(): plugin-relative and root paths, bearer token, envelope unwrapping, errors", async () => {
    const f = fakeWindow();
    const calls: { url: string; auth: string | null; ct: string | null; method?: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ url, auth: headers.get("authorization"), ct: headers.get("content-type"), method: init.method });
      if (url.endsWith("/boom")) return new Response(JSON.stringify({ error: "nope" }), { status: 409 });
      if (url.endsWith("/html")) return new Response("<html>", { status: 502 });
      if (url.endsWith("/weird")) return new Response("<html>", { status: 200 });
      return new Response(JSON.stringify({ data: { ok: url } }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = connect({ window: f.win, fetch: fakeFetch });
    f.send(init);
    const h = await p;
    expect(await h.api<any>("changes?ticket=HELLO-1")).toEqual({ ok: "http://127.0.0.1:7801/plugins/git/api/changes?ticket=HELLO-1" });
    expect(await h.api<any>("/tickets/HELLO-1")).toEqual({ ok: "http://127.0.0.1:7801/tickets/HELLO-1" });
    await h.api<any>("x", { method: "POST", body: "{}" });
    expect(calls.map((c) => c.auth)).toEqual(["Bearer tok", "Bearer tok", "Bearer tok"]);
    expect(calls[0]!.ct).toBeNull();
    expect(calls[2]).toMatchObject({ ct: "application/json", method: "POST" });
    const err = await h.api<any>("boom").catch((e) => e);
    expect(err).toBeInstanceOf(HarnessPluginError);
    expect(err).toMatchObject({ status: 409, message: "nope" });
    await expect(h.api<any>("html")).rejects.toMatchObject({ status: 502 });
    await expect(h.api<any>("weird")).rejects.toThrow(/not JSON/);
  });

  test("times out when the host never answers", async () => {
    const f = fakeWindow();
    await expect(connect({ window: f.win, timeoutMs: 20 })).rejects.toThrow(/Timed out/);
    expect(f.listeners.size).toBe(0);
  });

  test("helpers", () => {
    expect(pluginIdFromPath("/plugins/git/ui/index.html")).toBe("git");
    expect(pluginIdFromPath("/plugins/my%20p/ui/")).toBe("my p");
    expect(pluginIdFromPath("/plugins/git/uix/")).toBeNull();
    expect(pluginIdFromPath("/elsewhere")).toBeNull();
    for (const o of ["null", "file://", "http://127.0.0.1:7717", "http://localhost", "https://[::1]:3000"]) expect(isAllowedHostOrigin(o)).toBe(true);
    for (const o of ["https://evil.example", "http://127.0.0.1.evil.example", "http://localhost.evil:80"]) expect(isAllowedHostOrigin(o)).toBe(false);
    expect(isAllowedHostOrigin("capacitor://localhost", ["capacitor://localhost"])).toBe(true);
  });
});

const SERVICE = "http://100.64.1.2:7717"; // a Tailscale address: not on the localhost allowlist

/** A top-level page (window.parent === window), optionally inside the iOS app's web view. */
function fakeTopWindow(opts: { native?: boolean; origin?: string } = {}) {
  const listeners = new Set<Listener>();
  const nativePosted: unknown[] = [];
  const parentPosted: unknown[] = [];
  const win: BridgeWindow & { postMessage(message: unknown, targetOrigin: string): void } = {
    parent: null,
    postMessage: (message: unknown) => void parentPosted.push(message),
    location: { pathname: "/plugins/git/ui/index.html", search: "?tab=changes", origin: opts.origin ?? SERVICE },
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    document: { documentElement: { dataset: {}, style: {} } },
  };
  win.parent = win; // a real top-level window is its own parent
  if (opts.native) win.ReactNativeWebView = { postMessage: (data: string) => void nativePosted.push(data) };
  /** Deliver a message event; defaults to what the WebView host's injected window.postMessage produces. */
  const send = (data: unknown, origin = win.location.origin!, source: unknown = win) => {
    for (const l of [...listeners]) l({ data, origin, source } as MessageEvent);
  };
  return { win, send, nativePosted, parentPosted, listeners };
}

describe("plugin sdk bridge inside the iOS app's web view (window.ReactNativeWebView)", () => {
  const rnInit = { ...init, baseUrl: SERVICE };

  test("ready goes to ReactNativeWebView as a JSON string, not window.parent", () => {
    const f = fakeTopWindow({ native: true });
    void connect({ window: f.win, timeoutMs: 50 }).catch(() => {});
    expect(f.nativePosted).toEqual([JSON.stringify({ type: "harness:ready" })]);
    expect(typeof f.nativePosted[0]).toBe("string");
    expect(f.parentPosted).toEqual([]);
  });

  test("init posted to the page itself at its own (non-local) origin resolves", async () => {
    expect(isAllowedHostOrigin(SERVICE)).toBe(false); // proves this isn't the allowlist at work
    const f = fakeTopWindow({ native: true });
    const p = connect({ window: f.win });
    f.send(rnInit);
    const h = await p;
    expect(h).toMatchObject({ baseUrl: SERVICE, token: "tok", ticketKey: "HELLO-1", tabId: "changes", pluginId: "git", theme: "dark" });
  });

  test("ignores other origins (even allowlisted ones) and other sources", async () => {
    const f = fakeTopWindow({ native: true });
    let resolved = false;
    const p = connect({ window: f.win, timeoutMs: 200 }).then((h) => ((resolved = true), h));
    f.send(rnInit, "https://evil.example");
    f.send(rnInit, "http://127.0.0.1:7717"); // local, but not this page's origin
    f.send(rnInit, "file://");
    f.send(rnInit, SERVICE, { postMessage() {} }); // right origin, another window (e.g. a child iframe)
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    f.send(rnInit);
    expect((await p).token).toBe("tok");
  });

  test("an opaque page origin never trusts anything", async () => {
    const f = fakeTopWindow({ native: true, origin: "null" });
    await expect(
      (() => {
        const p = connect({ window: f.win, timeoutMs: 20 });
        f.send(rnInit, "null");
        return p;
      })(),
    ).rejects.toThrow(/Timed out/);
  });

  test("after init only the init origin is trusted; openExternal/navigate go through ReactNativeWebView", async () => {
    const f = fakeTopWindow({ native: true });
    const p = connect({ window: f.win });
    f.send(rnInit);
    const h = await p;
    const themes: string[] = [];
    const tickets: string[] = [];
    h.onTheme((t) => themes.push(t));
    h.onTicket((t) => tickets.push(t.key));
    f.send({ type: "harness:theme", theme: "light" }, "http://localhost:7717");
    f.send({ type: "harness:theme", theme: "light" }, SERVICE, { postMessage() {} });
    expect(themes).toEqual([]);
    f.send({ type: "harness:theme", theme: "light" });
    f.send({ type: "harness:ticket", ticket: ticket("HELLO-1") });
    expect(themes).toEqual(["light"]);
    expect(tickets).toEqual(["HELLO-1"]);
    expect(f.win.document!.documentElement.dataset.theme).toBe("light");
    h.openExternal("https://example.com");
    h.navigate("OTHER-2");
    expect(f.nativePosted.slice(1).map((d) => JSON.parse(d as string))).toEqual([
      { type: "harness:openExternal", url: "https://example.com" },
      { type: "harness:navigate", ticketKey: "OTHER-2" },
    ]);
    expect(f.parentPosted).toEqual([]);
  });

  test("a top-level page without ReactNativeWebView does not trust self-posted init from its own origin", async () => {
    const f = fakeTopWindow({ native: false });
    const p = connect({ window: f.win, timeoutMs: 30 });
    expect(f.parentPosted).toEqual([{ type: "harness:ready" }]); // iframe transport
    f.send(rnInit); // source = window (= window.parent here), origin = own non-local origin
    await expect(p).rejects.toThrow(/Timed out/);
  });

  test("a non-function ReactNativeWebView.postMessage falls back to the iframe transport", () => {
    const f = fakeTopWindow({ native: false });
    (f.win as { ReactNativeWebView?: unknown }).ReactNativeWebView = { postMessage: "nope" };
    void connect({ window: f.win, timeoutMs: 20 }).catch(() => {});
    expect(f.parentPosted).toEqual([{ type: "harness:ready" }]);
  });
});

describe("color themes", () => {
  function styledWindow() {
    const f = fakeWindow();
    const props = new Map<string, string>();
    const style = {
      colorScheme: undefined as string | undefined,
      setProperty: (k: string, v: string) => void props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    };
    f.win.document = { documentElement: { dataset: {}, style } };
    return { ...f, props, el: f.win.document.documentElement };
  }
  const dark = { bg: "#111214", text2: "#a4a6ae", planning: "#7c7e87", diffAdd: "#4cc38a", shadow: "0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.25)" };
  const mocha = { bg: "#181825", text2: "#afb7d3", accent: "#cba6f7" };

  test("maps token names to the app's custom property names", () => {
    expect(tokenCssVar("bg")).toBe("--harness-bg");
    expect(tokenCssVar("text2")).toBe("--harness-text-2");
    expect(tokenCssVar("in_progress")).toBe("--harness-c-in_progress");
    expect(tokenCssVar("diffAdd")).toBe("--harness-diff-add");
    expect(tokenCssVar("nonsense")).toBeNull();
  });

  test("init with a full theme exposes it and applies data-theme-id + --harness-* vars", async () => {
    const f = styledWindow();
    const p = connect({ window: f.win });
    f.send({ ...init, appearance: "dark", themeId: "harness-dark", themeName: "Harness Dark", syntaxTheme: "pierre-dark", tokens: dark });
    const h = await p;
    expect(h).toMatchObject({ theme: "dark", appearance: "dark", themeId: "harness-dark", themeName: "Harness Dark", syntaxTheme: "pierre-dark", tokens: dark });
    expect(f.el.dataset.themeId).toBe("harness-dark");
    expect(f.props.get("--harness-bg")).toBe("#111214");
    expect(f.props.get("--harness-text-2")).toBe("#a4a6ae");
    expect(f.props.get("--harness-c-planning")).toBe("#7c7e87");
    expect(f.props.get("--harness-shadow")).toBe(dark.shadow);
  });

  test("a dark → dark theme switch notifies with the new info and replaces stale vars", async () => {
    const f = styledWindow();
    const p = connect({ window: f.win });
    f.send({ ...init, themeId: "harness-dark", tokens: dark });
    const h = await p;
    const seen: [string, string | null][] = [];
    h.onTheme((t, info) => seen.push([t, info.themeId]));
    f.send({ type: "harness:theme", theme: "dark", themeId: "catppuccin-mocha", syntaxTheme: "catppuccin-mocha", tokens: mocha });
    f.send({ type: "harness:theme", theme: "dark", themeId: "catppuccin-mocha", syntaxTheme: "catppuccin-mocha", tokens: mocha }); // no change → no call
    expect(seen).toEqual([["dark", "catppuccin-mocha"]]);
    expect(h).toMatchObject({ theme: "dark", themeId: "catppuccin-mocha", syntaxTheme: "catppuccin-mocha" });
    expect(f.props.get("--harness-bg")).toBe("#181825");
    expect(f.props.get("--harness-accent")).toBe("#cba6f7");
    expect(f.props.has("--harness-c-planning")).toBe(false); // not in the new theme
    expect(f.el.dataset.themeId).toBe("catppuccin-mocha");
    // A host that stops sending tokens clears them all.
    f.send({ type: "harness:theme", theme: "light" });
    expect(seen.at(-1)).toEqual(["light", null]);
    expect([...f.props.keys()]).toEqual([]);
    expect(f.el.dataset.themeId).toBeUndefined();
    expect(h.tokens).toBeNull();
  });

  test("junk theme fields are dropped, not applied", async () => {
    const f = styledWindow();
    const p = connect({ window: f.win });
    f.send({ ...init, themeId: 42, syntaxTheme: { x: 1 }, tokens: { bg: 7, text: "red; background: url(x)", accent: "#abcdef", bogus: "#fff" } });
    const h = await p;
    expect(h.themeId).toBeNull();
    expect(h.syntaxTheme).toBeNull();
    expect(h.tokens).toEqual({ accent: "#abcdef" });
    expect([...f.props.entries()]).toEqual([["--harness-accent", "#abcdef"]]);
    expect(readThemeInfo({ theme: "dark", tokens: ["#fff"] }).tokens).toBeNull();
  });

  test("an old host (light/dark only) behaves as before: no ids, no tokens, callbacks on appearance changes", async () => {
    const f = styledWindow();
    const p = connect({ window: f.win });
    f.send(init);
    const h = await p;
    expect(h).toMatchObject({ theme: "dark", themeId: null, syntaxTheme: null, tokens: null, themeName: "" });
    expect(f.props.size).toBe(0);
    expect(f.el.dataset.themeId).toBeUndefined();
    const seen: string[] = [];
    h.onTheme((t) => seen.push(t));
    f.send({ type: "harness:theme", theme: "light" });
    f.send({ type: "harness:theme", theme: "dark" });
    expect(seen).toEqual(["light", "dark"]);
    expect(f.el.dataset.theme).toBe("dark");
  });
});
