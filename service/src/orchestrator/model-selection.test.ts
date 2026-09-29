import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate, MIGRATIONS } from "../db";
import { Store } from "../store";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { resolveSettings, validateSettingsPatch } from "./settings";

function setup() {
  const work = new FakeDriver("fake");
  const other = new FakeDriver("other");
  const h = makeOrchestrator({ driver: work, drivers: [work, other] });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  return { ...h, other, project };
}

function v2Db(settings: Record<string, string>) {
  const db = new Database(":memory:", { strict: true });
  db.exec(MIGRATIONS[0]!);
  db.exec(MIGRATIONS[1]!);
  db.exec("PRAGMA user_version = 2");
  for (const [k, v] of Object.entries(settings)) db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({ k, v });
  migrate(db);
  return db;
}

describe("settings migration (claudeModel / anthropicModel → defaultModels)", () => {
  test("both legacy values move into defaultModels and the old keys are removed", () => {
    const db = v2Db({ claudeModel: '"haiku"', anthropicModel: '"claude-opus-5"', maxConcurrentRuns: "2" });
    const store = new Store(db);
    const stored = store.settings.all();
    expect(stored.claudeModel).toBeUndefined();
    expect(stored.anthropicModel).toBeUndefined();
    const s = resolveSettings(stored);
    expect(s.defaultModels).toEqual({ "claude-code": "haiku", "anthropic-api": "claude-opus-5" });
    expect(s.maxConcurrentRuns).toBe(2);
  });

  test("a null claudeModel is dropped, not stored as a model", () => {
    const s = resolveSettings(new Store(v2Db({ claudeModel: "null", anthropicModel: '"claude-sonnet-5"' })).settings.all());
    expect(s.defaultModels).toEqual({ "anthropic-api": "claude-sonnet-5" });
  });

  test("no legacy values → no defaultModels row; tickets and projects get the new columns", () => {
    const db = v2Db({});
    expect(db.query("SELECT 1 FROM settings WHERE key = 'defaultModels'").get()).toBeNull();
    expect(resolveSettings(new Store(db).settings.all()).defaultModels).toEqual({});
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("tickets")).toContain("model");
    expect(cols("projects")).toContain("default_models");
  });
});

describe("settings validation", () => {
  test("model maps: known drivers only, ids without spaces, empty → null", () => {
    expect(validateSettingsPatch({ defaultModels: { a: " x ", b: "" } }, ["a", "b"])).toEqual({ defaultModels: { a: "x", b: null } });
    expect(() => validateSettingsPatch({ defaultModels: { nope: "x" } }, ["a"])).toThrow(/Unknown driver/);
    expect(() => validateSettingsPatch({ defaultModels: { a: "two words" } }, ["a"])).toThrow(/without spaces/);
    expect(() => validateSettingsPatch({ reviewModels: ["x"] }, ["a"])).toThrow(/object/);
    expect(() => validateSettingsPatch({ claudeModel: "haiku" })).toThrow(/Unknown setting/);
  });

  test("PATCH merges model maps per driver; null clears one", () => {
    const h = setup();
    h.orch.updateSettings({ defaultModels: { fake: "m1" } });
    h.orch.updateSettings({ defaultModels: { other: "o1" } });
    expect(h.orch.settings().defaultModels).toEqual({ fake: "m1", other: "o1" });
    const pub = h.orch.updateSettings({ defaultModels: { fake: null } });
    expect(pub.defaultModels).toEqual({ other: "o1" });
  });
});

