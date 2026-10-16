import { expect, test } from "bun:test";
import type { Attachment } from "@harness/shared";
import { SpecConflictError } from "../../../service/src/store";
import { fakeClock } from "../../builders/clock";
import { addProject, addTicket, makeStore } from "../../builders/store";

const setup = () => {
  const clock = fakeClock(1_000);
  const store = makeStore({ now: clock });
  const project = addProject(store);
  const ticket = addTicket(store, project);
  return { clock, store, project, ticket };
};

test("runs go queued → running → finished, stamping each step from the clock, and listUnfinished finds the open ones", () => {
  const { clock, store, ticket } = setup();
  const run = store.runs.create({ sessionId: ticket.sessionId, kind: "work", driver: "d", prompt: "p" });
  expect(run).toMatchObject({ status: "queued", createdAt: 1_000, startedAt: null, endedAt: null });
  clock.advance(10);
  expect(store.runs.markRunning(run.id)).toMatchObject({ status: "running", startedAt: 1_010 });
  expect(store.runs.listUnfinished().map((r) => r.id)).toEqual([run.id]);
  clock.advance(10);
  expect(store.runs.finish(run.id, "failed", "boom")).toMatchObject({ status: "failed", error: "boom", endedAt: 1_020 });
  expect(store.runs.listUnfinished()).toEqual([]);
});

test("usage adds up across reports, and a field nobody reported stays null", () => {
  const { store, ticket } = setup();
  const run = store.runs.create({ sessionId: ticket.sessionId, kind: "work", driver: "d", prompt: "p" });
  expect(run).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
  store.runs.addUsage(run.id, { inputTokens: 10 });
  store.runs.addUsage(run.id, { inputTokens: 5, costUsd: 0.5 });
  const after = store.runs.addUsage(run.id, { costUsd: 0.25 });
  expect(after).toMatchObject({ inputTokens: 15, outputTokens: null, costUsd: 0.75 });
  expect(store.runs.setModel(run.id, "m").model).toBe("m");
});

test("a run's message attachments come back with its session", () => {
  const { store, ticket } = setup();
  const file: Attachment = { id: "a1", path: "/f.png", name: "f.png", source: "upload", kind: "image", mimeType: "image/png" };
  store.runs.create({ sessionId: ticket.sessionId, kind: "work", driver: "d", prompt: "p", attachments: [file] });
  store.runs.create({ sessionId: ticket.sessionId, kind: "work", driver: "d", prompt: "none" });
  expect(store.runs.messageAttachments()).toEqual([{ sessionId: ticket.sessionId, attachment: file }]);
});

test("transcript seqs count up per session, shared by sub-agents, and listing pages by seq", () => {
  const { store, project, ticket } = setup();
  const other = addTicket(store, project);
  const a = store.transcript.append(ticket.sessionId, null, "user", { type: "text", text: "1" });
  const sub = store.transcript.append(ticket.sessionId, null, "assistant", { type: "text", text: "2" }, "sub-1");
  const c = store.transcript.append(ticket.sessionId, null, "assistant", { type: "text", text: "3" });
  const o = store.transcript.append(other.sessionId, null, "user", { type: "text", text: "x" });
  expect([a.seq, sub.seq, c.seq, o.seq]).toEqual([1, 2, 3, 1]);
  expect(store.transcript.list(ticket.sessionId).map((e) => e.seq)).toEqual([1, 3]);
  expect(store.transcript.list(ticket.sessionId, 1).map((e) => e.seq)).toEqual([3]);
  expect(store.transcript.list(ticket.sessionId, 0, 1).map((e) => e.seq)).toEqual([1]);
  expect(store.transcript.list(ticket.sessionId, 0, 10, "sub-1").map((e) => e.seq)).toEqual([2]);
  expect(() => store.transcript.append("missing", null, "user", { type: "text", text: "x" })).toThrow(/Unknown session/);
});

