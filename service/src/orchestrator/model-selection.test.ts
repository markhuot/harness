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

describe("settings migration (claudeModel / anthropicModel → defaultModels → phaseModels)", () => {
  test("the legacy model for the default driver becomes Planning/Work/Review; the old keys are removed", () => {
    const db = v2Db({ claudeModel: '"sonnet"', anthropicModel: '"claude-opus-5"', maxConcurrentRuns: "2" });
    const store = new Store(db);
    const stored = store.settings.all();
    expect(stored.claudeModel).toBeUndefined();
    expect(stored.anthropicModel).toBeUndefined();
    expect(stored.defaultModels).toBeUndefined();
    const s = resolveSettings(stored);
    const cc = { driver: "claude-code", model: "sonnet" };
    expect(s.phaseModels).toEqual({ plan: cc, work: cc, review: cc, complete: { driver: "claude-code", model: "haiku" } });
    expect(s.defaultModels).toEqual({ "claude-code": "sonnet" });
    expect(s.maxConcurrentRuns).toBe(2);
  });

  test("a null claudeModel is dropped, not stored as a model", () => {
    const s = resolveSettings(new Store(v2Db({ claudeModel: "null", anthropicModel: '"claude-sonnet-5"' })).settings.all());
    expect(s.defaultModels).toEqual({});
    expect(s.phaseModels!.work).toEqual({ driver: "claude-code", model: null });
  });

  test("no legacy values → only the built-in Complete choice; tickets and projects get the new columns", () => {
    const db = v2Db({});
    expect(resolveSettings(new Store(db).settings.all()).phaseModels).toEqual({ complete: { driver: "claude-code", model: "haiku" } });
    const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("tickets")).toContain("phase_models");
    expect(cols("projects")).toContain("phase_models");
    expect(cols("sessions")).toContain("driver_state_driver");
  });
});

