import { describe, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { connect, HarnessPluginError, isAllowedHostOrigin, pluginIdFromPath, type BridgeWindow } from "./harness-plugin";

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
