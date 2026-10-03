import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HarnessClient, parsePairUrl, type ListenSetting } from "@harness/shared";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { stubBrowser, tempHome } from "../testing/fakes";
import {
  NetworkManager,
  defaultLocalAddresses,
  lanAddress,
  parseHostOverride,
  parseTailscaleStatus,
  resolveBindAddresses,
  type Listener,
  type TailscaleInfo,
} from "./network";

const TS: TailscaleInfo = { ip: "100.64.0.5", dnsName: "box.tail1.ts.net" };
const LOCAL = ["127.0.0.1", "::1", "192.168.1.20", "100.64.0.5"];

describe("resolveBindAddresses", () => {
  const deps = { localAddresses: () => LOCAL, tailscale: async () => TS, resolveHost: async (h: string) => (h === "box.lan" ? ["192.168.1.20"] : h === "me" ? ["127.0.0.1"] : ["203.0.113.9"]) };

  test("localhost → loopback only; any → wildcard only (it covers loopback)", async () => {
    expect(await resolveBindAddresses({ mode: "localhost" }, deps)).toEqual(["127.0.0.1"]);
    expect(await resolveBindAddresses({ mode: "any" }, deps)).toEqual(["0.0.0.0"]);
  });

  test("tailscale → the Tailscale IPv4 plus loopback", async () => {
    expect(await resolveBindAddresses({ mode: "tailscale" }, deps)).toEqual(["100.64.0.5", "127.0.0.1"]);
  });

  test("tailscale down, or its IP not on an interface yet → 409", async () => {
    await expect(resolveBindAddresses({ mode: "tailscale" }, { ...deps, tailscale: async () => null })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Tailscale isn't running") });
    await expect(resolveBindAddresses({ mode: "tailscale" }, { ...deps, localAddresses: () => ["127.0.0.1"] })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("no interface") });
  });

  test("custom: a local IP or a hostname that resolves to one, plus loopback", async () => {
    expect(await resolveBindAddresses({ mode: "custom", host: "192.168.1.20" }, deps)).toEqual(["192.168.1.20", "127.0.0.1"]);
    expect(await resolveBindAddresses({ mode: "custom", host: "box.lan" }, deps)).toEqual(["192.168.1.20", "127.0.0.1"]);
    // A host that is loopback collapses to the one loopback listener.
    expect(await resolveBindAddresses({ mode: "custom", host: "me" }, deps)).toEqual(["127.0.0.1"]);
  });

  test("custom: an address that isn't on this machine, or a lookup failure → 409", async () => {
    await expect(resolveBindAddresses({ mode: "custom", host: "10.254.254.254" }, deps)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("isn't an address of this machine") });
    await expect(resolveBindAddresses({ mode: "custom", host: "far.example" }, deps)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("resolves to 203.0.113.9") });
    await expect(resolveBindAddresses({ mode: "custom", host: "nx" }, { ...deps, resolveHost: async () => { throw new Error("ENOTFOUND"); } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Couldn't resolve nx") });
  });
});

describe("tailscale status / HARNESS_HOST parsing", () => {
  test("Running: first IPv4 and the MagicDNS name without its trailing dot", () => {
    const json = JSON.stringify({ BackendState: "Running", Self: { DNSName: "macbookpro.tail061e5.ts.net.", TailscaleIPs: ["fd7a:115c:a1e0::1", "100.107.188.66"] } });
    expect(parseTailscaleStatus(json)).toEqual({ ip: "100.107.188.66", dnsName: "macbookpro.tail061e5.ts.net" });
  });

  test("stopped, no IPv4, or not JSON → null", () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Stopped", Self: { TailscaleIPs: ["100.1.1.1"] } }))).toBeNull();
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["fd7a::1"] } }))).toBeNull();
    expect(parseTailscaleStatus("tailscale is not running")).toBeNull();
  });

  test("HARNESS_HOST keywords map to modes; anything else is a custom host", () => {
    expect(parseHostOverride(undefined)).toBeNull();
    expect(parseHostOverride(" ")).toBeNull();
    expect(parseHostOverride("127.0.0.1")).toEqual({ mode: "localhost" });
    expect(parseHostOverride("0.0.0.0")).toEqual({ mode: "any" });
    expect(parseHostOverride("tailscale")).toEqual({ mode: "tailscale" });
    expect(parseHostOverride("[fd7a::1]")).toEqual({ mode: "custom", host: "fd7a::1" });
  });

  test("lanAddress skips loopback, link-local and IPv6", () => {
    expect(lanAddress(["127.0.0.1", "fe80::1", "169.254.3.4", "192.168.1.20"])).toBe("192.168.1.20");
    expect(lanAddress(["127.0.0.1"])).toBeNull();
  });
});

