import { describe, expect, test } from "bun:test";
import { FakeDriver } from "../testing/fakes";
import { ModelCatalog } from "./models";
import { ModelListError } from "./types";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("ModelCatalog", () => {
  test("caches per driver until the TTL passes", async () => {
    const c = clock();
    const cat = new ModelCatalog({ ttlMs: 1000, now: c.now });
    const a = new FakeDriver("a");
    const b = new FakeDriver("b");
    b.models = [{ id: "b1", name: "B1" }];
    expect((await cat.get(a)).models.map((m) => m.id)).toEqual(["fake-model"]);
    expect((await cat.get(b)).models.map((m) => m.id)).toEqual(["b1"]);
    c.advance(999);
    await cat.get(a);
    expect(a.listModelsCalls).toBe(1);
    c.advance(1);
    const again = await cat.get(a);
    expect(a.listModelsCalls).toBe(2);
    expect(again.fetchedAt).toBe(2000);
  });

  test("refresh bypasses the cache; invalidate drops it", async () => {
    const cat = new ModelCatalog({ ttlMs: 60_000 });
    const d = new FakeDriver("d");
    await cat.get(d);
    d.models = [{ id: "new", name: "New" }];
    expect((await cat.get(d)).models[0]!.id).toBe("fake-model");
    expect((await cat.get(d, { refresh: true })).models[0]!.id).toBe("new");
    d.models = [{ id: "newer", name: "Newer" }];
    cat.invalidate("d");
    expect((await cat.get(d)).models[0]!.id).toBe("newer");
    expect(d.listModelsCalls).toBe(3);
  });

  test("concurrent lookups share one driver call", async () => {
    const cat = new ModelCatalog();
    const d = new FakeDriver("d");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    d.models = async () => {
      await gate;
      return [{ id: "x", name: "X" }];
    };
    const p1 = cat.get(d);
    const p2 = cat.get(d);
    release();
    expect(await p1).toBe(await p2);
    expect(d.listModelsCalls).toBe(1);
  });

  test("failures become data: [] + error, or the ModelListError fallback; cached for the short error TTL", async () => {
    const c = clock();
    const cat = new ModelCatalog({ ttlMs: 10_000, errorTtlMs: 100, now: c.now });
    const d = new FakeDriver("d");
    d.models = async () => {
      throw new Error("no key");
    };
    expect(await cat.get(d)).toEqual({ driverId: "d", models: [], error: "no key", fetchedAt: 1000 });
    const f = new FakeDriver("f");
    f.models = async () => {
      throw new ModelListError("cli broke", [{ id: "sonnet", name: "Sonnet" }]);
    };
    const res = await cat.get(f);
    expect(res.error).toBe("cli broke");
    expect(res.models).toEqual([{ id: "sonnet", name: "Sonnet" }]);

    await cat.get(d);
    expect(d.listModelsCalls).toBe(1);
    c.advance(100);
    d.models = [{ id: "ok", name: "OK" }];
    expect(await cat.get(d)).toMatchObject({ models: [{ id: "ok" }], error: null });
    expect(d.listModelsCalls).toBe(2);
  });
});