describe("model reaches the driver", () => {
  test("RunRequest.model follows ticket → project → settings → null", async () => {
    const h = setup();
    const t1 = await h.orch.createTicket({ projectId: h.project.id, prompt: "a" });
    await h.orch.idle();
    expect(h.driver.calls.map((c) => c.model)).toEqual([null, null]); // work + review

    h.orch.updateSettings({ defaultModels: { fake: "from-settings" } });
    await h.orch.sendMessage(t1.key, "again");
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.model).toBe("from-settings");

    h.orch.updateProject(h.project.id, { defaultModels: { fake: "from-project" } });
    const t2 = await h.orch.createTicket({ projectId: h.project.id, prompt: "b" });
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.model).toBe("from-project");

    const t3 = await h.orch.createTicket({ projectId: h.project.id, prompt: "c", model: "from-ticket" });
    await h.orch.idle();
    const calls = h.driver.calls.filter((c) => c.prompt === "c");
    expect(calls.map((c) => c.model)).toEqual(["from-ticket"]);
    expect(h.orch.ticketDetail(t3.key).ticket.model).toBe("from-ticket");
    const st = h.store.transcript.list(t3.sessionId).map((e) => (e.content as { text?: string }).text);
    expect(st).toContain("Run started (work · from-ticket)");
    expect(t2.model).toBeNull();
  });

  test("changing a ticket's model applies to the next run and keeps the conversation state", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "first", model: "m1" });
    await h.orch.idle();
    const updated = await h.orch.updateTicket(t.key, { model: "m2" });
    expect(updated.model).toBe("m2");
    await h.orch.sendMessage(t.key, "second");
    await h.orch.idle();
    const second = h.driver.calls.find((c) => c.prompt === "second")!;
    expect(second.model).toBe("m2");
    expect(second.state).not.toBeNull(); // resumed, not restarted
    await h.orch.updateTicket(t.key, { model: null });
    expect(h.orch.ticketDetail(t.key).ticket.model).toBeNull();
    await expect(h.orch.updateTicket(t.key, { model: "has space" })).rejects.toThrow(/without spaces/);
  });

  test("switching driver clears the model unless one is given", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", model: "m1", start: false });
    await h.orch.idle();
    expect((await h.orch.updateTicket(t.key, { driver: "other" })).model).toBeNull();
    expect((await h.orch.updateTicket(t.key, { driver: "fake", model: "m3" })).model).toBe("m3");
    expect((await h.orch.updateTicket(t.key, { driver: "fake" })).model).toBe("m3"); // same driver: kept
  });

  test("review runs use settings.reviewModels when set", async () => {
    const h = setup();
    h.orch.updateSettings({ reviewModels: { fake: "reviewer" } });
    await h.orch.createTicket({ projectId: h.project.id, prompt: "x", model: "worker" });
    await h.orch.idle();
    expect(h.driver.calls.map((c) => `${c.kind}:${c.model}`)).toEqual(["work:worker", "review:reviewer"]);
  });

  test("project defaultModels validate driver ids and merge", () => {
    const h = setup();
    expect(() => h.orch.updateProject(h.project.id, { defaultModels: { nope: "x" } })).toThrow(/Unknown driver/);
    h.orch.updateProject(h.project.id, { defaultModels: { fake: "a", other: "b" } });
    const p = h.orch.updateProject(h.project.id, { defaultModels: { other: null } });
    expect(p.defaultModels).toEqual({ fake: "a" });
  });

  test("listModels: unknown driver 404s; results are cached until refresh", async () => {
    const h = setup();
    await expect(h.orch.listModels("nope")).rejects.toMatchObject({ status: 404 });
    const a = await h.orch.listModels("fake");
    expect(a.models[0]!.id).toBe("fake-model");
    h.driver.models = [{ id: "fresh", name: "Fresh" }];
    expect((await h.orch.listModels("fake")).models[0]!.id).toBe("fake-model");
    expect((await h.orch.listModels("fake", { refresh: true })).models[0]!.id).toBe("fresh");
  });
});