test("tail returns the last N entries of the wanted types, oldest first", () => {
  const { store, ticket } = setup();
  for (const [i, type] of (["text", "text", "tool_call", "text"] as const).entries()) {
    store.transcript.append(ticket.sessionId, null, "assistant", type === "text" ? { type, text: String(i) } : ({ type, callId: "c", toolName: "t", input: {} } as never));
  }
  expect(store.transcript.tail(ticket.sessionId, 2, ["text"]).map((e) => e.seq)).toEqual([2, 4]);
  expect(store.transcript.tail(ticket.sessionId, 10, ["tool_call"]).map((e) => e.seq)).toEqual([3]);
  expect(store.transcript.tail(ticket.sessionId, 0, ["text"])).toEqual([]);
  expect(store.transcript.tail(ticket.sessionId, 5, [])).toEqual([]);
});

test("transcript.messageAttachments only reads user entries", () => {
  const { store, ticket } = setup();
  const file: Attachment = { id: "a1", path: "/f.png", name: "f", source: "upload", kind: "image", mimeType: "image/png" };
  store.transcript.append(ticket.sessionId, null, "user", { type: "text", text: "see", attachments: [file] });
  store.transcript.append(ticket.sessionId, null, "assistant", { type: "text", text: "no", attachments: [file] } as never);
  expect(store.transcript.messageAttachments(ticket.sessionId)).toEqual([{ sessionId: ticket.sessionId, attachment: file }]);
  expect(store.transcript.messageAttachments("other")).toEqual([]);
});

test("spec revisions: stale base is refused with the current text, an unchanged body adds nothing, and the baseline follows Start", () => {
  const { clock, store, ticket } = setup();
  clock.advance(5);
  const r2 = store.specs.revise(ticket.id, { body: "v2", author: "agent", note: "n", runKind: "plan", baseRevision: 1 })!;
  expect(r2).toMatchObject({ rev: 2, author: "agent", runKind: "plan", createdAt: 1_005, approvedBaseline: false });
  expect(store.specs.revise(ticket.id, { body: "v2", author: "human", note: "same" })).toBeNull();
  try {
    store.specs.revise(ticket.id, { body: "v3", author: "human", note: "late", baseRevision: 1 });
    throw new Error("expected a conflict");
  } catch (e) {
    expect(e).toBeInstanceOf(SpecConflictError);
    expect(e).toMatchObject({ currentRevision: 2, currentBody: "v2", baseRevision: 1 });
  }
  expect(store.specs.markBaseline(ticket.id)).toBe(2);
  expect(store.specs.list(ticket.id).map((r) => r.approvedBaseline)).toEqual([false, true]);
  expect(store.tickets.get(ticket.id)).toMatchObject({ spec: "v2", specRevision: 2, specBaselineRevision: 2 });
  store.specs.revise(ticket.id, { body: "v3", author: "human", note: "x" });
  expect(store.specs.markBaseline(ticket.id)).toBe(3);
  expect(store.specs.list(ticket.id).map((r) => r.approvedBaseline)).toEqual([false, false, true]);
  expect(store.specs.get(ticket.id, 9)).toBeNull();
  expect(() => store.specs.revise("missing", { body: "x", author: "human", note: "x" })).toThrow(/Unknown ticket/);
});

test("replaceDraft rewrites revision 1 in place", () => {
  const { store, ticket } = setup();
  store.specs.replaceDraft(ticket.id, "edited");
  expect(store.specs.list(ticket.id)).toHaveLength(1);
  expect(store.specs.get(ticket.id, 1)!.body).toBe("edited");
  expect(store.tickets.get(ticket.id)!.spec).toBe("edited");
});

test("driver state belongs to the driver that wrote it: another driver reads none, and clearing clears the gauge", () => {
  const { store, ticket } = setup();
  const id = ticket.sessionId;
  expect(store.sessions.getDriverState(id)).toBeNull();
  store.sessions.setDriverState(id, { conv: 1 }, "claude-code");
  store.sessions.setContext(id, { used: 5 } as never);
  expect(store.sessions.getDriverState(id, "claude-code")).toEqual({ conv: 1 });
  expect(store.sessions.getDriverState(id, "copilot")).toBeNull();
  expect(store.sessions.getDriverState(id)).toEqual({ conv: 1 });
  expect(store.sessions.stateDriver(id)).toBe("claude-code");
  store.sessions.setDriverState(id, null);
  expect(store.sessions.stateDriver(id)).toBeNull();
  expect(store.sessions.getContext(id)).toBeNull();
});

