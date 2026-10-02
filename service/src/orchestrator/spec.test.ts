// The spec and Activity through the orchestrator (DESIGN.md "Spec revisions and attachments",
// "Activity"): edit_spec's all-or-nothing errors against a human's concurrent edit, images in
// update_spec, the submit flag, what review runs read (baseline diff, earlier rounds) and which
// tools they get, and which messages land in Activity.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunKind, Ticket } from "@harness/shared";
import type { DriverEvent, RunRequest } from "../drivers/types";
import { makeOrchestrator } from "../testing/fakes";
import { mp4, png } from "../testing/media";
import { allTools, toolsForRun } from "../tools";
import { fakeContext, fakeSession } from "../tools/fakes";
import type { ToolResult } from "../tools/types";
import { HarnessError } from "./errors";
import { SPEC_NOT_UP_TO_DATE_MESSAGE } from "./orchestrator";
import { git } from "./worktree";

const SPEC = ["# Goal", "Make the header toggle work.", "", "## Status", "* Not started"].join("\n");

async function setup(opts: { git?: boolean } = {}) {
  const h = makeOrchestrator();
  // No agent by default: a ticket created in planning would otherwise get a plan run rewriting its spec.
  h.driver.script = async function* () {};
  const dir = join(h.home, "proj", "web");
  mkdirSync(join(dir, "shots"), { recursive: true });
  writeFileSync(join(dir, "shots", "after.png"), png(800, 600));
  writeFileSync(join(dir, "flow.mp4"), mp4(64));
  writeFileSync(join(dir, "fake.png"), "not really a png");
  writeFileSync(join(dir, "notes.txt"), "text");
  if (opts.git) {
    await git(["init", "-q", "-b", "main"], dir);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], dir);
  }
  const project = h.orch.createProject({ path: dir, key: "WEB", useWorktrees: false });
  const make = async (status: Ticket["status"] = "in_progress") => {
    const t = await h.orch.createTicket({ projectId: project.id, spec: SPEC, title: "Header toggle", start: false });
    if (status !== "planning") h.store.tickets.update(t.id, { status });
    return h.store.tickets.get(t.id)!;
  };
  const ctx = (t: Ticket, runKind: RunKind = "work") =>
    fakeContext({ runKind, ticket: t, cwd: dir, session: fakeSession({ id: t.sessionId, key: t.key, ticketId: t.id }), ops: h.orch.ops });
  const fresh = (t: Ticket) => h.store.tickets.get(t.id)!;
  return { ...h, dir, project, make, ctx, fresh };
}