describe("watcher driver and model", () => {
  /** Feed output as the watcher's supervisor does (onOutput → ingest) and wait for the triage run. */
  async function fire(h: ReturnType<typeof setup>, watcherId: string, text: string) {
    const w = h.store.watchers.get(watcherId)!;
    await h.orch.ingest({ sourceId: w.id, source: w.name, output: { text, truncated: false }, prompt: w.prompt, driver: w.driver, watcherId: w.id });
    await h.orch.idle();
  }
  const triageCalls = (d: FakeDriver) => d.calls.filter((c) => c.kind === "triage");

  test("triage runs on the watcher's driver, else settings.watcherDriver, else defaultDriver", async () => {
    const h = setup();
    const w = h.orch.createWatcher({ name: "w", command: "true", enabled: false });
    await fire(h, w.id, "one");
    expect(triageCalls(h.driver)).toHaveLength(1);

    h.orch.updateSettings({ watcherDriver: "other" });
    await fire(h, w.id, "two");
    expect(triageCalls(h.other)).toHaveLength(1);

    h.orch.updateSettings({ watcherDriver: "" }); // back to following defaultDriver
    expect(h.orch.settings().watcherDriver).toBeNull();
    h.orch.updateWatcher(w.id, { driver: "other" });
    await fire(h, w.id, "three");
    expect(triageCalls(h.other)).toHaveLength(2);
    expect(triageCalls(h.driver)).toHaveLength(1);
  });

  test("triage model: watcher.models → settings.watcherModels → settings.defaultModels → null", async () => {
    const h = setup();
    const w = h.orch.createWatcher({ name: "w", command: "true", enabled: false });
    const lastModel = () => triageCalls(h.driver).at(-1)!.model;

    await fire(h, w.id, "a");
    expect(lastModel()).toBeNull();

    h.orch.updateSettings({ defaultModels: { fake: "global" } });
    await fire(h, w.id, "b");
    expect(lastModel()).toBe("global");

    h.orch.updateSettings({ watcherModels: { fake: "sonnet" } });
    await fire(h, w.id, "c");
    expect(lastModel()).toBe("sonnet");

    h.orch.updateWatcher(w.id, { models: { fake: "opus" } });
    await fire(h, w.id, "d");
    expect(lastModel()).toBe("opus");
    const s = h.orch.listSessions("triage").find((x) => h.store.transcript.list(x.id).some((e) => (e.content as { text?: string }).text === "Run started (triage · opus)"));
    expect(s).toBeDefined();

    // A model for another driver doesn't leak onto this one.
    h.orch.updateWatcher(w.id, { models: { fake: null, other: "other-model" } });
    await fire(h, w.id, "e");
    expect(lastModel()).toBe("sonnet");

    // Injected output has no watcher: the watcher default applies.
    await h.orch.injectOutput("manual", "f");
    await h.orch.idle();
    expect(lastModel()).toBe("sonnet");
  });

  test("watcher models validate driver ids and merge per driver", () => {
    const h = setup();
    expect(() => h.orch.createWatcher({ name: "w", command: "true", models: { nope: "x" } })).toThrow(/Unknown driver/);
    const w = h.orch.createWatcher({ name: "w", command: "true", enabled: false, models: { fake: "a" } });
    expect(w.models).toEqual({ fake: "a" });
    expect(h.orch.updateWatcher(w.id, { models: { other: "b" } }).models).toEqual({ fake: "a", other: "b" });
    expect(h.orch.updateWatcher(w.id, { models: { fake: null } }).models).toEqual({ other: "b" });
    expect(h.orch.updateWatcher(w.id, { name: "renamed" }).models).toEqual({ other: "b" }); // untouched when omitted
    expect(() => h.orch.updateWatcher(w.id, { models: { fake: "two words" } })).toThrow(/without spaces/);
    // A stale entry for a driver that's gone can still be cleared.
    h.store.watchers.update(w.id, { models: { other: "b", gone: "x" } });
    expect(h.orch.updateWatcher(w.id, { models: { gone: null } }).models).toEqual({ other: "b" });
  });

  test("settings: watcherDriver must be a known driver; watcherModels merge like the other maps", () => {
    const h = setup();
    expect(() => h.orch.updateSettings({ watcherDriver: "nope" })).toThrow(/Unknown driver/);
    expect(() => h.orch.updateSettings({ watcherDriver: 3 })).toThrow(/watcherDriver/);
    h.orch.updateSettings({ watcherModels: { fake: "m1" } });
    h.orch.updateSettings({ watcherModels: { other: "o1" } });
    expect(h.orch.publicSettings().watcherModels).toEqual({ fake: "m1", other: "o1" });
    expect(h.orch.updateSettings({ watcherModels: { fake: null } }).watcherModels).toEqual({ other: "o1" });
    expect(resolveSettings({}).watcherDriver).toBeNull();
  });
});
