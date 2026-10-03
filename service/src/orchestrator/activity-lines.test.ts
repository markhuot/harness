// Activity as at-a-glance progress (DESIGN.md "Activity"): every entry's body is the first line
// of what was written, the whole of it in meta.detail when there's more, and every column change
// has an entry.
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { fakeContext, fakeSession } from "../tools/fakes";
import { makeOrchestrator } from "../testing/fakes";

function setup() {
  const h = makeOrchestrator();
  const dir = join(h.home, "proj", "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  return { ...h, project };
}

const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);
const kinds = (h: ReturnType<typeof setup>, key: string) => h.orch.activity(key).map((e) => ({ kind: e.kind, body: e.body, detail: e.meta.detail }));

describe("agents' notes show their first line", () => {
  test("post_note, submit_for_review and an approval take any length: the first line in full, the rest in detail", async () => {
    const h = setup();
    const long = `Still running tests: ${"suite ".repeat(100)}done`;
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      const { ops } = req.toolContext;
      const ctx = req.toolContext;
      if (req.kind === "work") {
        await ops.postNote(ctx, "Ran the tests.\n\nAll green except the UI suite.");
        await ops.postNote(ctx, long);
        await ops.submitForReview(ctx, "## Summary\n- did it", true);
      }
      if (req.kind === "review") await ops.reviewDecision(ctx, "approve", "Approved, with three open questions in the spec.\n\n- retry cap?\n- Safari?\n- README?");
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket).toMatchObject({ status: "review", agentReview: "approved" });
    const entries = kinds(h, t.key);
    expect(entries).toContainEqual({ kind: "note", body: "Ran the tests.", detail: "Ran the tests.\n\nAll green except the UI suite." });
    // Over the recommended 400 characters, but nothing is refused or cut.
    expect(entries).toContainEqual({ kind: "note", body: long, detail: undefined });
    expect(entries).toContainEqual({ kind: "submitted", body: "Summary", detail: "## Summary\n- did it" });
    expect(entries.find((e) => e.kind === "review_approved")).toMatchObject({ body: "Approved, with three open questions in the spec.", detail: expect.stringContaining("- Safari?") });
    expect(h.orch.activity(t.key).every((e) => !e.body.includes("\n"))).toBe(true);
  });

  test("a conductor's approval shows its first line too; a human's is kept as written", async () => {
    const h = setup();
    const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Goal", kind: "conductor", start: false });
    await h.orch.idle();
    const child = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", title: "child", parentId: parent.id, start: false });
    await h.orch.idle();
    h.store.tickets.update(parent.id, { status: "in_progress" });
    h.store.tickets.update(child.id, { status: "review", agentReview: "approved" });
    const p = h.store.tickets.get(parent.id)!;
    const ctx = fakeContext({ runKind: "conductor", ticket: p, session: fakeSession({ id: p.sessionId, key: p.key, ticketId: p.id }), ops: h.orch.ops });
    await h.orch.ops.reviewTicket(ctx, child.key, "approve", "Fine; ship it.\nChecked the tests.");
    expect(kinds(h, child.key).find((e) => e.kind === "approved")).toEqual({ kind: "approved", body: "Fine; ship it.", detail: "Fine; ship it.\nChecked the tests." });

    const solo = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a link" });
    await h.orch.idle();
    h.orch.humanReview(solo.key, { decision: "approve", notes: "Fine.\nShip it." });
    expect(h.orch.activity(solo.key).find((e) => e.kind === "approved")!.body).toBe("Fine.\nShip it.");
  });
});

describe("review runs record findings in the spec", () => {
  test("a reviewer can edit_spec but not replace the spec; triage can do neither", async () => {
    const h = setup();
    const results: Record<string, string | null> = {};
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      const { ops } = req.toolContext;
      const ctx = req.toolContext;
      if (req.kind === "work") await ops.submitForReview(ctx, "Done.", true);
      if (req.kind === "review") {
        const rev = h.orch.ticketDetail(ctx.ticket!.key).ticket.specRevision ?? 1;
        results.edit = await errorOf(ops.editSpec(ctx, { baseRevision: rev, note: "Review: open questions", edits: [{ old_string: "Add a button", new_string: "Add a button\n\n## Open questions\n- Which color?" }] }));
        results.replace = await errorOf(ops.updateSpec(ctx, { spec: "gone", note: "x", baseRevision: rev + 1 }));
        await ops.reviewDecision(ctx, "approve", "Approved, with one open question in the spec.");
      }
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    expect(results.edit).toBeNull();
    expect(results.replace).toContain("isn't available in review runs");
    expect(h.orch.ticketDetail(t.key).ticket.spec).toContain("- Which color?");
    const tc = fakeContext({ runKind: "triage", ticket: h.store.tickets.get(t.id)!, session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: h.orch.ops });
    expect(await errorOf(h.orch.ops.editSpec(tc, { baseRevision: 1, note: "x", edits: [] }))).toContain("isn't available in triage runs");
  });
});

