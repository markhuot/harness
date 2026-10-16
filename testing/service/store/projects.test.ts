import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RESERVED_PROJECT_KEYS } from "@harness/shared";
import { insideGitCheckout, normalizeProjectKey } from "../../../service/src/store/projects";
import { fakeClock } from "../../builders/clock";
import { addProject, makeStore } from "../../builders/store";
import { addTicketWith } from "../../builders/ticket-input";
import { tempDir } from "../../builders/tmp";

test("a new project's key comes from its path and gets a number when taken", () => {
  const store = makeStore();
  const a = store.projects.create({ name: "A", path: "/work/my-app" });
  const b = store.projects.create({ name: "B", path: "/other/my-app" });
  expect(a.key).toBe(normalizeProjectKey("my-app"));
  expect(b.key).toBe(`${a.key}2`);
  expect(store.projects.getByKey(a.key.toLowerCase())?.id).toBe(a.id);
});

test("an explicit key is normalized, and reserved keys are skipped", () => {
  const store = makeStore();
  expect(store.projects.create({ name: "A", path: "/a", key: "  my/proj " }).key).toBe(normalizeProjectKey("my/proj"));
  const reserved = RESERVED_PROJECT_KEYS[0]!;
  expect(store.projects.create({ name: "R", path: "/r", key: reserved }).key).not.toBe(reserved);
});

test("create stamps created_at from the injected clock and update moves updated_at only", () => {
  const clock = fakeClock(1_000);
  const store = makeStore({ now: clock });
  const p = addProject(store);
  clock.advance(500);
  const updated = store.projects.update(p.id, { name: "Renamed" })!;
  expect(p.createdAt).toBe(1_000);
  expect(updated.createdAt).toBe(1_000);
  expect(updated.updatedAt).toBe(1_500);
  expect(store.projects.update("missing", { name: "x" })).toBeNull();
});

test("update leaves what the patch doesn't name, clears what it sets to null", () => {
  const store = makeStore();
  const p = store.projects.create({ name: "P", path: "/p", key: "PP", color: "teal", group: "g", baseBranch: "dev" });
  const same = store.projects.update(p.id, { name: "Q" })!;
  expect(same).toMatchObject({ color: "teal", group: "g", baseBranch: "dev", completionAction: "merge" });
  expect(store.projects.update(p.id, { color: null, group: null, baseBranch: null })).toMatchObject({ color: null, group: null, baseBranch: null });
});

test("takeNextKey hands out increasing numbers and skips keys the caller says are taken", () => {
  const store = makeStore();
  const p = addProject(store, { key: "AB" });
  expect(store.projects.takeNextKey(p.id, () => false)).toBe("AB-1");
  expect(store.projects.takeNextKey(p.id, (k) => k === "AB-2" || k === "AB-3")).toBe("AB-4");
  expect(store.projects.takeNextKey(p.id, () => false)).toBe("AB-5");
  expect(() => store.projects.takeNextKey("nope", () => false)).toThrow(/Unknown project/);
});

test("rekey renames native tickets, sessions and dependency keys, and keeps the old keys as aliases", () => {
  const store = makeStore();
  const p = addProject(store, { key: "OLD" });
  const a = addTicketWith(store, p);
  const b = addTicketWith(store, p, { dependsOn: [a.key] });
  const mirror = addTicketWith(store, p, { key: "JIRA-9", externalRef: { source: "jira", key: "JIRA-9", url: null, raw: {} } });
  const { renames, depTicketIds } = store.projects.rekey(p.id, "NEW");
  expect([...renames]).toEqual([["OLD-1", "NEW-1"], ["OLD-2", "NEW-2"]]);
  expect(depTicketIds).toEqual([b.id]);
  expect(store.projects.get(p.id)!.key).toBe("NEW");
  expect(store.tickets.get(b.id)!.dependsOn).toEqual(["NEW-1"]);
  expect(store.sessions.get(a.sessionId)!.key).toBe("NEW-1");
  expect(store.tickets.getByKey("old-1")!.id).toBe(a.id);
  expect(store.tickets.lookup("OLD-1")!.alias).toBe("OLD-1");
  expect(store.tickets.lookup("NEW-1")!.alias).toBeNull();
  expect(store.tickets.aliases(a.id)).toEqual(["OLD-1"]);
  // A legacy mirror (key is its remote ID) isn't renamed.
  expect(store.tickets.get(mirror.id)!.key).toBe("JIRA-9");
});

test("rekey refuses a collision and changes nothing; renaming to the same key is a no-op; renaming back drops the alias", () => {
  const store = makeStore();
  const p = addProject(store, { key: "AA" });
  const other = addProject(store, { key: "BB", path: tempDir() });
  addTicketWith(store, p);
  addTicketWith(store, other, { key: "BB-1" });
  expect(store.projects.rekeyConflicts(p.id, "BB")).toEqual(["BB-1"]);
  expect(() => store.projects.rekey(p.id, "BB")).toThrow(/collide with BB-1/);
  expect(store.projects.get(p.id)!.key).toBe("AA");
  expect(store.projects.rekey(p.id, "AA").renames.size).toBe(0);
  store.projects.rekey(p.id, "CC");
  store.projects.rekey(p.id, "AA");
  expect(store.tickets.lookup("AA-1")!.alias).toBeNull();
  expect(store.tickets.aliases(store.tickets.getByKey("AA-1")!.id)).toEqual(["CC-1"]);
});

test("a new ticket takes its key back from an alias", () => {
  const store = makeStore();
  const p = addProject(store, { key: "AA" });
  const first = addTicketWith(store, p);
  store.projects.rekey(p.id, "BB");
  expect(store.tickets.getByKey("AA-1")!.id).toBe(first.id);
  const reused = addTicketWith(store, p, { key: "AA-1" });
  expect(store.tickets.getByKey("AA-1")!.id).toBe(reused.id);
  expect(store.tickets.keyExists("AA-1")).toBe(true);
  store.tickets.delete(reused.id);
  expect(store.tickets.getByKey("AA-1")).toBeNull();
});

test("getByPath returns the oldest project at a path; delete removes the project and its tickets", () => {
  const clock = fakeClock();
  const store = makeStore({ now: clock });
  const first = store.projects.create({ name: "one", path: "/same", key: "ONE" });
  clock.advance(1);
  store.projects.create({ name: "two", path: "/same", key: "TWO" });
  expect(store.projects.getByPath("/same")!.id).toBe(first.id);
  const t = addTicketWith(store, first);
  store.projects.delete(first.id);
  expect(store.projects.get(first.id)).toBeNull();
  expect(store.tickets.get(t.id)).toBeNull();
});

test("insideGitCheckout finds a .git in the path or any parent, and stops at the root", () => {
  const root = tempDir();
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  expect(insideGitCheckout(nested)).toBe(false);
  mkdirSync(join(root, ".git"));
  expect(insideGitCheckout(nested)).toBe(true);
});
