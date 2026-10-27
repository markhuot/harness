import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Watcher } from "@harness/shared";
import type { WatcherSupervisor } from "../../../service/src/orchestrator/orchestrator";
import { validatePrompts } from "../../../service/src/orchestrator/settings";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

/** A supervisor that runs nothing itself: a test hands it output as if the watcher's process printed it. */
function fakeSupervisor() {
  const ref: { onOutput?: (w: Watcher, o: { text: string; truncated: boolean }) => unknown } = {};
  const ran: string[] = [];
  const factory = (handlers: { onOutput: NonNullable<typeof ref.onOutput> }): WatcherSupervisor => {
    ref.onOutput = handlers.onOutput;
    return { sync() {}, async runNow(id: string) { ran.push(id); }, async stopAll() {} } as unknown as WatcherSupervisor;
  };
  return { factory, ref, ran };
}

/** Two groups (Work, Home), a chief of staff for each and for All, and a watcher per owner. */
async function board() {
  const sup = fakeSupervisor();
  const h = makeOrchestrator({ tools: undefined, watchers: sup.factory as never });
  const project = (key: string, group: string) => {
    const dir = join(h.home, "proj", key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    return h.orch.createProject({ path: dir, name: key, key, useWorktrees: false, group });
  };
  project("WORK1", "Work");
  project("HOME1", "Home");
  const group = (name: string) => h.store.groups.findByName(name)!.id;
  const all = h.orch.openCos("all");
  const work = h.orch.openCos({ group: group("Work") });
  const home = h.orch.openCos({ group: group("Home") });
  const mine = h.orch.createWatcher({ name: "work-feed", command: "feed-work", enabled: false, cosId: work.ticketId });
  const theirs = h.orch.createWatcher({ name: "home-feed", command: "feed-home", enabled: false, cosId: home.ticketId });
  const shared = h.orch.createWatcher({ name: "all-feed", command: "feed-all", enabled: false });
  /** A chief runs a scripted turn: its tool calls and what they answered. */
  async function asCos(cos: { key: string }, calls: [string, unknown][]) {
    const { steps, results } = callTools(calls);
    h.driver.script(steps);
    await h.orch.sendMessage(cos.key, "go");
    await h.settle();
    return results;
  }
  return { h, sup, all, work, home, mine, theirs, shared, asCos };
}
const out = (text: string) => ({ text, truncated: false });
const watcherEvents = (h: Awaited<ReturnType<typeof board>>["h"]) => h.store.ticketEvents.list({ limit: 100 }).filter((e) => e.sourceKind === "watcher");

test("a watcher's output is an event owned by the watcher's chief of staff, not a triage item", async () => {
  const { h, sup, work, all, mine, shared } = await board();
  await sup.ref.onOutput!(mine, out("deploy failed on WORK1"));
  await sup.ref.onOutput!(shared, out("disk almost full"));
  const events = watcherEvents(h);
  expect(events.map((e) => [e.actor, e.cosId, e.projectId])).toEqual(
    expect.arrayContaining([
      ["watcher:work-feed", work.ticketId, null],
      ["watcher:all-feed", all.ticketId, null],
    ]),
  );
  // Nothing creates a triage session or takes a TRIAGE number any more.
  expect(h.store.sessions.list("triage")).toEqual([]);
  expect(h.store.counters.next("triage")).toBe(1);
});

test("identical output from the same watcher is delivered once, and injected output goes to the All chief", async () => {
  const { h, sup, all, mine } = await board();
  await sup.ref.onOutput!(mine, out("same"));
  await sup.ref.onOutput!(mine, out("same"));
  expect(watcherEvents(h).filter((e) => e.actor === "watcher:work-feed")).toHaveLength(1);

  const first = await h.orch.injectOutput("pager", "page: db down");
  expect(first).toMatchObject({ targetId: all.ticketId, status: "pending" });
  expect(await h.orch.injectOutput("pager", "page: db down")).toBeNull();
});

test("rehoming keeps a group chief's watcher events with it, and sends inject: events and a deleted watcher's to All", async () => {
  const { h, sup, work, all, mine } = await board();
  await sup.ref.onOutput!(mine, out("deploy failed"));
  await h.orch.injectOutput("pager", "page: db down");
  await sup.ref.onOutput!({ ...mine, id: "gone-watcher", cosId: work.ticketId }, out("from a watcher deleted since"));
  h.orch.cosEngine.rehome();
  const owner = (needle: string) => watcherEvents(h).find((e) => e.title.includes(needle))!.cosId;
  expect(owner("deploy failed")).toBe(work.ticketId);
  expect(owner("db down")).toBe(all.ticketId);
  expect(owner("deleted since")).toBe(all.ticketId);
});

test("a removed triage prompt id in a settings PATCH is ignored, not a 400", () => {
  expect(validatePrompts({ "system.triage": "x", "run.triage": null })).toEqual({});
  expect(() => validatePrompts({ "nope.nothing": "x" })).toThrow("Unknown prompt");
});

test("when a group's chief is gone its watcher hands over to the All chief, and output from a stale owner goes to All too", async () => {
  const { h, sup, home, all, theirs } = await board();
  h.store.db.query("DELETE FROM cos WHERE ticket_id = $id").run({ id: home.ticketId });
  expect(h.store.watchers.get(theirs.id)!.cosId).toBeNull();
  // The supervisor still holds the old snapshot, with the deleted owner on it.
  await sup.ref.onOutput!({ ...theirs, cosId: home.ticketId }, out("orphaned output"));
  expect(watcherEvents(h).find((e) => e.title.includes("orphaned"))!.cosId).toBe(all.ticketId);
});

test("a group's chief lists only its own watchers; the All chief lists every one", async () => {
  const { all, work, asCos } = await board();
  const [forGroup] = await asCos(work, [["list_watchers", {}]]);
  expect(JSON.parse(forGroup!.text).map((w: { name: string }) => w.name)).toEqual(["work-feed"]);
  const [forAll] = await asCos(all, [["list_watchers", {}]]);
  expect(JSON.parse(forAll!.text).map((w: { name: string }) => w.name).sort()).toEqual(["all-feed", "home-feed", "work-feed"]);
});

test("another chief's watcher can't be told from a missing one: update, delete and run refuse it with no approval card", async () => {
  const { h, work, theirs, asCos } = await board();
  const results = await asCos(work, [
    ["update_watcher", { watcher: theirs.name, command: "evil" }],
    ["delete_watcher", { watcher: theirs.id }],
    ["run_watcher", { watcher: theirs.id }],
  ]);
  for (const r of results) {
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown watcher");
  }
  expect(h.ticket(work.key).pendingApproval).toBeNull();
  expect(h.store.watchers.get(theirs.id)!.command).toBe("feed-home");
});

test("creating a watcher needs a human's approval, and the approved retry makes one owned by the chief that asked", async () => {
  const { h, work, all } = await board();
  const input = { name: "new-feed", command: "poll-new", enabled: false };
  const first = callTools([["create_watcher", input]]);
  const retry = callTools([["create_watcher", input]]);
  h.driver.script(first.steps, retry.steps);
  await h.orch.sendMessage(work.key, "set one up");
  await h.settle();
  expect(first.results[0]!.isError).toBe(true);
  expect(h.store.watchers.list().some((w) => w.name === "new-feed")).toBe(false);
  expect(h.ticket(work.key).pendingApproval).toMatchObject({ toolName: "create_watcher", onceOnly: true });

  await h.orch.answerApproval(work.key, { decision: "allow_once" });
  await h.settle();
  expect(retry.results[0]!.isError).toBe(false);
  expect(h.store.watchers.list().find((w) => w.name === "new-feed")!.cosId).toBe(work.ticketId);

  // The All chief's watchers are stored as NULL, not as a row that could be recreated.
  const again = callTools([["create_watcher", { name: "all-new", command: "poll-all", enabled: false }]]);
  const againRetry = callTools([["create_watcher", { name: "all-new", command: "poll-all", enabled: false }]]);
  h.driver.script(again.steps, againRetry.steps);
  await h.orch.sendMessage(all.key, "and one for everyone");
  await h.settle();
  await h.orch.answerApproval(all.key, { decision: "allow_once" });
  await h.settle();
  expect(h.store.watchers.list().find((w) => w.name === "all-new")!.cosId).toBeNull();
});

test("a chief's pending approval rides on the chief for the app, clears when answered", async () => {
  const { h, mine, work } = await board();
  const input = { watcher: mine.name, enabled: true };
  const first = callTools([["update_watcher", input]]);
  const retry = callTools([["update_watcher", input]]);
  h.driver.script(first.steps, retry.steps);
  const chiefOf = () => h.orch.listCos().find((c) => c.key === work.key)!;
  expect(chiefOf().pendingApproval).toBeNull();
  await h.orch.sendMessage(work.key, "enable it");
  await h.settle();
  const waiting = chiefOf().pendingApproval!;
  expect(waiting).toMatchObject({ toolName: "update_watcher", onceOnly: true });
  expect(h.ticket(work.key).status).toBe("in_progress");

  await h.orch.answerApproval(work.key, { decision: "allow_once" });
  await h.settle();
  expect(chiefOf().pendingApproval).toBeNull();
  expect(retry.results[0]!.isError).toBe(false);
  // Answering resumes the chief in place: no board move is recorded for it.
  expect(h.store.activity.listBySession(h.ticket(work.key).sessionId).filter((a) => a.kind === "moved")).toEqual([]);
});

test("denying a chief's approval tells it so with the human's note, and the call never runs", async () => {
  const { h, mine, work } = await board();
  const first = callTools([["update_watcher", { watcher: mine.name, command: "evil" }]]);
  h.driver.script(first.steps);
  await h.orch.sendMessage(work.key, "change it");
  await h.settle();
  const before = h.driver.requests.length;
  await h.orch.answerApproval(work.key, { decision: "deny", message: "Leave that one alone." });
  await h.settle();
  const prompt = h.driver.requests[before]!.prompt;
  expect(h.driver.requests[before]!.kind).toBe("cos");
  expect(prompt).toContain("The human denied update_watcher");
  expect(prompt).toContain("Leave that one alone.");
  expect(h.store.watchers.get(mine.id)!.command).toBe("feed-work");
  expect(h.orch.listCos().find((c) => c.key === work.key)!.pendingApproval).toBeNull();
});

test("a chief can't hand its watcher to another chief: cosId in an update is ignored", async () => {
  const { h, work, home, mine } = await board();
  const input = { watcher: mine.name, enabled: false, cosId: home.ticketId };
  const first = callTools([["update_watcher", input]]);
  const retry = callTools([["update_watcher", input]]);
  h.driver.script(first.steps, retry.steps);
  await h.orch.sendMessage(work.key, "go");
  await h.settle();
  await h.orch.answerApproval(work.key, { decision: "allow_once" });
  await h.settle();
  expect(retry.results[0]!.isError).toBe(false);
  expect(h.store.watchers.get(mine.id)!.cosId).toBe(work.ticketId);
});

test("a CoS-created listener runs on request and its output lands as an event for that chief", async () => {
  const { h, sup, work, asCos } = await board();
  const created = h.orch.createWatcher({ name: "made-by-chief", command: "poll", enabled: false, cosId: work.ticketId });
  const input = { watcher: created.id };
  const first = callTools([["run_watcher", input]]);
  const retry = callTools([["run_watcher", input]]);
  h.driver.script(first.steps, retry.steps);
  await h.orch.sendMessage(work.key, "run it");
  await h.settle();
  await h.orch.answerApproval(work.key, { decision: "allow_once" });
  await h.settle();
  expect(retry.results[0]!.isError).toBe(false);
  expect(sup.ran).toEqual([created.id]);
  await sup.ref.onOutput!(h.store.watchers.get(created.id)!, out("first line from the new listener"));
  expect(watcherEvents(h).find((e) => e.actor === "watcher:made-by-chief")).toMatchObject({ cosId: work.ticketId, status: "pending" });
  await asCos(work, []);
});

test("a body that names a chief that doesn't exist is rejected; All is stored as NULL", async () => {
  const { h, all } = await board();
  expect(() => h.orch.createWatcher({ name: "x", command: "y", cosId: "nope" })).toThrow(/Unknown chief of staff/);
  expect(h.orch.createWatcher({ name: "x", command: "y", enabled: false, cosId: all.ticketId }).cosId).toBeNull();
});

test("GET /sessions?kind=triage answers an empty list, so apps that still ask for the Inbox keep decoding", async () => {
  const { h } = await board();
  h.store.sessions.create({ key: "TRIAGE-9", kind: "triage", ticketId: null, driver: "d", cwd: h.home, title: "old" });
  expect(h.orch.listSessions("triage")).toEqual([]);
  expect(h.orch.listSessions("ticket").map((s) => s.key)).not.toContain("TRIAGE-9");
});
