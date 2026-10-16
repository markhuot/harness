import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CdpClient, CdpClosedError, CdpError } from "../../../service/src/browser/cdp";
import { describeExtension, ExtensionRegistry, externalExtensionFile, installedExtensionDir, parseExtensionId, readManifest, removeExternalExtension, webStoreStatusProblem, writeExternalExtension, type StoredExtension } from "../../../service/src/browser/extensions";
import { frameChain, frameLabel, FrameError } from "../../../service/src/browser/frames";
import { checkCondition, describeCondition, effectiveState, seconds, timeoutMs, urlMatcher, WAIT_MAX_TIMEOUT_S } from "../../../service/src/browser/wait";
import type { MessageTransport } from "../../../service/src/browser/websocket";
import { tempDir } from "../../builders/tmp";

// ---- CDP over a transport the test drives ----

class FakeTransport implements MessageTransport {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onMessage: (text: string) => void = () => {};
  onClose: (reason: string) => void = () => {};
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  receive(msg: object) {
    this.onMessage(JSON.stringify(msg));
  }
}

const client = (opts: { timeoutMs?: number } = {}) => {
  const transport = new FakeTransport();
  return { transport, cdp: new CdpClient(transport, { timeoutMs: 60_000, ...opts }) };
};

test("a command goes out with an increasing id, the session it's for, and resolves with the matching result", async () => {
  const { transport, cdp } = client();
  const a = cdp.send("Page.navigate", { url: "x" });
  const b = cdp.send("Runtime.evaluate", { expression: "1" }, "sess-1");
  expect(transport.sent).toEqual([
    { id: 1, method: "Page.navigate", params: { url: "x" } },
    { id: 2, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "sess-1" },
  ]);
  // Answers arrive out of order.
  transport.receive({ id: 2, result: { value: 1 } });
  transport.receive({ id: 1 });
  expect(await b).toEqual({ value: 1 });
  expect(await a).toEqual({});
});

test("an error answer rejects with the method, the code and the data", async () => {
  const { transport, cdp } = client();
  const p = cdp.send("DOM.getDocument");
  transport.receive({ id: 1, error: { code: -32000, message: "No node", data: "details" } });
  await expect(p).rejects.toMatchObject({ name: "CdpError", method: "DOM.getDocument", code: -32000, message: "CDP DOM.getDocument failed: No node: details" });
  await expect(p).rejects.toBeInstanceOf(CdpError);
});

test("events reach every handler of that method with their session, a throwing handler doesn't stop the others, and unsubscribing works", () => {
  const { transport, cdp } = client();
  const seen: string[] = [];
  const off = cdp.on("Page.loadEventFired", (p, sid) => seen.push(`a:${JSON.stringify(p)}:${sid}`));
  cdp.on("Page.loadEventFired", () => {
    throw new Error("handler bug");
  });
  cdp.on("Page.loadEventFired", () => seen.push("c"));
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    transport.receive({ method: "Page.loadEventFired", params: { t: 1 }, sessionId: "s" });
    expect(seen).toEqual(['a:{"t":1}:s', "c"]);
    off();
    transport.receive({ method: "Page.loadEventFired" });
    expect(seen).toEqual(['a:{"t":1}:s', "c", "c"]);
    expect(logged).toHaveBeenCalledTimes(2);
  } finally {
    logged.mockRestore();
  }
});

test("noise on the wire is ignored: bad JSON, an answer nobody asked for, a message with neither id nor method", () => {
  const { transport, cdp } = client();
  expect(() => {
    transport.onMessage("not json");
    transport.receive({ id: 99, result: {} });
    transport.receive({ foo: 1 });
  }).not.toThrow();
  expect(cdp.closed).toBe(false);
});

test("closing rejects every command still waiting, tells close listeners once, and later commands fail at once", async () => {
  const { transport, cdp } = client();
  const reasons: string[] = [];
  cdp.onClose((r) => reasons.push(r));
  const pending = cdp.send("Page.reload");
  transport.onClose("socket closed");
  await expect(pending).rejects.toBeInstanceOf(CdpClosedError);
  await expect(pending).rejects.toThrow(/socket closed/);
  await expect(cdp.send("Page.reload")).rejects.toBeInstanceOf(CdpClosedError);
  cdp.close();
  expect(reasons).toEqual(["CDP connection closed (socket closed)"]);
  expect(cdp.closed).toBe(true);
});

test("close() from our side closes the transport and fails what's pending", async () => {
  const { transport, cdp } = client();
  const pending = cdp.send("Page.reload");
  cdp.close();
  expect(transport.closed).toBe(true);
  await expect(pending).rejects.toThrow(/closed by client/);
});

