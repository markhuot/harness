import { expect, test } from "bun:test";
import type { ModelInfo } from "@harness/shared";
import { CommandCatalog } from "../../../service/src/drivers/commands";
import { ModelCatalog } from "../../../service/src/drivers/models";
import { ModelListError, type Driver } from "../../../service/src/drivers/types";
import { fakeClock } from "../../builders/clock";
import { FakeDriver } from "../fake-driver";

const model = (id: string): ModelInfo => ({ id, name: id, description: "" });

/** A driver whose model list is whatever `list` returns, counting how often it's asked. */
function modelDriver(list: () => Promise<ModelInfo[]>) {
  const driver = new FakeDriver();
  let calls = 0;
  driver.listModels = async () => {
    calls++;
    return list();
  };
  return { driver, calls: () => calls };
}

test("a model list is reused for ten minutes of the injected clock, then read again", async () => {
  const clock = fakeClock(0);
  const catalog = new ModelCatalog({ now: clock });
  const { driver, calls } = modelDriver(async () => [model("a")]);
  expect((await catalog.get(driver)).models).toEqual([model("a")]);
  clock.advance(10 * 60_000 - 1);
  await catalog.get(driver);
  expect(calls()).toBe(1);
  clock.advance(1);
  await catalog.get(driver);
  expect(calls()).toBe(2);
});

test("refresh and invalidate both force a new read", async () => {
  const catalog = new ModelCatalog({ now: fakeClock(0) });
  const { driver, calls } = modelDriver(async () => [model("a")]);
  await catalog.get(driver);
  await catalog.get(driver, { refresh: true });
  expect(calls()).toBe(2);
  catalog.invalidate(driver.id);
  await catalog.get(driver);
  expect(calls()).toBe(3);
  catalog.invalidate();
  await catalog.get(driver);
  expect(calls()).toBe(4);
});

test("concurrent callers share one listing", async () => {
  const catalog = new ModelCatalog({ now: fakeClock(0) });
  const { driver, calls } = modelDriver(async () => [model("a")]);
  const [a, b] = await Promise.all([catalog.get(driver), catalog.get(driver)]);
  expect(a).toBe(b);
  expect(calls()).toBe(1);
});

test("a failure comes back as data with its message, keeps the fallback list, and is retried after thirty seconds, not ten minutes", async () => {
  const clock = fakeClock(0);
  const catalog = new ModelCatalog({ now: clock });
  let fail = true;
  const { driver, calls } = modelDriver(async () => {
    if (fail) throw new ModelListError("no API key", [model("haiku")]);
    return [model("a")];
  });
  expect(await catalog.get(driver)).toMatchObject({ error: "no API key", models: [model("haiku")], fetchedAt: 0 });
  clock.advance(29_999);
  await catalog.get(driver);
  expect(calls()).toBe(1);
  fail = false;
  clock.advance(1);
  expect(await catalog.get(driver)).toMatchObject({ error: null, models: [model("a")] });
});

test("a plain error has an empty list", async () => {
  const catalog = new ModelCatalog();
  const { driver } = modelDriver(async () => {
    throw new Error("boom");
  });
  expect(await catalog.get(driver)).toMatchObject({ error: "boom", models: [] });
});

function commandDriver(list: (cwd: string) => Promise<{ name: string }[]>) {
  const driver = new FakeDriver();
  let calls = 0;
  (driver as Driver).listCommands = async (cwd) => {
    calls++;
    return (await list(cwd)) as never;
  };
  return { driver, calls: () => calls };
}

test("a driver with no commands has none, and nothing is listed", async () => {
  expect(await new CommandCatalog().get(new FakeDriver(), "/p")).toEqual([]);
});

test("the first lookup for a folder waits for the listing; later ones answer at once, even stale ones, while it refreshes", async () => {
  const clock = fakeClock(0);
  const catalog = new CommandCatalog({ now: clock });
  let version = 1;
  const { driver, calls } = commandDriver(async () => [{ name: `v${version}` }]);
  expect(await catalog.get(driver, "/p")).toEqual([{ name: "v1" }] as never);
  version = 2;
  clock.advance(60_000);
  // Stale: the old list answers now, and the refresh lands for the next keystroke.
  expect(await catalog.get(driver, "/p")).toEqual([{ name: "v1" }] as never);
  await Promise.resolve();
  await Promise.resolve();
  expect(await catalog.get(driver, "/p")).toEqual([{ name: "v2" }] as never);
  expect(calls()).toBe(2);
  await catalog.get(driver, "/other");
  expect(calls()).toBe(3);
});

test("a failed listing is an empty list that's retried after fifteen seconds, and a failure after a good list keeps the good one", async () => {
  const clock = fakeClock(0);
  const logs: string[] = [];
  const catalog = new CommandCatalog({ now: clock, log: (m) => logs.push(m) });
  let mode: "fail" | "ok" = "fail";
  const { driver, calls } = commandDriver(async () => {
    if (mode === "fail") throw new Error("cli missing");
    return [{ name: "good" }];
  });
  expect(await catalog.get(driver, "/p")).toEqual([]);
  expect(logs[0]).toContain("cli missing");
  clock.advance(14_999);
  await catalog.get(driver, "/p");
  expect(calls()).toBe(1);
  mode = "ok";
  clock.advance(1);
  await catalog.get(driver, "/p"); // empty answer now, refresh in flight
  await Promise.resolve();
  await Promise.resolve();
  expect(await catalog.get(driver, "/p")).toEqual([{ name: "good" }] as never);
  mode = "fail";
  clock.advance(60_000);
  await catalog.get(driver, "/p");
  await Promise.resolve();
  await Promise.resolve();
  expect(await catalog.get(driver, "/p")).toEqual([{ name: "good" }] as never);
});