test("a state saved with no recorded writer counts as the session's driver's", () => {
  const { store, ticket } = setup();
  store.sessions.setDriverState(ticket.sessionId, { x: 1 });
  expect(store.sessions.stateDriver(ticket.sessionId)).toBe("claude-code");
  expect(store.sessions.getDriverState(ticket.sessionId, "claude-code")).toEqual({ x: 1 });
});

test("deleting a session removes its transcript, runs, activity and calls", () => {
  const { store, ticket } = setup();
  const run = store.runs.create({ sessionId: ticket.sessionId, kind: "work", driver: "d", prompt: "p" });
  store.transcript.append(ticket.sessionId, run.id, "user", { type: "text", text: "x" });
  store.activity.add({ sessionId: ticket.sessionId, ticketId: ticket.id, kind: "note", author: "agent", body: "b" });
  store.sessions.addCall(ticket.sessionId, run.id, { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, estimated: true });
  expect(store.sessions.listCalls(ticket.sessionId)).toEqual([{ runId: run.id, at: 1_000, input: 1, cacheRead: 2, cacheWrite: 3, output: 4, estimated: true }]);
  store.tickets.delete(ticket.id);
  store.sessions.delete(ticket.sessionId);
  expect(store.sessions.get(ticket.sessionId)).toBeNull();
  expect(store.runs.listBySession(ticket.sessionId)).toEqual([]);
  expect(store.transcript.list(ticket.sessionId)).toEqual([]);
  expect(store.activity.listBySession(ticket.sessionId)).toEqual([]);
  expect(store.sessions.listCalls(ticket.sessionId)).toEqual([]);
});

test("session list filters by kind, newest first, and busy tracks open runs", () => {
  const { clock, store, project, ticket } = setup();
  clock.advance(1);
  const chat = store.sessions.create({ key: "CHAT-1", kind: "triage", ticketId: null, driver: "d", cwd: project.path, title: "c" });
  expect(store.sessions.list().map((s) => s.id)).toEqual([chat.id, ticket.sessionId]);
  expect(store.sessions.list("ticket").map((s) => s.id)).toEqual([ticket.sessionId]);
  expect(store.sessions.get(chat.id)!.busy).toBe(false);
  store.runs.create({ sessionId: chat.id, kind: "triage", driver: "d", prompt: "p" });
  expect(store.sessions.get(chat.id)!.busy).toBe(true);
  expect(store.sessions.update(chat.id, { title: "t2", outcome: "done" })).toMatchObject({ title: "t2", outcome: "done", updatedAt: 1_001 });
});

test("seen items: the first sighting of (source, key, version) is new, a repeat isn't, forget resets one source", () => {
  const { store } = setup();
  expect(store.seen.markSeen("jira", "A-1", "v1")).toBe(true);
  expect(store.seen.markSeen("jira", "A-1", "v1")).toBe(false);
  expect(store.seen.markSeen("jira", "A-1", "v2")).toBe(true);
  expect(store.seen.markSeen("jira", "A-1", null)).toBe(true);
  expect(store.seen.markSeen("jira", "A-1", null)).toBe(false);
  expect(store.seen.markSeen("other", "A-1", "v1")).toBe(true);
  store.seen.forget("jira");
  expect(store.seen.markSeen("jira", "A-1", "v1")).toBe(true);
  expect(store.seen.markSeen("other", "A-1", "v1")).toBe(false);
});

