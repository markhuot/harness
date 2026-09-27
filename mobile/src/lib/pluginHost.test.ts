import { describe, expect, test } from "bun:test";
import type { Ticket } from "@harness/shared";
import { createPluginHostBridge, pluginUiUrl, type ResolvedTheme } from "@harness/shared/state";
import { connect, type BridgeWindow } from "../../../plugins/sdk/harness-plugin";
import { buildInjection, createWebViewFrame, webViewMessageEvent } from "./pluginHost";

const SERVICE = "http://100.64.1.2:7717"; // Tailscale address, not on the SDK's localhost allowlist

type Listener = (e: MessageEvent) => void;

/**
 * A page inside react-native-webview: ReactNativeWebView is injected, and window.postMessage
 * dispatches a message event (asynchronously, like a browser) with source = window and
 * origin = location.origin, dropping it when targetOrigin doesn't match.
 */
function fakeWebViewPage(url: string) {
  const listeners = new Set<Listener>();
  const selfPosts: { message: unknown; targetOrigin: string }[] = [];
  const toHost: string[] = [];
  let onNative: (data: string) => void = () => {};
  const u = new URL(url);
  const location = { origin: u.origin, pathname: u.pathname, search: u.search, href: u.href };
  const win: BridgeWindow & { postMessage(message: unknown, targetOrigin: string): void } = {
    parent: null,
    location,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    document: { documentElement: { dataset: {}, style: {} } },
    ReactNativeWebView: {
      postMessage(data: string) {
        toHost.push(data);
        onNative(data);
      },
    },
    postMessage(message: unknown, targetOrigin: string) {
      selfPosts.push({ message, targetOrigin });
      if (targetOrigin !== "*" && targetOrigin !== location.origin) return;
      const data = structuredClone(message);
      const origin = location.origin;
      queueMicrotask(() => {
        for (const l of [...listeners]) l({ data, origin, source: win } as unknown as MessageEvent);
      });
    },
  };
  win.parent = win;
  /** What react-native-webview's injectJavaScript does: run the script in the page. */
  const run = (script: string) => new Function("window", "location", script)(win, location);
  const navigateTo = (next: string) => {
    const n = new URL(next);
    Object.assign(location, { origin: n.origin, pathname: n.pathname, search: n.search, href: n.href });
  };
  return { win, location, listeners, selfPosts, toHost, run, navigateTo, setOnNative: (f: (data: string) => void) => (onNative = f) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("buildInjection", () => {
  test("delivers the exact message, even with quotes, backslashes, newlines, U+2028/9 and </script>", async () => {
    const token = `a"b'c\\d\ne\r\u2028f\u2029g</script><script>globalThis.pwned=1</script>\`\${x}\``;
    const msg = { type: "harness:init", token, nested: { list: [1, null, "\u0000"] } };
    const script = buildInjection(msg, SERVICE);
    expect(script).not.toMatch(/[\u2028\u2029\n\r]/);
    expect(script.endsWith("true;")).toBe(true);
    const page = fakeWebViewPage(`${SERVICE}/plugins/git/ui/index.html`);
    const got: unknown[] = [];
    page.win.addEventListener("message", (e) => got.push(e.data));
    page.run(script);
    await flush();
    expect(got).toEqual([msg]);
    expect(page.selfPosts.map((p) => p.targetOrigin)).toEqual([SERVICE]);
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
  });

  test("does nothing when the page is at another origin", () => {
    const page = fakeWebViewPage("https://evil.example/");
    page.run(buildInjection({ type: "harness:init", token: "secret" }, SERVICE));
    expect(page.selfPosts).toEqual([]);
  });

  test("an origin string can't break out of the guard", () => {
    const page = fakeWebViewPage("https://evil.example/");
    page.run(buildInjection({ token: "secret" }, `x" || true || "`));
    expect(page.selfPosts).toEqual([]);
  });
});

describe("webViewMessageEvent", () => {
  const frame = {};
  test("parses data and takes the origin of the page URL", () => {
    expect(webViewMessageEvent({ data: '{"type":"harness:ready"}', url: `${SERVICE}/plugins/git/ui/index.html?tab=changes` }, frame)).toEqual({
      data: { type: "harness:ready" },
      origin: SERVICE,
      source: frame,
    });
  });
  test("null on bad JSON or a bad URL", () => {
    expect(webViewMessageEvent({ data: "{nope", url: SERVICE }, frame)).toBeNull();
    expect(webViewMessageEvent({ data: "{}", url: "not a url" }, frame)).toBeNull();
  });
});

describe("SDK connect() ↔ createPluginHostBridge over the WebView transport (end to end)", () => {
  function setup() {
    const page = fakeWebViewPage(pluginUiUrl(SERVICE, "git", "changes"));
    const injected: string[] = [];
    const frame = createWebViewFrame((script) => {
      injected.push(script);
      page.run(script);
    });
    const navigated: string[] = [];
    const opened: string[] = [];
    let theme: ResolvedTheme = "dark";
    const bridge = createPluginHostBridge({
      baseUrl: `${SERVICE}/`,
      token: 'tok"en\\with\nstuff',
      ticketKey: "HELLO-1",
      tabId: "changes",
      frame: () => frame,
      theme: () => theme,
      onNavigate: (k) => void navigated.push(k),
      onOpenExternal: (u) => void opened.push(u),
    });
    const accepted: boolean[] = [];
    // The RN host's onMessage handler: nativeEvent.url is the page's current URL.
    page.setOnNative((data) => {
      const e = webViewMessageEvent({ data, url: page.location.href }, frame);
      accepted.push(e ? bridge.onMessage(e) : false);
    });
    return { page, bridge, injected, navigated, opened, accepted, setTheme: (t: ResolvedTheme) => (theme = t) };
  }

  test("init, theme and ticket pushes reach the plugin; navigate/openExternal reach the host", async () => {
    const s = setup();
    const h = await connect({ window: s.page.win, timeoutMs: 500 });
    expect(s.accepted).toEqual([true]); // harness:ready
    expect(h).toMatchObject({ baseUrl: SERVICE, token: 'tok"en\\with\nstuff', ticketKey: "HELLO-1", tabId: "changes", pluginId: "git", theme: "dark" });

    const themes: string[] = [];
    const tickets: Ticket[] = [];
    h.onTheme((t) => themes.push(t));
    h.onTicket((t) => tickets.push(t));
    s.bridge.sendTheme("light");
    s.bridge.sendTicket({ key: "HELLO-1", status: "done" } as Ticket);
    s.bridge.sendTicket({ key: "OTHER-2", status: "done" } as Ticket); // filtered by the host
    await flush();
    expect(themes).toEqual(["light"]);
    expect(s.page.win.document!.documentElement.dataset.theme).toBe("light");
    expect(tickets.map((t) => [t.key, t.status])).toEqual([["HELLO-1", "done"]]);

    h.navigate("OTHER-2");
    h.openExternal("https://example.com/x");
    h.openExternal("javascript:alert(1)"); // the host refuses it
    expect(s.navigated).toEqual(["OTHER-2"]);
    expect(s.opened).toEqual(["https://example.com/x"]);
    expect(s.accepted).toEqual([true, true, true, false]);
  });

  test("after the page navigates away, injected init (the token) is not delivered and its messages are refused", async () => {
    const s = setup();
    const h = await connect({ window: s.page.win, timeoutMs: 500 });
    const tokens: string[] = [];
    // Anything on the new page listening for messages:
    s.page.win.addEventListener("message", (e) => tokens.push((e.data as { token?: string }).token ?? ""));
    s.page.navigateTo("https://evil.example/phish");
    const postsBefore = s.page.selfPosts.length;
    const injectedBefore = s.injected.length;
    s.bridge.onLoad(); // host re-offers init on load
    await flush();
    expect(s.injected.length).toBe(injectedBefore + 1); // the host did try…
    expect(s.page.selfPosts.length).toBe(postsBefore); // …but the guard stopped window.postMessage
    expect(tokens).toEqual([]);

    // A ready/navigate sent from the foreign page is rejected by the host (origin check).
    h.navigate("OTHER-3");
    s.page.win.ReactNativeWebView!.postMessage(JSON.stringify({ type: "harness:ready" }));
    expect(s.navigated).toEqual([]);
    expect(s.accepted.slice(-2)).toEqual([false, false]);
    expect(s.injected.length).toBe(injectedBefore + 1); // no init sent in reply to that ready
  });
});