describe("settings validation", () => {
  test("migration 38 turns driver + model columns into per-phase choices", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = OFF");
    for (let v = 0; v < 37; v++) {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    const set = (k: string, v: unknown) => db.query("INSERT INTO settings (key, value) VALUES ($k, $v)").run({ k, v: JSON.stringify(v) });
    set("defaultDriver", "anthropic-api");
    set("defaultModels", { "anthropic-api": "claude-opus-5-5", "claude-code": "sonnet" });
    set("reviewModels", { "anthropic-api": "claude-fable" });
    const project = (id: string, driver: string | null, models: Record<string, string>) =>
      db.query("INSERT INTO projects (id, key, name, path, default_driver, default_models, created_at, updated_at) VALUES ($id, $id, $id, '/tmp', $driver, $models, 0, 0)").run({ id, driver, models: JSON.stringify(models) });
    project("PLAIN", null, {});
    project("PINNED", "claude-code", {});
    const ticket = (id: string, projectId: string, driver: string, model: string | null) =>
      db
        .query("INSERT INTO tickets (id, key, project_id, kind, title, spec, status, session_id, driver, model, created_at, updated_at) VALUES ($id, $id, $projectId, 'task', 't', '', 'planning', $id, $driver, $model, 0, 0)")
        .run({ id, projectId, driver, model });
    ticket("FOLLOWS", "PLAIN", "anthropic-api", null);
    ticket("OWN-MODEL", "PLAIN", "anthropic-api", "claude-haiku-5-5");
    ticket("OTHER-DRIVER", "PINNED", "anthropic-api", null);
    migrate(db);

    const store = new Store(db);
    const api = (model: string | null) => ({ driver: "anthropic-api", model });
    const s = resolveSettings(store.settings.all());
    expect(s.phaseModels).toEqual({ plan: api("claude-opus-5-5"), work: api("claude-opus-5-5"), review: api("claude-fable"), complete: api("claude-haiku-5-5") });
    expect([s.defaultDriver, s.defaultModels, s.reviewModels]).toEqual(["anthropic-api", { "anthropic-api": "claude-opus-5-5" }, { "anthropic-api": "claude-fable" }]);
    expect(store.projects.get("PLAIN")!.phaseModels).toEqual({});
    expect(store.projects.get("PINNED")!.phaseModels!.work).toEqual({ driver: "claude-code", model: "sonnet" });
    const t = (id: string) => store.tickets.get(id)!;
    expect([t("FOLLOWS").phaseModels, t("FOLLOWS").driver]).toEqual([{}, "anthropic-api"]);
    expect(t("OWN-MODEL").phaseModels).toEqual({ plan: api("claude-haiku-5-5"), work: api("claude-haiku-5-5"), review: api("claude-fable") });
    expect(t("OTHER-DRIVER").phaseModels!.work).toEqual(api("claude-opus-5-5"));
    // Complete stays inherited, so every ticket gets the cheap default.
    for (const id of ["FOLLOWS", "OWN-MODEL", "OTHER-DRIVER"]) expect(t(id).phaseModels!.complete).toBeUndefined();
  });

  test("the built-in Complete default is seeded once: a cleared one stays cleared", () => {
    const db = new Database(":memory:", { strict: true });
    migrate(db);
    const work = new FakeDriver("claude-code");
    const h = makeOrchestrator({ driver: work, drivers: [work] });
    expect(resolveSettings(new Store(db).settings.all()).phaseModels!.complete).toEqual({ driver: "claude-code", model: "haiku" });
    expect(h.orch.settings().phaseModels!.complete).toEqual({ driver: "claude-code", model: "haiku" });
    h.orch.updateSettings({ phaseModels: { complete: null } });
    migrate(h.store.db);
    expect(h.orch.settings().phaseModels!.complete).toBeUndefined();
  });
  test("model maps: known drivers only, ids without spaces, empty → null", () => {
    expect(validateSettingsPatch({ defaultModels: { a: " x ", b: "" } }, ["a", "b"])).toEqual({ defaultModels: { a: "x", b: null } });
    expect(() => validateSettingsPatch({ defaultModels: { nope: "x" } }, ["a"])).toThrow(/Unknown driver/);
    expect(() => validateSettingsPatch({ defaultModels: { a: "two words" } }, ["a"])).toThrow(/without spaces/);
    expect(() => validateSettingsPatch({ reviewModels: ["x"] }, ["a"])).toThrow(/object/);
    expect(() => validateSettingsPatch({ claudeModel: "haiku" })).toThrow(/Unknown setting/);
  });

  test("browserIdleTabMinutes: default 5, integer 0–1440, a bad stored value falls back", () => {
    expect(resolveSettings({}).browserIdleTabMinutes).toBe(5);
    expect(validateSettingsPatch({ browserIdleTabMinutes: 0 })).toEqual({ browserIdleTabMinutes: 0 });
    expect(validateSettingsPatch({ browserIdleTabMinutes: 1440 })).toEqual({ browserIdleTabMinutes: 1440 });
    for (const bad of [-1, 1441, 2.5, "5", null]) {
      expect(() => validateSettingsPatch({ browserIdleTabMinutes: bad })).toThrow(/browserIdleTabMinutes must be an integer/);
    }
    expect(resolveSettings({ browserIdleTabMinutes: -3, maxConcurrentRuns: 7 })).toMatchObject({ browserIdleTabMinutes: 5, maxConcurrentRuns: 7 });
    const h = setup();
    expect(h.orch.updateSettings({ browserIdleTabMinutes: 12 }).browserIdleTabMinutes).toBe(12);
    expect(h.orch.settings().browserIdleTabMinutes).toBe(12);
  });

  test("legacy defaultModels PATCH sets the Work driver's model; null clears it", () => {
    const h = setup();
    h.orch.updateSettings({ defaultModels: { fake: "m1" } });
    h.orch.updateSettings({ defaultModels: { other: "o1" } }); // not the Work driver: no effect
    expect(h.orch.settings().defaultModels).toEqual({ fake: "m1" });
    expect(h.orch.settings().phaseModels).toMatchObject({ plan: { driver: "fake", model: "m1" }, work: { driver: "fake", model: "m1" }, review: { driver: "fake", model: "m1" } });
    const pub = h.orch.updateSettings({ defaultModels: { fake: null } });
    expect(pub.defaultModels).toEqual({});
  });

  test("phaseModels PATCH merges per phase; null clears a phase, which stays cleared", () => {
    const h = setup(); // its settings start on the fake driver for Planning, Work and Review
    h.orch.updateSettings({ phaseModels: { work: { driver: "fake", model: "w" }, review: null } });
    h.orch.updateSettings({ phaseModels: { complete: { driver: "other", model: "small" } } });
    const fake = (model: string | null) => ({ driver: "fake", model });
    expect(h.orch.settings().phaseModels).toEqual({ plan: fake(null), work: fake("w"), complete: { driver: "other", model: "small" } });
    h.orch.updateSettings({ phaseModels: { complete: null } });
    expect(h.orch.settings().phaseModels).toEqual({ plan: fake(null), work: fake("w") });
    expect(h.store.settings.all().defaultDriver).toBeUndefined(); // legacy keys aren't stored
    expect(() => h.orch.updateSettings({ phaseModels: { work: { driver: "nope", model: null } } })).toThrow(/Unknown driver/);
    expect(() => h.orch.updateSettings({ phaseModels: { chat: { driver: "fake", model: null } } })).toThrow(/phase/);
    expect(() => h.orch.updateSettings({ phaseModels: { work: { driver: "fake", model: "two words" } } })).toThrow(/without spaces/);
  });
});