/** Fake listeners: records starts/stops; `refuse` makes serve throw for an address. */
function fakeNet(opts: { tailscale?: () => TailscaleInfo | null; listen?: ListenSetting; refuse?: Set<string> } = {}) {
  const live = new Map<string, FakeListener>();
  const log: string[] = [];
  let setting: ListenSetting = opts.listen ?? { mode: "localhost" };
  let ts = opts.tailscale ?? (() => TS);
  const refuse = opts.refuse ?? new Set<string>();
  class FakeListener implements Listener {
    stops: boolean[] = [];
    constructor(public address: string, public port: number) {}
    stop(force?: boolean) {
      this.stops.push(!!force);
      if (live.get(this.address) === this) live.delete(this.address);
      log.push(`stop ${this.address}${force ? " force" : ""}`);
    }
  }
  const net = new NetworkManager({
    port: 7800,
    listen: () => setting,
    tailscale: async () => ts(),
    localAddresses: () => LOCAL,
    resolveHost: async () => ["192.168.1.20"],
    drainMs: 5,
    log: () => {},
    serve: (address, port) => {
      if (refuse.has(address)) throw new Error(`EADDRNOTAVAIL ${address}`);
      const l = new FakeListener(address, port);
      live.set(address, l);
      log.push(`start ${address}`);
      return l;
    },
  });
  return {
    net,
    live,
    log,
    refuse,
    setListen: (l: ListenSetting) => (setting = l),
    setTailscale: (fn: () => TailscaleInfo | null) => (ts = fn),
  };
}

