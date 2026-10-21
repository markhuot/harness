import { afterEach, expect, test } from "bun:test";
import type { Cos, CosMemory, Ticket } from "@harness/shared";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

async function chief() {
  const rig = await boot();
  const cos = await rig.ok<Cos>("POST", "/cos", { scope: "all" });
  return { rig, cos, path: `/tickets/${cos.key}/memory` };
}

test("the human reads and replaces a chief's memory; the next write must name the revision it read", async () => {
  const { rig, path } = await chief();
  const empty = await rig.ok<CosMemory>("GET", path);
  expect(empty.text).toBe("");

  const saved = await rig.ok<CosMemory>("PUT", path, { text: "## Triage guidance\n\nIgnore bots.\n", baseRevision: empty.revision });
  expect(saved.revision).not.toBe(empty.revision);
  expect(await rig.ok<CosMemory>("GET", path)).toEqual(saved);

  const stale = await rig.call<{ currentRevision: string; text: string }>("PUT", path, { text: "lost", baseRevision: empty.revision });
  expect(stale.status).toBe(409);
  expect(stale.body.data).toEqual({ currentRevision: saved.revision, text: "## Triage guidance\n\nIgnore bots.\n" });
  expect((await rig.ok<CosMemory>("GET", path)).text).toContain("Ignore bots.");
});

test("a chief's own edit moves the revision, so a human's save from before it is refused", async () => {
  const { rig, cos, path } = await chief();
  const opened = await rig.ok<CosMemory>("GET", path);
  // What update_memory_section does to the same notes.
  rig.harness.store.tickets.update(cos.ticketId, { agentNotes: "## Preferences\n\nShort.\n" });
  expect((await rig.call("PUT", path, { text: "mine", baseRevision: opened.revision })).status).toBe(409);
  const now = await rig.ok<CosMemory>("GET", path);
  expect((await rig.call("PUT", path, { text: "mine", baseRevision: now.revision })).status).toBe(200);
});

test("a whitespace-only save stores nothing and returns the revision of the empty memory, so the next save isn't refused", async () => {
  const { rig, path } = await chief();
  const empty = await rig.ok<CosMemory>("GET", path);
  const saved = await rig.ok<CosMemory>("PUT", path, { text: "  \n", baseRevision: empty.revision });
  expect(saved).toEqual({ text: "", revision: empty.revision });
  expect((await rig.call("PUT", path, { text: "## A\n\nx", baseRevision: saved.revision })).status).toBe(200);
});

test("the memory routes refuse a missing baseRevision, a non-string or oversize text, and a ticket that isn't a chief", async () => {
  const { rig, path } = await chief();
  const { revision } = await rig.ok<CosMemory>("GET", path);
  expect((await rig.call("PUT", path, { text: "x" })).status).toBe(400);
  expect((await rig.call("PUT", path, { text: 5, baseRevision: revision })).status).toBe(400);
  expect((await rig.call("PUT", path, { text: "x".repeat(17_000), baseRevision: revision })).status).toBe(400);
  const project = await rig.project("MEM");
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "A task", start: false });
  expect((await rig.call("GET", `/tickets/${ticket.key}/memory`)).status).toBe(409);
  expect((await rig.call("GET", "/tickets/NOPE-1/memory")).status).toBe(404);
});
