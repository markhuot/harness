import { afterEach, expect, test } from "bun:test";
import { toolCall, type Step } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";
import { pngBytes, writeFile } from "../files";

afterEach(stopAll);

/** One run of the agent calling these tools in order; each result's text and error flag come back in `results`. */
async function agentRun(calls: [name: string, input: unknown][], opts: { files?: (cwd: string) => void } = {}) {
  const h = makeOrchestrator({ tools: undefined });
  const results: { text: string; isError: boolean }[] = [];
  const steps: Step[] = calls.flatMap(([name, input]) =>
    toolCall(name, input, (r) => results.push({ text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError })),
  );
  h.driver.script(steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Line one\nLine two\nLine three", skipAgentReview: true });
  opts.files?.(h.project.path);
  await h.settle();
  return { h, t, results };
}

test("read_spec numbers the lines and names the revision to pass back when editing", async () => {
  const { results } = await agentRun([["read_spec", {}]]);
  expect(results[0]!.text).toContain("Revision 1 (current)");
  expect(results[0]!.text).toContain("   2\tLine two");
  expect(results[0]!.text).toContain("Pass base_revision 1");
});

test("edit_spec applies exact-text edits as the next revision, with the note in Activity, and announces spec.revised", async () => {
  const { h, t, results } = await agentRun([["edit_spec", { base_revision: 1, note: "Reworded line two", edits: [{ old_string: "Line two", new_string: "Second line" }] }]]);
  expect(results[0]).toEqual({ text: "Spec updated to revision 2.", isError: false });
  expect(h.ticket(t.key)).toMatchObject({ spec: "Line one\nSecond line\nLine three", specRevision: 2 });
  expect(h.store.specs.list(t.id).map((r) => [r.rev, r.author, r.runKind])).toEqual([[1, "system", null], [2, "agent", "work"]]);
  expect(h.store.activity.listBySession(t.sessionId).map((a) => `${a.kind}: ${a.body}`)).toContain("spec_revised: Reworded line two");
  expect(h.events.some((e) => e.kind === "spec.revised" && e.rev === 2)).toBe(true);
});

test("an edit based on an old revision changes nothing and says which revision to re-read", async () => {
  const { h, t, results } = await agentRun([
    ["edit_spec", { base_revision: 1, note: "first", edits: [{ old_string: "one", new_string: "1" }] }],
    ["edit_spec", { base_revision: 1, note: "stale", edits: [{ old_string: "two", new_string: "2" }] }],
  ]);
  expect(results[1]!.isError).toBe(true);
  expect(results[1]!.text).toContain("is at revision 2, not 1");
  expect(h.ticket(t.key).spec).toContain("Line two");
});

test("an edit that can't apply names the failing edit and the revision the spec stays at", async () => {
  const { results } = await agentRun([["edit_spec", { base_revision: 1, note: "n", edits: [{ old_string: "missing text", new_string: "x" }] }]]);
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toMatch(/Edit 1: old_string wasn't found.*No edit was applied; the spec is still at revision 1/);
});

test("update_spec replaces the spec and can retitle the ticket and its session", async () => {
  const { h, t, results } = await agentRun([["update_spec", { base_revision: 1, note: "Rewrote", spec: "# New\nbody", title: "New title" }]]);
  expect(results[0]!.text).toContain('Retitled to "New title"');
  expect(h.ticket(t.key)).toMatchObject({ spec: "# New\nbody", title: "New title" });
  expect(h.store.sessions.get(t.sessionId)!.title).toBe("New title");
});

test("a write that leaves the spec as it was adds no revision", async () => {
  const { h, t, results } = await agentRun([["update_spec", { base_revision: 1, note: "same", spec: "Line one\nLine two\nLine three" }]]);
  expect(results[0]!.text).toContain("already reads that way");
  expect(h.store.specs.list(t.id)).toHaveLength(1);
});

test("a local image in the spec is validated and stored as an attachment, and its src becomes attachment:<id>", async () => {
  const { h, t, results } = await agentRun([["update_spec", { base_revision: 1, note: "Added a screenshot", spec: "Status\n![After](shots/after.png)" }]], {
    files: (cwd) => void writeFile(cwd, "shots/after.png", pngBytes(10, 20)),
  });
  expect(results[0]!.isError).toBe(false);
  const stored = h.store.attachments.listByTicket(t.id);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ source: "spec", kind: "image", width: 10, height: 20 });
  expect(h.ticket(t.key).spec).toBe(`Status\n![After](attachment:${stored[0]!.id})`);
});

test("an image that doesn't exist refuses the whole write", async () => {
  const { h, t, results } = await agentRun([["update_spec", { base_revision: 1, note: "n", spec: "![x](nope.png)" }]]);
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toContain("Attachment not found");
  expect(h.store.specs.list(t.id)).toHaveLength(1);
  expect(h.store.attachments.listByTicket(t.id)).toEqual([]);
});

test("post_note adds one Activity line from the agent; an empty note is an error", async () => {
  const { h, t, results } = await agentRun([["post_note", { note: "Tests pass\nmore detail" }], ["post_note", { note: "  " }]]);
  expect(results[0]!.isError).toBe(false);
  expect(results[1]!.isError).toBe(true);
  const notes = h.store.activity.listBySession(t.sessionId).filter((a) => a.kind === "note");
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ author: "agent", body: "Tests pass" });
  expect(notes[0]!.meta.detail).toContain("more detail");
});

test("update_notes stores the agent's notes on the ticket for later runs, trimmed, and an empty one clears them", async () => {
  const { h, t } = await agentRun([["update_notes", { notes: "  where things live  " }]]);
  expect(h.ticket(t.key).agentNotes).toBe("where things live");
  const again = await agentRun([["update_notes", { notes: "x" }], ["update_notes", { notes: "" }]]);
  expect(again.h.ticket(again.t.key).agentNotes).toBeNull();
});

test("the next run's context carries the notes the last one wrote", async () => {
  const { h, t } = await agentRun([["update_notes", { notes: "remember the flag" }]]);
  await h.orch.sendMessage(t.key, "go on", { move: true });
  await h.settle();
  expect(h.driver.requests[1]!.runContext).toContain("remember the flag");
});
