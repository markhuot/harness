import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { BrowserManager } from "./manager.ts";
import { authHits, chromePath, fixtures, memoryTabStore, profileDir, SECRET_LOGIN, until, withChrome } from "./test-support.ts";
import { authKey, basicRealm, stripUserinfo } from "./auth.ts";

test("basicRealm finds the Basic challenge among others and unquotes its realm", () => {
  expect(basicRealm('Basic realm="Vault"')).toBe("Vault");
  expect(basicRealm('Bearer realm="api", Basic realm="a \\"b\\" c"')).toBe('a "b" c');
  expect(basicRealm("Basic")).toBe("");
  expect(basicRealm('Digest realm="x"')).toBeNull();
  expect(basicRealm(undefined)).toBeNull();
});

test("stripUserinfo removes a password from a URL and leaves others alone", () => {
  expect(stripUserinfo("https://bob:pw@example.com/a?b=1")).toBe("https://example.com/a?b=1");
  expect(stripUserinfo("https://example.com/a@b")).toBe("https://example.com/a@b");
  expect(stripUserinfo("not a url@")).toBe("not a url@");
});

withChrome("BrowserManager HTTP Basic Auth (real Chrome)", () => {
  // Chrome keeps a profile-wide HTTP auth cache (a login answers the whole origin from then on), so each
  // test gets an origin of its own.
  const servers: Server<unknown>[] = [];
  const site = () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixtures });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
  };
  let browser: BrowserManager;
  let store: ReturnType<typeof memoryTabStore>;

  beforeAll(() => {
    store = memoryTabStore();
    browser = new BrowserManager({ profileDir, chromePath: chromePath!, navigationTimeoutMs: 10_000, tabStore: store });
  });

  afterAll(async () => {
    await browser?.shutdown();
    for (const server of servers) void server.stop(true);
  }, 30_000);

  const here = (origin: string) => ({ origin, realm: "Vault" });
  const auth = async (session: string, tab?: number) => (await browser.state(session, { tab }))?.auth;
  const body = (session: string, selector = "h1") => browser.content(session, { selector });

  test("a challenged page shows as auth state; wrong credentials are refused once and re-prompt; right ones load it", async () => {
    const s = "auth-flow";
    const base = site();
    const states: unknown[] = [];
    await browser.subscribe(s, "v1", () => {}, (st) => states.push(st.auth ?? null));
    await browser.open(s, `${base}/secret`);
    expect(await auth(s)).toEqual({ origin: base, realm: "Vault" });
    expect((await browser.tabs(s))[0]!.auth).toEqual({ origin: base, realm: "Vault" });

    const before = authHits.length;
    await browser.input(s, { type: "auth", ...here(base), username: "alice", password: "wrong" });
    const failed = await until(async () => (await auth(s))?.failed, "the refusal");
    expect(failed).toBe(true);
    // The wrong password went out once with the retry and was never reused.
    const wrongSent = authHits.slice(before).filter((h) => h === `Basic ${btoa("alice:wrong")}`);
    expect(wrongSent).toHaveLength(1);

    await browser.input(s, { type: "auth", ...here(base), ...SECRET_LOGIN });
    await until(async () => (await body(s).catch(() => "")) === "Secret ok", "the page behind the login");
    expect(await auth(s)).toBeUndefined();
    // Viewers saw the prompt and its end, and never a credential.
    expect(states).toContainEqual({ origin: base, realm: "Vault" });
    expect(states.at(-1)).toBeNull();
    expect(JSON.stringify(await browser.state(s))).not.toContain("s3cret");
  }, 30_000);

  test("cancel clears the prompt and does not load the page", async () => {
    const s = "auth-cancel";
    const base = site();
    await browser.open(s, `${base}/secret`);
    expect(await auth(s)).toBeDefined();
    await browser.input(s, { type: "authCancel", ...here(base) });
    expect(await auth(s)).toBeUndefined();
    expect(await body(s, "body").catch(() => "")).not.toContain("Secret ok");
  }, 30_000);

  // Headless Chrome reports no response for a challenged subresource, so only once interception is
  // on (after a first answer) do a page's scripts reach the prompt.
  test("with interception on, several challenged scripts make one prompt, and one answer loads them all", async () => {
    const s = "auth-many";
    const base = site();
    await browser.open(s, `${base}/secret`);
    await browser.input(s, { type: "auth", ...here(base), username: "alice", password: "wrong" });
    await until(async () => (await auth(s))?.failed, "the refusal");
    await browser.input(s, { type: "authCancel", ...here(base) });

    await browser.open(s, `${base}/vault`);
    const prompt = await until(() => auth(s), "the scripts' prompt");
    expect(prompt).toEqual({ origin: base, realm: "Vault" }); // not "failed": that was the earlier credentials
    const before = authHits.length;
    await browser.input(s, { type: "auth", ...here(base), ...SECRET_LOGIN });
    await until(async () => (await browser.content(s, { selector: "#out" }).catch(() => "")) === "scripts ok", "both scripts to load");
    expect(await auth(s)).toBeUndefined();
    expect(authHits.slice(before).filter((h) => h === `Basic ${btoa("alice:s3cret")}`).length).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("credentials a session already has answer a new challenge without a prompt", async () => {
    const s = "auth-kept";
    const base = site();
    // What an earlier answer left (Chrome's own cache doesn't outlive Chrome; these outlive the page).
    (browser as any).entry(s).credentials.set(authKey(base, "Vault"), SECRET_LOGIN);
    await browser.open(s, `${base}/secret`);
    await until(async () => (await body(s).catch(() => "")) === "Secret ok", "the kept login to apply");
    expect(await auth(s)).toBeUndefined();
  }, 30_000);

  test("a password in the URL never reaches stored tabs, the tab list or state", async () => {
    const s = "auth-url";
    const base = site();
    const u = new URL(`${base}/secret`);
    u.username = SECRET_LOGIN.username;
    u.password = SECRET_LOGIN.password;
    const state = await browser.open(s, u.href);
    expect(await body(s)).toBe("Secret ok");
    await until(() => store.rows.get(s), "the tab to be stored");
    for (const text of [JSON.stringify(state), JSON.stringify(await browser.tabs(s)), JSON.stringify(await browser.tabInfo(s, 1)), JSON.stringify(store.rows.get(s))]) {
      expect(text).not.toContain("s3cret");
    }
  }, 30_000);

  const tabOf = (session: string) => (browser as any).entry(session).tabs.get(1);

  test("an answer for another origin is dropped, and a subresource challenge can't take over the prompt", async () => {
    const s = "auth-origin";
    const base = site();
    await browser.open(s, `${base}/secret`);
    const tab = tabOf(s);
    const document = tab.authDocument;
    expect(document).toBe(`${base}/secret`);

    // A third party's image or XHR is challenged while the viewer types.
    (browser as any).askForAuth(tab, "https://evil.example", "Vault", false, undefined);
    expect(await auth(s)).toEqual({ origin: base, realm: "Vault" });
    expect(tab.authDocument).toBe(document);

    // An answer that names the other challenge is not stored for either origin.
    const before = authHits.length;
    await browser.input(s, { type: "auth", origin: "https://evil.example", realm: "Vault", ...SECRET_LOGIN });
    expect((browser as any).entry(s).credentials.size).toBe(0);
    expect(authHits.length).toBe(before);
    expect(await auth(s)).toEqual({ origin: base, realm: "Vault" });

    await browser.input(s, { type: "auth", ...here(base), ...SECRET_LOGIN });
    await until(async () => (await body(s).catch(() => "")) === "Secret ok", "the page behind the login");
  }, 30_000);

  test("a cancelled challenge isn't asked again until the next main-frame navigation", async () => {
    const s = "auth-cancel-kept";
    const base = site();
    await browser.open(s, `${base}/secret`);
    await browser.input(s, { type: "authCancel", ...here(base) });
    const tab = tabOf(s);
    (browser as any).askForAuth(tab, base, "Vault", false, undefined);
    expect(await auth(s)).toBeUndefined();
    // Another realm is a different question.
    (browser as any).askForAuth(tab, base, "Other", false, undefined);
    expect(await auth(s)).toEqual({ origin: base, realm: "Other" });
    await browser.input(s, { type: "authCancel", origin: base, realm: "Other" });

    await browser.open(s, `${base}/secret`);
    expect(await until(() => auth(s), "the prompt after navigating again")).toEqual({ origin: base, realm: "Vault" });
  }, 30_000);

  test("a failed Fetch.enable leaves no listeners behind to double up on the retry", async () => {
    const s = "auth-fetch-fail";
    const base = site();
    await browser.open(s, `${base}/`);
    const tab = tabOf(s);
    const send = tab.session.send.bind(tab.session);
    tab.session.send = (method: string, ...rest: unknown[]) => (method === "Fetch.enable" ? Promise.reject(new Error("no")) : (send as any)(method, ...rest));
    const offs = tab.offs.length;
    await expect((browser as any).interceptAuth(tab)).rejects.toThrow("no");
    expect(tab.offs.length).toBe(offs);
    expect(tab.intercept).toBe(false);
    tab.session.send = send;
    await (browser as any).interceptAuth(tab);
    expect(tab.offs.length).toBe(offs + 2);
  }, 30_000);

  test("page events carry the URL without a password", async () => {
    const s = "auth-events";
    const base = site();
    const events: string[] = [];
    browser.watch(s, (e) => events.push(JSON.stringify(e)));
    const u = new URL(`${base}/secret`);
    u.username = SECRET_LOGIN.username;
    u.password = SECRET_LOGIN.password;
    await browser.open(s, u.href);
    const waited = await browser.waitFor(s, { idle: true }, {});
    expect(events.some((e) => e.includes('"navigated"'))).toBe(true);
    expect(events.join("\n")).not.toContain("s3cret");
    expect(waited.url).not.toContain("s3cret");
    expect(waited.summary).not.toContain("s3cret");
  }, 30_000);
});