const tool = (name: string) => allTools.find((t) => t.name === name)!;
const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("edit_spec", () => {
  test("applies its edits as one new revision with the note, author and run", async () => {
    const h = await setup();
    const t = await h.make();
    const r = await tool("edit_spec").execute(
      {
        base_revision: 1,
        note: "Status: toggle works",
        edits: [
          { old_string: "* Not started", new_string: "* Toggle works; `bun test` passes" },
          { start_line: 2, end_line: 2, new_text: "Make the header toggle work on mobile.", expected: "Make the header toggle work." },
        ],
      },
      h.ctx(t),
    );
    expect(text(r)).toBe("Spec updated to revision 2.");
    const u = h.fresh(t);
    expect(u.specRevision).toBe(2);
    expect(u.spec).toBe(["# Goal", "Make the header toggle work on mobile.", "", "## Status", "* Toggle works; `bun test` passes"].join("\n"));
    expect(h.orch.specRevisions(t.key).map(({ rev, author, note, runKind }) => ({ rev, author, note, runKind }))).toEqual([
      { rev: 1, author: "system", note: "Created", runKind: null },
      { rev: 2, author: "agent", note: "Status: toggle works", runKind: "work" },
    ]);
  });

  test("a stale base revision fails with the current one, and the human's concurrent edit survives", async () => {
    const h = await setup();
    const t = await h.make();
    await h.orch.updateTicket(t.key, { spec: SPEC.replace("Not started", "Human: hold off on mobile"), baseRevision: 1 });
    const human = h.fresh(t).spec;
    await expect(
      tool("edit_spec").execute({ base_revision: 1, note: "x", edits: [{ old_string: "Make the header", new_string: "Make the footer" }] }, h.ctx(h.fresh(t))),
    ).rejects.toThrow(/The spec is at revision 2, not 1.*Call read_spec/);
    expect(h.fresh(t).spec).toBe(human);
    expect(h.fresh(t).specRevision).toBe(2);
  });

  test("a missing or ambiguous old_string, or an expected mismatch, changes nothing and names the revision", async () => {
    const h = await setup();
    const t = await h.make();
    const cases: [unknown[], RegExp][] = [
      [[{ old_string: "* Started", new_string: "x" }], /old_string wasn't found \(the spec is at revision 1/],
      [[{ old_string: "e", new_string: "E" }], /appears \d+ times \(the spec is at revision 1\)/],
      [[{ start_line: 5, end_line: 5, new_text: "* Done", expected: "* In progress" }], /don't match expected \(the spec is at revision 1\)/],
    ];
    for (const [edits, error] of cases) {
      await expect(tool("edit_spec").execute({ base_revision: 1, note: "x", edits }, h.ctx(t))).rejects.toThrow(error);
    }
    expect(h.fresh(t).spec).toBe(SPEC);
    expect(h.orch.specRevisions(t.key)).toHaveLength(1);
  });

  test("all or nothing: a later failing edit drops the earlier ones in the call", async () => {
    const h = await setup();
    const t = await h.make();
    await expect(
      tool("edit_spec").execute(
        {
          base_revision: 1,
          note: "x",
          edits: [
            { old_string: "* Not started", new_string: "* Done" },
            { old_string: "no such text", new_string: "y" },
          ],
        },
        h.ctx(t),
      ),
    ).rejects.toThrow(/Edit 2: old_string wasn't found.*No edit was applied; the spec is still at revision 1/);
    expect(h.fresh(t).spec).toBe(SPEC);
  });

  test("review runs can read the spec but not change it", async () => {
    const h = await setup();
    const t = await h.make("review");
    await expect(h.orch.ops.editSpec(h.ctx(t, "review"), { baseRevision: 1, note: "x", edits: [{ old_string: "Goal", new_string: "Aim" }] })).rejects.toThrow(
      "edit_spec isn't available in review runs",
    );
    expect(await h.orch.ops.readSpec(h.ctx(t, "review"))).toContain("Revision 1 (current)");
  });
});

describe("which runs get the spec tools", () => {
  const names = (kind: RunKind) => toolsForRun(kind, { hasBuiltinTools: true, usesPermissionPromptTool: false }).map((t) => t.name);
  test("review runs get read_spec only; triage none; the others all three", () => {
    expect(names("review")).toContain("read_spec");
    expect(names("review")).not.toContain("edit_spec");
    expect(names("review")).not.toContain("update_spec");
    for (const n of ["read_spec", "edit_spec", "update_spec"]) expect(names("triage")).not.toContain(n);
    for (const kind of ["plan", "work", "chat", "conductor", "complete"] as RunKind[]) {
      expect(names(kind)).toEqual(expect.arrayContaining(["read_spec", "edit_spec", "update_spec", "post_note"]));
    }
  });
});

describe("update_spec images", () => {
  test("stores local images and videos as the ticket's attachments and rewrites their src", async () => {
    const h = await setup();
    const t = await h.make();
    const spec = `${SPEC}\n\n![After](shots/after.png)\n![Flow](${join(h.dir, "flow.mp4")})\n![Remote](https://example.com/a.png)`;
    const r = await tool("update_spec").execute({ spec, note: "Screenshots", base_revision: 1 }, h.ctx(t));
    expect(text(r)).toMatch(/^Spec updated to revision 2\. Stored 2 attachments \(after\.png → attachment:/);
    const [shot, video] = h.store.attachments.listByTicket(t.id);
    expect(shot).toMatchObject({ kind: "image", mimeType: "image/png", name: "after.png", width: 800, height: 600 });
    expect(video).toMatchObject({ kind: "video", mimeType: "video/mp4", name: "flow.mp4" });
    const body = h.fresh(t).spec;
    expect(body).toContain(`![After](attachment:${shot!.id})`);
    expect(body).toContain(`![Flow](attachment:${video!.id})`);
    expect(body).toContain("![Remote](https://example.com/a.png)");
    // The stored copy is what GET /attachments/:id serves, and outlives the worktree's file.
    const file = h.orch.attachmentFile(shot!.id)!;
    expect(readFileSync(file.path)).toEqual(png(800, 600));
    // get_ticket names the stored path, so a reviewer can open it.
    const detail = await h.orch.ops.getTicket(h.ctx(h.fresh(t)), t.key);
    expect(detail.attachments.map((a) => a.path)).toEqual([file.path, h.orch.attachmentFilePath(video!)]);
  });

  test("a bad extension or bad magic bytes fails the call and stores nothing", async () => {
    const h = await setup();
    const t = await h.make();
    for (const [src, error] of [
      ["notes.txt", "Unsupported attachment type: notes.txt"],
      ["fake.png", "Attachment fake.png is not a valid .png file"],
    ]) {
      await expect(tool("update_spec").execute({ spec: `![x](shots/after.png)\n![y](${src})`, note: "x", base_revision: 1 }, h.ctx(t))).rejects.toThrow(error);
    }
    expect(h.fresh(t).specRevision).toBe(1);
    expect(h.store.attachments.listByTicket(t.id)).toEqual([]);
    expect(existsSync(h.paths.attachmentsDir) ? readdirSync(h.paths.attachmentsDir) : []).toEqual([]);
  });

  test("deleting the ticket removes its attachment files", async () => {
    const h = await setup();
    const t = await h.make();
    await h.orch.ops.updateSpec(h.ctx(t), { spec: "![a](shots/after.png)", note: "x", baseRevision: 1 });
    const [a] = h.store.attachments.listByTicket(t.id);
    const path = h.orch.attachmentFilePath(a!);
    expect(existsSync(path)).toBe(true);
    await h.orch.deleteTicket(t.key);
    expect(existsSync(path)).toBe(false);
    expect(h.store.attachments.get(a!.id)).toBeNull();
  });
});

describe("PATCH spec", () => {
  test("needs baseRevision outside drafts; a stale one is a 409 with the current revision", async () => {
    const h = await setup();
    const t = await h.make("planning");
    await expect(h.orch.updateTicket(t.key, { spec: "x" })).rejects.toThrow("baseRevision is required with spec");
    await h.orch.updateTicket(t.key, { spec: "first", baseRevision: 1 });
    const err = await h.orch.updateTicket(t.key, { spec: "second", baseRevision: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.status).toBe(409);
    expect(err.data).toEqual({ currentRevision: 2, spec: "first" });
    // A PATCH without a spec needs no revision.
    await h.orch.updateTicket(t.key, { title: "Renamed" });
    expect(h.fresh(t)).toMatchObject({ title: "Renamed", spec: "first", specRevision: 2 });
  });
});

describe("submit_for_review", () => {
  test("without spec_is_up_to_date: true it fails and the ticket stays in progress", async () => {
    const h = await setup();
    const t = await h.make();
    for (const input of [{ note: "done" }, { note: "done", spec_is_up_to_date: false }]) {
      await expect(tool("submit_for_review").execute(input, h.ctx(t))).rejects.toThrow(SPEC_NOT_UP_TO_DATE_MESSAGE);
    }
    expect(h.fresh(t).status).toBe("in_progress");
    expect(h.orch.activity(t.key)).toEqual([]);
    // The tool advertises the flag as required.
    expect(tool("submit_for_review").inputSchema.required).toEqual(["note", "spec_is_up_to_date"]);
    await tool("submit_for_review").execute({ note: "Toggle fixed", spec_is_up_to_date: true }, h.ctx(t));
    expect(h.fresh(t).status).toBe("review");
    expect(h.orch.activity(t.key).map((e) => [e.kind, e.body])).toEqual([["submitted", "Toggle fixed"]]);
  });
});

describe("review runs", () => {
  /**
   * Work submits (editing the spec when `edit` says so), review rejects round 1 and approves
   * round 2. Records every review prompt.
   */
  async function reviewRounds(opts: { edit: boolean }) {
    const h = await setup({ git: true });
    const reviews: string[] = [];
    let workRuns = 0;
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      const ctx = req.toolContext;
      const t = h.store.tickets.get(ctx.ticket!.id)!;
      if (req.kind === "work") {
        workRuns++;
        await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", `work ${workRuns}`], h.dir);
        const before = workRuns === 1 ? "* Not started" : `* Round ${workRuns - 1}`;
        if (opts.edit) await ctx.ops.editSpec(ctx, { baseRevision: t.specRevision!, note: `Round ${workRuns}`, edits: [{ old_string: before, new_string: `* Round ${workRuns}` }] });
        await ctx.ops.submitForReview(ctx, `Submit ${workRuns}`, true);
      } else if (req.kind === "review") {
        reviews.push(req.prompt);
        await ctx.ops.reviewDecision(ctx, reviews.length === 1 ? "request_changes" : "approve", reviews.length === 1 ? "The toggle forgets its state on reload." : "Fixed.");
      }
      yield { type: "text", text: "ok" };
    };
    const t = await h.make("planning");
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    return { h, t, reviews };
  }

  test("round 2 gets round 1's commit and notes and is told to diff from it; round 1 isn't", async () => {
    const { h, t, reviews } = await reviewRounds({ edit: false });
    expect(reviews).toHaveLength(2);
    const [first, second] = reviews as [string, string];
    expect(first).not.toContain("## Earlier review rounds");
    expect(first).not.toContain("git diff");
    const round1 = h.orch.activity(t.key).find((e) => e.kind === "changes_requested")!;
    expect(round1.meta).toMatchObject({ by: "agent", round: 1 });
    expect(round1.meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(second).toContain("round 2, a re-review");
    expect(second).toContain(`Round 1: changes requested at commit ${round1.meta.commit}.\nThe toggle forgets its state on reload.`);
    expect(second).toContain(`\`git diff ${round1.meta.commit}..HEAD\``);
    // Round 2's Activity starts after round 1's decision.
    expect(second.split("## Activity since the last review")[1]).toContain("submitted, agent: Submit 2");
    expect(second.split("## Activity since the last review")[1]).not.toContain("Submit 1");
    const approved = h.orch.activity(t.key).find((e) => e.kind === "review_approved")!;
    expect(approved.meta).toMatchObject({ by: "agent", round: 2 });
  });

  test("the review prompt carries the spec's diff from the approved baseline", async () => {
    const { h, t, reviews } = await reviewRounds({ edit: true });
    expect(h.fresh(t).specBaselineRevision).toBe(1);
    expect(reviews[0]).toContain("Revision 1 is what the human approved by pressing Start:");
    expect(reviews[0]).toContain("-* Not started\n+* Round 1");
    expect(reviews[1]).toContain("-* Not started\n+* Round 2");
  });

  test("an untouched spec has no baseline diff", async () => {
    const { reviews } = await reviewRounds({ edit: false });
    expect(reviews[0]).toContain("None: the spec is still revision 1, as the human approved it.");
    expect(reviews[0]).not.toContain("```diff");
  });
});

describe("messages and Activity", () => {
  async function chatSetup() {
    const h = await setup();
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      if (req.kind === "chat") yield { type: "text", text: "The answer is 42." };
    };
    const t = await h.make("blocked");
    return { h, t };
  }

  test("log: true adds the message and the agent's answer", async () => {
    const { h, t } = await chatSetup();
    await h.orch.sendMessage(t.key, "What's the answer?", { log: true });
    await h.orch.idle();
    expect(h.orch.activity(t.key).map((e) => [e.kind, e.author, e.body])).toEqual([
      ["message", "human", "What's the answer?"],
      ["answer", "agent", "The answer is 42."],
    ]);
  });

  test("log: false adds neither; the message still reaches the agent", async () => {
    const { h, t } = await chatSetup();
    await h.orch.sendMessage(t.key, "What's the answer?");
    await h.orch.idle();
    expect(h.orch.activity(t.key)).toEqual([]);
    expect(h.driver.calls.at(-1)).toMatchObject({ kind: "chat" });
    expect(h.driver.calls.at(-1)!.prompt).toContain("What's the answer?");
  });

  test("a logged message to a planning ticket gets the plan run's answer", async () => {
    const h = await setup();
    h.driver.script = async function* (req: RunRequest): AsyncGenerator<DriverEvent> {
      if (req.kind === "plan") yield { type: "text", text: "Revised the plan." };
    };
    const t = await h.make("planning");
    await h.orch.sendMessage(t.key, "Plan for mobile too", { log: true });
    await h.orch.idle();
    expect(h.orch.activity(t.key).map((e) => e.kind)).toEqual(["message", "answer"]);
  });
});