test("a transport that throws on send rejects that command as closed and leaves nothing waiting", async () => {
  const transport = new FakeTransport();
  transport.send = () => {
    throw new Error("socket is gone");
  };
  const cdp = new CdpClient(transport);
  await expect(cdp.send("X.y")).rejects.toThrow(/socket is gone/);
});

test("a target detaching fails the commands sent to it, not the ones for other sessions", async () => {
  const { transport, cdp } = client();
  const gone = cdp.send("A.b", {}, "dead");
  const alive = cdp.send("A.b", {}, "alive");
  transport.receive({ method: "Target.detachedFromTarget", params: { sessionId: "dead" } });
  await expect(gone).rejects.toThrow(/Target detached/);
  transport.receive({ id: 2, result: { ok: true } });
  expect(await alive).toEqual({ ok: true });
});

test("waitFor resolves with the first matching event of the right session and predicate, and rejects if the connection closes first", async () => {
  const { transport, cdp } = client();
  const session = cdp.session("s1");
  const first = session.waitFor("Page.frameNavigated", { predicate: (p) => p.frame.id === "wanted" });
  transport.receive({ method: "Page.frameNavigated", params: { frame: { id: "wanted" } }, sessionId: "other" });
  transport.receive({ method: "Page.frameNavigated", params: { frame: { id: "unwanted" } }, sessionId: "s1" });
  transport.receive({ method: "Page.frameNavigated", params: { frame: { id: "wanted" } }, sessionId: "s1" });
  expect(await first).toEqual({ frame: { id: "wanted" } });
  const second = cdp.waitFor("Never.happens");
  transport.onClose("gone");
  await expect(second).rejects.toBeInstanceOf(CdpClosedError);
});

test("a session sends with its own id and only hears its own events", async () => {
  const { transport, cdp } = client();
  const s = cdp.session("s9");
  const heard: unknown[] = [];
  s.on("Log.entryAdded", (p) => heard.push(p));
  void s.send("Log.enable");
  expect(transport.sent[0]).toMatchObject({ sessionId: "s9" });
  transport.receive({ method: "Log.entryAdded", params: { n: 1 }, sessionId: "s9" });
  transport.receive({ method: "Log.entryAdded", params: { n: 2 }, sessionId: "s8" });
  expect(heard).toEqual([{ n: 1 }]);
});

// ---- extensions ----

const ID = "a".repeat(32);

test("an extension ID comes from a bare ID or either Web Store's link, and from nothing else", () => {
  expect(parseExtensionId(ID)).toBe(ID);
  expect(parseExtensionId(`  ${ID}\n`)).toBe(ID);
  expect(parseExtensionId(`https://chromewebstore.google.com/detail/some-name/${ID}?hl=en`)).toBe(ID);
  expect(parseExtensionId(`https://chrome.google.com/webstore/detail/some-name/${ID}`)).toBe(ID);
  expect(parseExtensionId(`https://evil.test/detail/x/${ID}`)).toBeNull();
  expect(parseExtensionId("z".repeat(32))).toBeNull();
  expect(parseExtensionId("not an id")).toBeNull();
});

function extensionDir(manifest: object, locales: Record<string, object> = {}) {
  const dir = tempDir();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [locale, messages] of Object.entries(locales)) {
    mkdirSync(join(dir, "_locales", locale), { recursive: true });
    writeFileSync(join(dir, "_locales", locale, "messages.json"), JSON.stringify(messages));
  }
  return dir;
}

test("a manifest gives the name, version, whether it has a toolbar action, and its options page", () => {
  expect(readManifest(extensionDir({ name: "Tool", version: "1.2", description: "d", action: {}, options_ui: { page: "options.html" } }))).toEqual({ name: "Tool", version: "1.2", description: "d", hasAction: true, optionsPage: "options.html" });
  expect(readManifest(extensionDir({ name: "Old", browser_action: {}, options_page: "o.html" }))).toMatchObject({ hasAction: true, optionsPage: "o.html", version: "" });
  expect(readManifest(extensionDir({ version: "1" }))).toMatchObject({ name: "Unnamed extension", hasAction: false });
});

test("__MSG_ names come from the default locale, then English, matching keys without case", () => {
  const dir = extensionDir({ name: "__MSG_appName__", description: "__MSG_Desc__", default_locale: "de", version: "1" }, { de: { APPNAME: { message: "Werkzeug" } }, en: { desc: { message: "A tool" } } });
  expect(readManifest(dir)).toMatchObject({ name: "Werkzeug", description: "A tool" });
  expect(readManifest(extensionDir({ name: "__MSG_missing__", version: "1" })).name).toBe("__MSG_missing__");
});