describe("NetworkManager", () => {
  test("live rebind starts new listeners before stopping old ones and keeps shared ones", async () => {
    const f = fakeNet();
    await f.net.boot();
    const loop = f.live.get("127.0.0.1")!;
    await f.net.apply({ mode: "tailscale" });
    expect([...f.live.keys()].sort()).toEqual(["100.64.0.5", "127.0.0.1"]);
    expect(f.live.get("127.0.0.1")).toBe(loop); // not restarted
    await f.net.apply({ mode: "any" });
    // 0.0.0.0 comes up while the old two are still listening; they're retired (requests turned
    // away) and closed after the drain window.
    expect(f.log.slice(2)).toEqual(["start 0.0.0.0"]);
    expect((await f.net.status()).bound).toEqual([{ address: "0.0.0.0", url: "http://0.0.0.0:7800" }]);
    // Both retired, but 0.0.0.0 covers their addresses, so they keep serving until they close.
    expect(f.net.isRetired(loop)).toBe(false);
    expect(f.net.isRetired(f.live.get("0.0.0.0")!)).toBe(false);
    expect(loop.stops).toEqual([]);
    await Bun.sleep(20);
    expect(loop.stops).toEqual([true]);
    expect([...f.live.keys()]).toEqual(["0.0.0.0"]);
    // any → localhost: 0.0.0.0 is retired and its addresses (e.g. the LAN IP) are no longer served.
    const any = f.live.get("0.0.0.0")!;
    await f.net.apply({ mode: "localhost" });
    expect(f.net.isRetired(any)).toBe(true);
    expect(f.net.isRetired(f.live.get("127.0.0.1")!)).toBe(false);
  });

  test("a failed rebind keeps the previous listeners, undoes partial starts and reports the error", async () => {
    const f = fakeNet({ listen: { mode: "any" } });
    await f.net.boot();
    f.refuse.add("127.0.0.1");
    // tailscale = [100.64.0.5, 127.0.0.1]: the first starts, the second fails.
    await expect(f.net.apply({ mode: "tailscale" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Couldn't listen on http://127.0.0.1:7800") });
    expect([...f.live.keys()]).toEqual(["0.0.0.0"]);
    expect(f.log).toEqual(["start 0.0.0.0", "start 100.64.0.5", "stop 100.64.0.5 force"]);
    const s = await f.net.status();
    expect(s.active).toBe("any");
    expect(s.error).toContain("Couldn't listen");
    // A later success clears the error.
    f.refuse.clear();
    await f.net.apply({ mode: "localhost" });
    expect((await f.net.status()).error).toBeNull();
  });

  test("tailscale down → failed apply keeps loopback", async () => {
    const f = fakeNet({ tailscale: () => null });
    await f.net.boot();
    await expect(f.net.apply({ mode: "tailscale" })).rejects.toMatchObject({ status: 409 });
    expect([...f.live.keys()]).toEqual(["127.0.0.1"]);
  });

  test("boot falls back to localhost when the configured mode can't bind, then the retry picks it up", async () => {
    const f = fakeNet({ tailscale: () => null, listen: { mode: "tailscale" } });
    await f.net.boot();
    let s = await f.net.status();
    expect([s.mode, s.active]).toEqual(["tailscale", "localhost"]);
    expect(s.bound.map((b) => b.address)).toEqual(["127.0.0.1"]);
    expect(s.error).toContain("Tailscale isn't running");
    await expect(f.net.pairing("tok")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("Tailscale isn't running") });

    expect(await f.net.retry()).toBe(false); // still down
    f.setTailscale(() => TS);
    expect(await f.net.retry()).toBe(true);
    s = await f.net.status();
    expect([s.active, s.error]).toEqual(["tailscale", null]);
    expect(s.bound.map((b) => b.address).sort()).toEqual(["100.64.0.5", "127.0.0.1"]);
    f.net.stop();
  });

  test("the retry timer runs on its own", async () => {
    const live = new Set<string>();
    let up = false;
    const net = new NetworkManager({
      port: 7801,
      listen: () => ({ mode: "tailscale" }),
      tailscale: async () => (up ? TS : null),
      localAddresses: () => LOCAL,
      retryMs: 10,
      log: () => {},
      serve: (a) => (live.add(a), { stop: () => void live.delete(a) }),
    });
    await net.boot();
    expect([...live]).toEqual(["127.0.0.1"]);
    up = true;
    const deadline = Date.now() + 2000;
    while (!live.has("100.64.0.5") && Date.now() < deadline) await Bun.sleep(5);
    expect(live.has("100.64.0.5")).toBe(true);
    net.stop();
  });

  test("pairing prefers Tailscale, then the custom host, then a LAN IP under any; localhost refuses", async () => {
    const f = fakeNet();
    await f.net.boot();
    await expect(f.net.pairing("t")).rejects.toMatchObject({ status: 409 });
    await f.net.apply({ mode: "custom", host: "box.lan" });
    expect((await f.net.pairing("t")).url).toBe("http://box.lan:7800");
    await f.net.apply({ mode: "any" });
    expect((await f.net.pairing("t")).url).toBe("http://100.64.0.5:7800"); // 0.0.0.0 covers Tailscale
    const g = fakeNet({ tailscale: () => null, listen: { mode: "any" } });
    await g.net.boot();
    expect((await g.net.pairing("t")).url).toBe("http://192.168.1.20:7800");
  });

  test("pairUrl is exactly harness://pair?url=<enc>&token=<enc>", async () => {
    const f = fakeNet({ listen: { mode: "tailscale" } });
    await f.net.boot();
    const p = await f.net.pairing("ab+/= c");
    expect(p).toEqual({ url: "http://100.64.0.5:7800", token: "ab+/= c", pairUrl: "harness://pair?url=http%3A%2F%2F100.64.0.5%3A7800&token=ab%2B%2F%3D%20c" });
    expect(parsePairUrl(p.pairUrl)).toEqual({ url: p.url, token: p.token });
  });

  test("HARNESS_HOST override: binds it and refuses setting changes", async () => {
    const live = new Set<string>();
    const net = new NetworkManager({
      port: 7802,
      listen: () => ({ mode: "localhost" }),
      override: parseHostOverride("any"),
      overrideRaw: "any",
      log: () => {},
      serve: (a) => (live.add(a), { stop: () => void live.delete(a) }),
    });
    await net.boot();
    expect([...live]).toEqual(["0.0.0.0"]);
    await expect(net.apply({ mode: "localhost" })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("HARNESS_HOST=any") });
    expect((await net.status()).override).toBe("any");
    net.stop();
  });
});

// ---------------------------------------------------------------------------
// Real listeners through createHarness. Needs a non-loopback address on this machine.
// ---------------------------------------------------------------------------

const LAN = lanAddress(defaultLocalAddresses());

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function boot(opts: Partial<Parameters<typeof createHarness>[0]> = {}) {
  harness = await createHarness({ home: tempHome("harness-net-"), port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {}, pluginDirs: [], ...opts });
  return { h: harness, client: new HarnessClient({ baseUrl: harness.url, token: harness.token }) };
}

const reach = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(1500) }).then((r) => r.status, () => "down" as const);