describe("model reaches the driver", () => {
  test("RunRequest.model follows ticket → project → settings → null", async () => {
    const h = setup();
    const t1 = await h.orch.createTicket({ projectId: h.project.id, spec: "a" });
    await h.orch.idle();
    expect(h.driver.calls.map((c) => c.model)).toEqual([null, null]); // work + review

    h.orch.updateSettings({ defaultModels: { fake: "from-settings" } });
    await h.orch.sendMessage(t1.key, "again");
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.model).toBe("from-settings");

    h.orch.updateProject(h.project.id, { defaultModels: { fake: "from-project" } });
    const t2 = await h.orch.createTicket({ projectId: h.project.id, spec: "b" });
    await h.orch.idle();
    expect(h.driver.calls.at(-1)!.model).toBe("from-project");

    const t3 = await h.orch.createTicket({ projectId: h.project.id, spec: "c", model: "from-ticket" });
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
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "first", model: "m1" });
    await h.orch.idle();
    // A chat in review saves a conversation (the submit before it started it fresh).
    await h.orch.sendMessage(t.key, "zeroth");
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
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", model: "m1", start: false });
    await h.orch.idle();
    expect((await h.orch.updateTicket(t.key, { driver: "other" })).model).toBeNull();
    expect((await h.orch.updateTicket(t.key, { driver: "fake", model: "m3" })).model).toBe("m3");
    expect((await h.orch.updateTicket(t.key, { driver: "fake" })).model).toBe("m3"); // same driver: kept
  });

  test("review runs use the Review choice; a ticket's legacy model sets its Review too", async () => {
    const h = setup();
    h.orch.updateSettings({ reviewModels: { fake: "reviewer" } });
    await h.orch.createTicket({ projectId: h.project.id, spec: "x", phaseModels: { work: { driver: "fake", model: "worker" } } });
    await h.orch.idle();
    expect(h.driver.calls.map((c) => `${c.kind}:${c.model}`)).toEqual(["work:worker", "review:reviewer"]);
    await h.orch.createTicket({ projectId: h.project.id, spec: "y", model: "worker" });
    await h.orch.idle();
    expect(h.driver.calls.slice(2).map((c) => `${c.kind}:${c.model}`)).toEqual(["work:worker", "review:worker"]);
  });

  test("each phase resolves on its own across ticket → project → settings, on its own driver", async () => {
    const h = setup();
    h.orch.updateSettings({ phaseModels: { review: { driver: "other", model: "rev" }, complete: { driver: "other", model: "small" } } });
    h.orch.updateProject(h.project.id, { phaseModels: { plan: { driver: "other", model: "planner" } } });
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "p", start: false, phaseModels: { work: { driver: "fake", model: "opus" } } });
    await h.orch.idle();
    expect(h.other.calls.map((c) => `${c.kind}:${c.model}`)).toEqual(["plan:planner"]);
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    expect(h.driver.calls.map((c) => `${c.kind}:${c.model}`)).toEqual(["work:opus"]);
    expect(h.other.calls.map((c) => `${c.kind}:${c.model}`)).toEqual(["plan:planner", "review:rev"]);
    expect(h.orch.ticketDetail(t.key).ticket.driver).toBe("fake");
    const lines = (kind: string) =>
      (h.store.db.query("SELECT DISTINCT session_id FROM runs WHERE kind = $kind").all({ kind }) as { session_id: string }[]).flatMap((r) =>
        h.store.transcript.list(r.session_id).map((e) => (e.content as { text?: string }).text),
      );
    expect(lines("plan")).toContain("Run started (plan · other · planner)");
    expect(lines("work")).toContain("Run started (work · opus)");
  });

  test("a run on another driver than the saved conversation's starts fresh", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "first" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "zeroth"); // saves a fake-driver conversation
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "same driver");
    await h.orch.idle();
    expect(h.driver.calls.find((c) => c.prompt === "same driver")!.state).not.toBeNull();
    await h.orch.updateTicket(t.key, { phaseModels: { work: { driver: "other", model: null } } });
    await h.orch.sendMessage(t.key, "switched");
    await h.orch.idle();
    const switched = h.other.calls.find((c) => c.prompt === "switched")!;
    expect(switched.state).toBeNull();
    expect(h.store.sessions.get(t.sessionId)!.driver).toBe("other");
  });

  test("a ticket's legacy driver/model write: the inherited driver with no model follows the project", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", driver: "fake", start: false });
    expect(t.phaseModels).toEqual({});
    const pinned = await h.orch.updateTicket(t.key, { driver: "other" });
    expect([pinned.driver, pinned.model]).toEqual(["other", null]);
    expect(Object.keys(pinned.phaseModels!).sort()).toEqual(["plan", "review", "work"]);
    h.orch.updateProject(h.project.id, { phaseModels: { work: { driver: "other", model: "pm" } } });
    // The ticket's driver follows its project once it no longer pins one.
    const back = await h.orch.updateTicket(t.key, { driver: "fake" });
    expect(back.phaseModels!.work).toEqual({ driver: "fake", model: null });
    const cleared = await h.orch.updateTicket(t.key, { phaseModels: { plan: null, work: null, review: null } });
    expect([cleared.driver, cleared.model, cleared.phaseModels]).toEqual(["other", null, {}]);
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