describe("long text the service records is summarized", () => {
  test("a reviewer's request-changes notes: Activity shows the first line, the author and the next reviewer get all of it", async () => {
    const h = setup();
    const notes = "Two problems.\n\n- `a.ts:3`: the handler swallows errors; rethrow\n- `a.test.ts`: assert the error path";
    let round = 0;
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      const { ops } = req.toolContext;
      if (req.kind === "work") await ops.submitForReview(req.toolContext, "Fixed it.", true);
      if (req.kind === "review") {
        round++;
        await ops.reviewDecision(req.toolContext, round === 1 ? "request_changes" : "approve", round === 1 ? notes : "Both fixed.");
      }
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Handle errors" });
    await h.orch.idle();
    const asked = h.orch.activity(t.key).find((e) => e.kind === "changes_requested")!;
    expect(asked.body).toBe("Two problems.");
    expect(asked.meta.detail).toBe(notes);
    const rework = h.driver.calls.filter((c) => c.kind === "work")[1]!;
    expect(rework.prompt).toContain("assert the error path");
    const second = h.driver.calls.filter((c) => c.kind === "review")[1]!;
    expect(second.prompt).toContain("`a.ts:3`: the handler swallows errors");
  });

  test("an auto-submit shows the first line of the agent's last message, with all of it in detail", async () => {
    const h = setup();
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      if (req.kind === "work") yield { type: "text", text: "## Done\n\nAdded the button.\n\n- tests pass\n- docs updated" };
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button" });
    await h.orch.idle();
    const submitted = h.orch.activity(t.key).find((e) => e.kind === "submitted")!;
    expect(submitted).toMatchObject({ author: "system", body: "Done", meta: { detail: "## Done\n\nAdded the button.\n\n- tests pass\n- docs updated" } });
  });

  test("a failed run's error is one line", async () => {
    const h = setup();
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      if (req.kind === "work") yield { type: "error", message: "boom\n    at a (a.ts:1)\n    at b (b.ts:2)" };
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x" });
    await h.orch.idle();
    const failed = h.orch.activity(t.key).find((e) => e.kind === "failed")!;
    expect(failed.body).toBe("Run failed: boom");
    expect(failed.meta.detail).toContain("at b (b.ts:2)");
  });
});

describe("every column change is in Activity", () => {
  /** The column moves Activity records, in order. */
  const moves = (h: ReturnType<typeof setup>, key: string) =>
    h.orch
      .activity(key)
      .filter((e) => e.meta.to)
      .map((e) => `${e.kind} ${e.meta.from}→${e.meta.to}`);

  test("start, submit, approve and land: one entry per move, on the entry that caused it or a moved entry", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", start: false });
    await h.orch.idle();
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    await h.orch.completeTicket(t.key, { skipAgent: true });
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(moves(h, t.key)).toEqual(["moved planning→in_progress", "submitted in_progress→review", "moved review→done"]);
    const started = h.orch.activity(t.key).find((e) => e.kind === "moved")!;
    expect(started).toMatchObject({ author: "system", body: "Work started" });
  });

  test("a human's drag is a moved entry by the human; block and unblock carry their own move", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    await h.orch.sendMessage(t.key, "Postgres /unblock /submit");
    await h.orch.idle();
    await h.orch.updateTicket(t.key, { status: "planning" });
    await h.orch.idle();
    expect(moves(h, t.key)).toEqual([
      "moved planning→in_progress",
      "blocked in_progress→blocked",
      "unblocked blocked→in_progress",
      "submitted in_progress→review",
      "moved review→planning",
    ]);
    expect(h.orch.activity(t.key).at(-1)).toMatchObject({ kind: "moved", author: "human", body: "" });
  });

  test("a status update that doesn't change the column adds no move", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "do it /block Which database?" });
    await h.orch.idle();
    const before = moves(h, t.key).length;
    await h.orch.sendMessage(t.key, "change the copy /block Which copy?");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.blockedReason).toBe("Which copy?");
    expect(moves(h, t.key)).toHaveLength(before);
  });
});