describe("listen setting over real sockets", () => {
  test.skipIf(!LAN)("PATCH listen rebinds live; remote requests need the token; MCP is loopback-only; switching back closes the address", async () => {
    const { h, client } = await boot({ networkDrainMs: 400 });
    const remote = `http://${LAN}:${h.port}`;
    expect(await reach(`${remote}/health`)).toBe("down");

    const s = await client.updateSettings({ listen: { mode: "custom", host: LAN! } });
    expect(s.listen).toEqual({ mode: "custom", host: LAN! });
    expect(await reach(`${remote}/health`)).toBe(200);
    expect(await reach(`${remote}/projects`)).toBe(401);
    expect(await reach(`${remote}/projects`, { headers: { authorization: "Bearer nope" } })).toBe(401);
    expect(await reach(`${remote}/projects`, { headers: { authorization: `Bearer ${h.token}` } })).toBe(200);
    expect(await reach(`${remote}/mcp/anything`, { method: "POST" })).toBe(403);
    expect(await reach(`${h.url}/projects`)).toBe(401); // loopback needs the token too

    const net = await client.network();
    expect(net.bound.map((b) => b.address).sort()).toEqual([LAN!, "127.0.0.1"].sort());
    const pair = await client.pairing();
    expect(pair.url).toBe(remote);
    expect(pair.pairUrl).toBe(`harness://pair?url=${encodeURIComponent(remote)}&token=${encodeURIComponent(h.token)}`);

    await client.updateSettings({ listen: { mode: "localhost" } });
    expect(await reach(`${remote}/health`)).toBe(503); // retired: turned away during the drain window
    await Bun.sleep(500);
    expect(await reach(`${remote}/health`, { keepalive: false })).toBe("down");
    expect(await client.health()).toMatchObject({ ok: true });
  });

  test("bad listen values → 400; an address that isn't local → 409, old binding and setting kept", async () => {
    const { h, client } = await boot();
    await expect(client.updateSettings({ listen: { mode: "wifi" } } as never)).rejects.toMatchObject({ status: 400 });
    await expect(client.updateSettings({ listen: { mode: "custom" } })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateSettings({ listen: { mode: "custom", host: "http://x:1" } })).rejects.toMatchObject({ status: 400 });
    await expect(client.updateSettings({ listen: { mode: "custom", host: "10.254.254.254" } })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("isn't an address of this machine") });
    // Validation of the rest of the body happens before any rebind.
    await expect(client.updateSettings({ listen: { mode: "any" }, defaultDriver: "nope" })).rejects.toMatchObject({ status: 400 });
    const net = await client.network();
    expect(net.bound.map((b) => b.address)).toEqual(["127.0.0.1"]);
    expect(net.error).toContain("10.254.254.254");
    expect((await client.getSettings()).listen).toEqual({ mode: "localhost" });
    expect(h.url).toBe(`http://127.0.0.1:${h.port}`);
  });

  test.skipIf(!LAN)("boot with Tailscale down falls back to loopback and retries into the configured mode", async () => {
    let up = true;
    // Stand the LAN address in for the Tailscale one so a real listener comes up.
    const tailscale = async () => (up ? { ip: LAN!, dnsName: "box.tail.ts.net" } : null);
    const first = await boot({ tailscale });
    await first.client.updateSettings({ listen: { mode: "tailscale" } });
    const home = first.h.paths.home;
    await first.h.stop();

    up = false; // next boot: Tailscale isn't up yet
    const { h, client } = await boot({ home, tailscale, networkRetryMs: 20 });
    let net = await client.network();
    expect([net.mode, net.active, net.tailscale]).toEqual(["tailscale", "localhost", null]);
    expect(net.error).toContain("Tailscale isn't running");
    expect(await reach(`http://${LAN}:${h.port}/health`)).toBe("down");
    await expect(client.pairing()).rejects.toMatchObject({ status: 409 });

    up = true;
    const deadline = Date.now() + 3000;
    while ((await client.network()).active !== "tailscale" && Date.now() < deadline) await Bun.sleep(20);
    net = await client.network();
    expect([net.active, net.error]).toEqual(["tailscale", null]);
    expect(await reach(`http://${LAN}:${h.port}/health`)).toBe(200);
  });

  test("token rotation: old token rejected at once, file rewritten, sockets closed", async () => {
    const { h, client } = await boot();
    const old = h.token;
    let closed = false;
    const ws = new WebSocket(`${h.url.replace("http", "ws")}/ws?token=${old}`);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    ws.onclose = () => (closed = true);

    const { token } = await client.rotateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(old);
    expect(h.token).toBe(token);
    expect(readFileSync(h.paths.tokenPath, "utf8").trim()).toBe(token);
    await expect(client.listProjects()).rejects.toMatchObject({ status: 401 });
    expect(await new HarnessClient({ baseUrl: h.url, token }).listProjects()).toEqual([]);
    expect(await reach(`${h.url}/ws?token=${old}`)).toBe(401);
    const deadline = Date.now() + 2000;
    while (!closed && Date.now() < deadline) await Bun.sleep(5);
    expect(closed).toBe(true);
  });
});