test("a folder without a readable manifest says why", () => {
  expect(() => readManifest(tempDir())).toThrow(/no manifest\.json/);
  const bad = tempDir();
  writeFileSync(join(bad, "manifest.json"), "{oops");
  expect(() => readManifest(bad)).toThrow(/isn't valid JSON/);
  const notObject = tempDir();
  writeFileSync(join(notObject, "manifest.json"), "5");
  expect(() => readManifest(notObject)).toThrow(/isn't an extension manifest/);
});

test("Chrome's install of a Web Store extension is its newest version's folder", () => {
  const profile = tempDir();
  expect(installedExtensionDir(profile, ID)).toBeNull();
  for (const v of ["1.9_0", "1.10_0", "1.2_0"]) {
    mkdirSync(join(profile, "Default", "Extensions", ID, v), { recursive: true });
    writeFileSync(join(profile, "Default", "Extensions", ID, v, "manifest.json"), "{}");
  }
  mkdirSync(join(profile, "Default", "Extensions", ID, "2.0_0"));
  expect(installedExtensionDir(profile, ID)).toBe(join(profile, "Default", "Extensions", ID, "1.10_0"));
});

test("asking Chrome to install from the store writes a file, and stopping removes it", () => {
  const profile = tempDir();
  writeExternalExtension(profile, ID);
  const file = externalExtensionFile(profile, ID);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ external_update_url: "https://clients2.google.com/service/update2/crx" });
  removeExternalExtension(profile, ID);
  expect(existsSync(file)).toBe(false);
  expect(() => removeExternalExtension(profile, ID)).not.toThrow();
});

test("each Web Store status is either installable, already installed, or a refusal with an HTTP status and a reason", () => {
  expect(webStoreStatusProblem("installable", "X")).toBeNull();
  for (const s of ["enabled", "disabled", "terminated"]) expect(webStoreStatusProblem(s, "X")).toBe("installed");
  expect(webStoreStatusProblem("force_installed", "X")).toMatchObject({ status: 409 });
  for (const s of ["can_request", "request_pending", "blocked_by_policy", "blocklisted", "custodian_approval_required"]) expect(webStoreStatusProblem(s, "X")).toMatchObject({ status: 403 });
  expect(webStoreStatusProblem("deprecated_manifest_version", "X")).toMatchObject({ status: 422 });
  expect(webStoreStatusProblem("brand_new_status", "Thing")).toEqual({ status: 422, message: `Chrome can't install Thing (its Web Store status is "brand_new_status").` });
});

test("the registry keeps what the user added in a file, replaces by ID, ignores malformed entries and a missing file", () => {
  const root = join(tempDir(), "chrome-extensions");
  const registry = new ExtensionRegistry(root);
  expect(registry.list()).toEqual([]);
  const entry = (id: string, over: Partial<StoredExtension> = {}): StoredExtension => ({ id, name: id, version: "1", source: "webstore", enabled: true, addedAt: 1, ...over });
  registry.put(entry("a"));
  registry.put(entry("b", { source: "unpacked", path: "/ext/b" }));
  registry.put(entry("a", { enabled: false }));
  expect(registry.list().map((e) => [e.id, e.enabled])).toEqual([["b", true], ["a", false]]);
  expect(registry.get("b")).toMatchObject({ path: "/ext/b" });
  expect(registry.remove("b")?.id).toBe("b");
  expect(registry.remove("zzz")).toBeUndefined();
  writeFileSync(join(root, "extensions.json"), JSON.stringify({ extensions: [{ id: "x", source: "unpacked" }, { id: 5 }, entry("ok")] }));
  expect(registry.list().map((e) => e.id)).toEqual(["ok"]);
  writeFileSync(join(root, "extensions.json"), "{broken");
  expect(registry.list()).toEqual([]);
});

test("an extension is described from its manifest when it can be read, and an unpacked one whose folder is gone is an error", () => {
  const dir = extensionDir({ name: "Fresh name", version: "2", action: {}, options_page: "/opts.html" });
  const entry: StoredExtension = { id: ID, name: "Old name", version: "1", source: "unpacked", path: dir, enabled: true, addedAt: 5 };
  expect(describeExtension(entry, dir, { status: "loaded" })).toMatchObject({ name: "Fresh name", version: "2", hasAction: true, optionsUrl: `chrome-extension://${ID}/opts.html`, status: "loaded", addedAt: 5 });
  const missing = describeExtension(entry, join(dir, "gone"), { status: "loaded" });
  expect(missing).toMatchObject({ name: "Old name", status: "error" });
  expect(missing.error).toContain("is missing or has no readable manifest.json");
  // A Web Store extension Chrome hasn't installed yet isn't an error.
  expect(describeExtension({ ...entry, source: "webstore", path: undefined }, null, { status: "pending" })).toMatchObject({ status: "pending", error: undefined });
});

// ---- waits and frames ----

