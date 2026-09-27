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
