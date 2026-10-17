import { afterEach, expect, test } from "bun:test";
import type { HarnessEvent, Ticket, TranscriptEntry } from "@harness/shared";
import { failScript, gate } from "../service/fake-driver";
import { boot, stopRigs, type Rig } from "./boot";
import type { WsClient } from "./ws-client";

afterEach(stopRigs);

const texts = (events: HarnessEvent[]) => events.flatMap((e) => (e.kind === "transcript.appended" && e.entry.role === "assistant" && e.entry.content.type === "text" ? [e.entry.content.text] : []));
const seqs = (events: HarnessEvent[]) => events.flatMap((e) => (e.kind === "transcript.appended" ? [e.entry.seq] : []));
/** Everything the service had queued for a socket before this returns is in `ws.messages` (a change the service announces to every socket, sent last). */
async function fence(rig: Rig, sockets: WsClient[], n: number) {
  await rig.ok("PATCH", "/settings", { maxConcurrentRuns: n });
  for (const ws of sockets) await ws.event("settings.updated", (e) => e.settings.maxConcurrentRuns === n);
}
const inReview = (e: HarnessEvent) => e.kind === "ticket.upserted" && e.ticket.status === "review";

test("a run streams over /ws in the order the driver produced it, ending with the ticket in review", async () => {
  const rig = await boot();
  const release = gate();
  rig.driver.script([{ type: "text", text: "one" }, { wait: release }, { type: "text", text: "two" }]);
  const ws = await rig.socket();
  const project = await rig.project();
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Say hi", skipAgentReview: true });

  await ws.event("transcript.appended", (e) => e.entry.role === "assistant" && e.entry.content.type === "text" && e.entry.content.text === "one");
  // The driver is parked on the gate: nothing after "one" can have been sent.
  expect(texts(ws.events())).toEqual(["one"]);
  release.open();
  await ws.next((m) => m.type === "event" && inReview(m.event));
  await fence(rig, [ws], 11);

  const events = ws.events();
  expect(texts(events)).toEqual(["one", "two"]);
  const runStatuses = events.flatMap((e) => (e.kind === "run.upserted" ? [e.run.status] : []));
  expect(runStatuses.indexOf("queued")).toBeLessThan(runStatuses.indexOf("running"));
  expect(runStatuses.indexOf("running")).toBeLessThan(runStatuses.indexOf("succeeded"));
  const ticketStatuses = events.flatMap((e) => (e.kind === "ticket.upserted" ? [e.ticket.status] : []));
  expect(ticketStatuses[0]).toBe("planning");
  expect(ticketStatuses.at(-1)).toBe("review");

  // Each entry of the session's transcript arrives once, with seq counting up from 1 without a gap.
  const mine = seqs(events);
  expect(mine).toEqual(mine.map((_, i) => i + 1));
  const stored = await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript`);
  expect(stored.map((e) => e.seq)).toEqual(mine);
});

test("every connected socket receives the same events in the same order", async () => {
  const rig = await boot();
  const [a, b] = [await rig.socket(), await rig.socket()];
  const project = await rig.project();
  await rig.ok("POST", "/tickets", { projectId: project.id, spec: "Say hi", skipAgentReview: true });
  for (const ws of [a, b]) await ws.next((m) => m.type === "event" && inReview(m.event));
  await fence(rig, [a, b], 12);
  expect(a.events().length).toBeGreaterThan(5);
  expect(b.events()).toEqual(a.events());
});

test("a run that fails reaches the socket as a failed run, with the driver's message in the transcript", async () => {
  const rig = await boot();
  rig.driver.script(failScript("the model fell over"));
  const ws = await rig.socket();
  const project = await rig.project();
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Break", skipAgentReview: true });
  const failed = await ws.event("run.upserted", (e) => e.run.status === "failed");
  expect(failed.run.sessionId).toBe(ticket.sessionId);
  const stored = await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript`);
  expect(JSON.stringify(stored)).toContain("the model fell over");
});

test("requesting changes on a ticket in review sends it back to work and starts a second run", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  const project = await rig.project();
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Say hi", skipAgentReview: true });
  await ws.next((m) => m.type === "event" && inReview(m.event));
  expect(rig.driver.requests).toHaveLength(1);

  const release = gate();
  rig.driver.script([{ wait: release }, { type: "text", text: "second pass" }]);
  await rig.ok("POST", `/tickets/${ticket.key}/review`, { decision: "request_changes", note: "again" });
  await rig.driver.runStarted(2);
  expect((await rig.ok<{ ticket: Ticket }>("GET", `/tickets/${ticket.key}`)).ticket.status).toBe("in_progress");
  release.open();
  await ws.event("transcript.appended", (e) => e.entry.content.type === "text" && e.entry.content.text === "second pass");
  await ws.next((m) => m.type === "event" && inReview(m.event) && ws.events().filter(inReview).length >= 2);
  expect(rig.driver.requests).toHaveLength(2);
});