test("settings round-trip JSON, skip undefined, delete by key, and ignore a row that isn't JSON", () => {
  const { store } = setup();
  store.settings.set({ a: 1, b: { c: [1, 2] }, skipped: undefined });
  store.db.exec("INSERT INTO settings (key, value) VALUES ('bad', '{not json')");
  expect(store.settings.all()).toMatchObject({ a: 1, b: { c: [1, 2] } });
  expect("bad" in store.settings.all()).toBe(false);
  expect("skipped" in store.settings.all()).toBe(false);
  store.settings.set({ a: 2 });
  store.settings.delete(["b"]);
  expect(store.settings.all().a).toBe(2);
  expect("b" in store.settings.all()).toBe(false);
});

test("counters count up per name", () => {
  const { store } = setup();
  expect([store.counters.next("TRIAGE"), store.counters.next("TRIAGE"), store.counters.next("OTHER")]).toEqual([1, 2, 1]);
});

test("watchers: defaults, partial updates keep the rest, undefined patch fields are ignored", () => {
  const { clock, store } = setup();
  const w = store.watchers.create({ name: "jira", command: "node", args: ["w.js"] });
  expect(w).toMatchObject({ mode: "loop", intervalSec: 300, enabled: true, prompt: "", env: {}, models: {}, driver: null, lastRunAt: null });
  clock.advance(7);
  const u = store.watchers.update(w.id, { enabled: false, lastRunAt: 99, lastError: "x", prompt: undefined })!;
  expect(u).toMatchObject({ enabled: false, lastRunAt: 99, lastError: "x", args: ["w.js"], prompt: "", updatedAt: 1_007 });
  expect(store.watchers.update("missing", { enabled: true })).toBeNull();
  store.watchers.delete(w.id);
  expect(store.watchers.list()).toEqual([]);
});

test("sub-agents: a finished one stays finished, ended_at is set once, and a no-op report returns null", () => {
  const { clock, store, ticket } = setup();
  const s = ticket.sessionId;
  const first = store.subagents.upsert(s, "run1", { id: "a", description: "d", prompt: "p" })!;
  expect(first).toMatchObject({ status: "running", startedAt: 1_000, endedAt: null, kind: "agent" });
  clock.advance(5);
  const done = store.subagents.upsert(s, "run1", { id: "a", status: "succeeded", result: "ok" })!;
  expect(done).toMatchObject({ status: "succeeded", result: "ok", endedAt: 1_005, description: "d" });
  clock.advance(5);
  expect(store.subagents.upsert(s, "run1", { id: "a", status: "running", result: "late" })).toBeNull();
  expect(store.subagents.get(s, "a")).toMatchObject({ status: "succeeded", result: "ok", endedAt: 1_005 });
});

test("stopRunning ends only the run's running sub-agents", () => {
  const { store, ticket } = setup();
  const s = ticket.sessionId;
  store.subagents.upsert(s, "r1", { id: "a" });
  store.subagents.upsert(s, "r1", { id: "b", status: "succeeded" });
  store.subagents.upsert(s, "r2", { id: "c" });
  expect(store.subagents.stopRunning("r1").map((x) => [x.id, x.status])).toEqual([["a", "stopped"]]);
  expect(store.subagents.get(s, "b")!.status).toBe("succeeded");
  expect(store.subagents.get(s, "c")!.status).toBe("running");
});

test("background task output: agents have none, a task's file path and saved tail come back", () => {
  const { store, ticket } = setup();
  const s = ticket.sessionId;
  store.subagents.upsert(s, "r", { id: "agent" });
  store.subagents.upsert(s, "r", { id: "task", kind: "bash", command: "make", outputPath: "/tmp/out" });
  expect(store.subagents.outputSource(s, "agent")).toBeNull();
  expect(store.subagents.outputSource(s, "nope")).toBeNull();
  expect(store.subagents.outputSource(s, "task")).toEqual({ path: "/tmp/out", snapshot: null });
  expect(store.subagents.get(s, "task")!.hasOutput).toBe(true);
  store.subagents.saveOutput(s, "task", { text: "tail", start: 10, size: 14 });
  expect(store.subagents.outputSource(s, "task")!.snapshot).toEqual({ text: "tail", start: 10, size: 14 });
  // The path set by the first report is not replaced by a later one.
  store.subagents.upsert(s, "r", { id: "task", outputPath: "/tmp/other", status: "succeeded" });
  expect(store.subagents.outputSource(s, "task")!.path).toBe("/tmp/out");
});