test("a wait condition needs something to wait for, and every field is checked", () => {
  const ok = (c: unknown, ref?: string) => {
    const r = checkCondition(c, ref);
    if (!r.ok) throw new Error(r.error);
    return r.condition;
  };
  const err = (c: unknown, ref?: string) => {
    const r = checkCondition(c, ref);
    if (r.ok) throw new Error("accepted");
    return r.error;
  };
  expect(ok({ selector: ".done", state: "gone", timeout: 5 })).toEqual({ selector: ".done", state: "gone", timeout: 5 });
  expect(ok({ idle: true })).toEqual({ idle: true });
  expect(ok({ frame: ["#a"] })).toEqual({ frame: "#a" });
  expect(ok({ frame: '["#a","#b"]', text: "x" })).toEqual({ frame: ["#a", "#b"], text: "x" });
  expect(ok({}, "e5")).toEqual({ ref: "e5" });
  expect(err("x")).toMatch(/is an object/);
  expect(err([])).toMatch(/is an object/);
  expect(err({ selecter: "x" })).toMatch(/Unknown wait condition field: selecter/);
  expect(err({})).toMatch(/Say what to wait for/);
  expect(err({ timeout: 5 })).toMatch(/Say what to wait for/);
  expect(err({ selector: "" })).toMatch(/selector must be a non-empty string/);
  expect(err({ selector: "a", state: "open" })).toMatch(/state must be one of/);
  expect(err({ state: "visible" })).toMatch(/state needs a selector or text/);
  expect(err({ selector: "a", count: -1 })).toMatch(/count must be a whole number/);
  expect(err({ text: "a", count: 1 })).toMatch(/count needs a selector/);
  expect(err({ selector: "a", attribute: { value: "x" } })).toMatch(/attribute is \{ name, value\? \}/);
  expect(err({ selector: "a", attribute: { name: "x", extra: 1 } })).toMatch(/has no extra/);
  expect(err({ selector: "a", timeout: WAIT_MAX_TIMEOUT_S + 1 })).toMatch(/at most 120/);
  expect(err({ selector: "a", timeout: 0 })).toMatch(/more than 0/);
  expect(err({ url: "/(/" })).toMatch(/isn't a valid regex/);
  expect(err({ selector: "a" }, "e1")).toMatch(/give it without selector or frame/);
  expect(err({ idle: "yes" })).toMatch(/idle must be true or false/);
});

test("a url condition is a substring, or a regex when written between slashes", () => {
  expect(urlMatcher("/cart")("https://x.test/cart?x=1")).toBe(true);
  expect(urlMatcher("/cart")("https://x.test/shop")).toBe(false);
  expect(urlMatcher("/\\/item\\/\\d+$/")("https://x.test/item/42")).toBe(true);
  expect(urlMatcher("/ITEM/i")("https://x.test/item/42")).toBe(true);
  expect(urlMatcher("/")("anything/")).toBe(true);
});

test("a condition reads back in a few words, with the state it implies", () => {
  expect(describeCondition({ selector: "button", state: "gone" })).toBe('"button" gone');
  expect(describeCondition({ selector: "li", count: 3 })).toBe('"li" count 3');
  expect(describeCondition({ selector: "input", value: "x", attribute: { name: "disabled" } })).toBe('"input" value "x", attribute disabled');
  expect(describeCondition({ text: "Saved", url: "/done/", idle: true })).toBe('text "Saved" visible, URL matches /done/, network idle');
  expect(describeCondition({ frame: ["#a", "#b"] })).toBe('frame ["#a","#b"] loaded');
  expect(describeCondition({ ref: "e4", state: "enabled" })).toBe("ref e4 enabled");
  expect(effectiveState({ selector: "a" })).toBe("visible");
  expect(effectiveState({ selector: "a", count: 1 })).toBeUndefined();
  expect(timeoutMs({ selector: "a" })).toBe(15_000);
  expect(timeoutMs({ selector: "a", timeout: 2.5 })).toBe(2500);
  expect(seconds(8400)).toBe("8.4s");
});

test("a frame is a selector or a chain of them, and a JSON array sent as text counts as the array", () => {
  expect(frameChain("#a")).toEqual(["#a"]);
  expect(frameChain(["#a", "#b"])).toEqual(["#a", "#b"]);
  expect(frameChain('["#a","#b"]')).toEqual(["#a", "#b"]);
  expect(frameChain("[name=card]")).toEqual(["[name=card]"]);
  for (const bad of [[], [""], ["#a", 5], "", 5, null]) expect(() => frameChain(bad)).toThrow(FrameError);
  expect(frameLabel(["#a"])).toBe('"#a"');
  expect(frameLabel(["#a", "#b"])).toBe('["#a","#b"]');
});
