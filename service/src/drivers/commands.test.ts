import { describe, expect, test } from "bun:test";
import { FakeDriver } from "../testing/fakes";
import { CommandCatalog } from "./commands";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("CommandCatalog", () => {
  test("caches per driver and folder until the TTL passes", async () => {
    const c = clock();
    const cat = new CommandCatalog({ ttlMs: 1000, now: c.now });
    const d = new FakeDriver("d");
    d.commands = async (cwd) => [{ name: cwd.slice(1), description: "" }];
    expect(await cat.get(d, "/a")).toEqual([{ name: "a", description: "" }]);
    expect(await cat.get(d, "/b")).toEqual([{ name: "b", description: "" }]);
    c.advance(999);
    await cat.get(d, "/a");
    expect(d.listCommandsCalls).toEqual(["/a", "/b"]);
    c.advance(1);
    await cat.get(d, "/a");
    expect(d.listCommandsCalls).toEqual(["/a", "/b", "/a"]);
  });

  test("a stale list answers at once while it refreshes; the next lookup gets the new one", async () => {
    const c = clock();
    const cat = new CommandCatalog({ ttlMs: 1000, now: c.now });
    const d = new FakeDriver("d");
    d.commands = [{ name: "old", description: "" }];
    await cat.get(d, "/w");
    c.advance(1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    d.commands = async () => (await gate, [{ name: "new", description: "" }]);
    expect(await cat.get(d, "/w")).toEqual([{ name: "old", description: "" }]);
    expect(await cat.get(d, "/w")).toEqual([{ name: "old", description: "" }]);
    release();
    await Bun.sleep(0);
    expect(await cat.get(d, "/w")).toEqual([{ name: "new", description: "" }]);
    expect(d.listCommandsCalls).toHaveLength(2);
  });

  test("a failed refresh keeps the last good list", async () => {
    const c = clock();
    const cat = new CommandCatalog({ ttlMs: 1000, errorTtlMs: 100, now: c.now });
    const d = new FakeDriver("d");
    d.commands = [{ name: "good", description: "" }];
    await cat.get(d, "/w");
    c.advance(1000);
    d.commands = async () => {
      throw new Error("boom");
    };
    await cat.get(d, "/w");
    await Bun.sleep(0);
    expect(await cat.get(d, "/w")).toEqual([{ name: "good", description: "" }]);
    expect(d.listCommandsCalls).toHaveLength(2);
  });

  test("concurrent lookups share one listing", async () => {
    const cat = new CommandCatalog();
    const d = new FakeDriver("d");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    d.commands = async () => (await gate, [{ name: "x", description: "" }]);
    const both = Promise.all([cat.get(d, "/w"), cat.get(d, "/w")]);
    release();
    expect((await both).map((l) => l.length)).toEqual([1, 1]);
    expect(d.listCommandsCalls).toHaveLength(1);
  });

  test("a failure is an empty list, logged, and retried after the error TTL", async () => {
    const c = clock();
    const logs: string[] = [];
    const cat = new CommandCatalog({ ttlMs: 60_000, errorTtlMs: 100, now: c.now, log: (m) => logs.push(m) });
    const d = new FakeDriver("d");
    d.commands = async () => {
      throw new Error("not logged in");
    };
    expect(await cat.get(d, "/w")).toEqual([]);
    expect(logs[0]).toContain("not logged in");
    await cat.get(d, "/w");
    expect(d.listCommandsCalls).toHaveLength(1);
    d.commands = [{ name: "ok", description: "" }];
    c.advance(100);
    expect(await cat.get(d, "/w")).toEqual([{ name: "ok", description: "" }]);
  });

  test("a driver without commands lists none", async () => {
    expect(await new CommandCatalog().get(new FakeDriver("plain"), "/w")).toEqual([]);
  });
});