test("attachments: spec media go with their ticket, unowned ones are listed oldest first, delete by id", () => {
  const { clock, store, ticket } = setup();
  const mk = (id: string, source: Attachment["source"]): Attachment => ({ id, path: `/${id}`, name: id, source, kind: "image", mimeType: "image/png", size: 3, width: 4, height: 5 });
  store.attachments.add(ticket.id, [mk("s1", "spec")]);
  store.attachments.add(null, [mk("u1", "upload")]);
  clock.advance(1);
  store.attachments.add(null, [mk("u2", "upload"), { ...mk("f1", "file"), path: "/u1" }]);
  expect(store.attachments.listByTicket(ticket.id)).toEqual([mk("s1", "spec")]);
  expect(store.attachments.listUnowned().map((a) => [a.id, a.createdAt])).toEqual([["u1", 1_000], ["u2", 1_001], ["f1", 1_001]]);
  expect(store.attachments.getByPath("/u1", "upload")!.id).toBe("u1");
  expect(store.attachments.getByPath("/u1", "file")!.id).toBe("f1");
  store.attachments.delete(["u1", "nope"]);
  expect(store.attachments.get("u1")).toBeNull();
  store.tickets.delete(ticket.id);
  expect(store.attachments.get("s1")).toBeNull();
});

test("browser tabs: save replaces, load drops malformed tabs and unusable sizes, delete forgets, an unknown session is refused", () => {
  const { store, ticket } = setup();
  const s = ticket.sessionId;
  expect(store.browserTabs.load(s)).toBeNull();
  store.browserTabs.save(s, { nextTabId: 3, tabs: [{ id: 1, url: "http://a", title: "A", size: { device: "mobile", width: 390, height: 844, responsive: true } }, { id: 2, url: "http://b", title: "B" }] });
  store.db.query("UPDATE browser_tabs SET tabs = $t").run({
    t: JSON.stringify([{ id: 1, url: "u", title: "t", size: { device: "tv", width: 1, height: 1 } }, { id: 0, url: "u", title: "t" }, { id: 2, url: 5, title: "t" }, { id: 4, url: "ok", title: "t", size: { device: "desktop", width: 10, height: 20 } }]),
  });
  expect(store.browserTabs.load(s)).toEqual({ nextTabId: 3, tabs: [{ id: 1, url: "u", title: "t" }, { id: 4, url: "ok", title: "t", size: { device: "desktop", width: 10, height: 20 } }] });
  store.browserTabs.save(s, { nextTabId: 9, tabs: [] });
  expect(store.browserTabs.load(s)).toEqual({ nextTabId: 9, tabs: [] });
  store.browserTabs.delete(s);
  expect(store.browserTabs.load(s)).toBeNull();
  expect(() => store.browserTabs.save("missing", { nextTabId: 1, tabs: [] })).toThrow();
});

test("devices: a token belongs to one install, so re-registering under a new id replaces the old row", () => {
  const { clock, store } = setup();
  const d = (id: string, token: string) => ({ id, platform: "ios" as const, name: id, apnsToken: token, topic: "t", environment: "sandbox" as const });
  store.devices.upsert(d("old", "tok"));
  clock.advance(10);
  store.devices.upsert(d("new", "tok"));
  expect(store.devices.list().map((x) => x.id)).toEqual(["new"]);
  clock.advance(10);
  const again = store.devices.upsert({ ...d("new", "tok2"), name: "renamed" });
  expect(again).toMatchObject({ name: "renamed", apnsToken: "tok2", createdAt: 1_010, lastSeen: 1_020 });
  expect(store.devices.deleteByToken("tok2")).toBe(true);
  expect(store.devices.delete("new")).toBe(false);
});
