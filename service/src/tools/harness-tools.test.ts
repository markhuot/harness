import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { fakeBrowser, fakeContext, fakeOps, fakeTicket } from "./fakes";
import { allTools } from "./index";
import type { ToolResult } from "./types";
import { RemoteIdError } from "./util";

function tool(name: string) {
  const t = allTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

function text(r: ToolResult): string {
  return r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

describe("tool catalogue", () => {
  test("names are unique and every schema lists only documented properties as required", () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of allTools) {
      expect(t.inputSchema.type).toBe("object");
      for (const r of t.inputSchema.required ?? []) expect(Object.keys(t.inputSchema.properties)).toContain(r);
      expect(t.description.length).toBeGreaterThan(30);
    }
  });

  test("input property names match DESIGN.md exactly", () => {
    const props = (name: string) => Object.keys(tool(name).inputSchema.properties).sort();
    expect(props("create_ticket")).toEqual(["attachments", "auto_start", "base_branch", "branch", "child", "conductor", "depends_on", "driver", "model", "project_key", "remote_id", "remote_url", "skip_agent_review", "skip_human_review", "spec", "start", "title", "use_worktree"]);
    expect(props("update_ticket")).toEqual(["base_branch", "base_revision", "branch", "depends_on", "driver", "key", "model", "permission_mode", "remote_id", "remote_url", "skip_agent_review", "skip_human_review", "spec", "title"]);
    expect(props("update_branch")).toEqual(["base_branch", "branch"]);
    expect(props("move_ticket")).toEqual(["key", "position", "status"]);
    expect(props("cancel_ticket")).toEqual(["key"]);
    expect(props("reopen_ticket")).toEqual(["key", "notes"]);
    expect(props("dispatch_ticket")).toEqual(["base_branch", "branch", "conductor", "key", "project_key", "spec", "start", "ticket_key", "title", "url"]);
    expect(props("decline_work")).toEqual(["reason", "title"]);
    expect(props("browser_open")).toEqual(["device", "height", "new_tab", "tab", "url", "wait_for", "width"]);
    expect(props("browser_tabs")).toEqual(["tab"]);
    expect(props("browser_resize")).toEqual(["device", "height", "tab", "wait_for", "width"]);
    expect(props("browser_close_tab")).toEqual(["tab"]);
    expect(props("browser_content")).toEqual(["format", "max_chars", "selector", "tab", "wait_for"]);
    expect(props("browser_click")).toEqual(["selector", "tab", "wait_for"]);
    expect(props("browser_type")).toEqual(["selector", "submit", "tab", "text", "wait_for"]);
    expect(props("browser_eval")).toEqual(["expression", "tab", "wait_for"]);
    expect(props("browser_screenshot")).toEqual(["full_page", "save_to", "selector", "tab", "wait_for"]);
    expect(props("browser_wait")).toEqual(["idle", "selector", "state", "tab", "text", "timeout", "url"]);
    expect(props("browser_run")).toEqual(["script", "tab", "timeout", "wait"]);
    expect(props("browser_run_status")).toEqual(["job", "wait"]);
    expect(props("browser_run_stop")).toEqual(["job"]);
    expect(props("edit_file")).toEqual(["new_string", "old_string", "path", "replace_all"]);
    expect(props("bash")).toEqual(["command", "timeout_ms"]);
    expect(props("review_decision")).toEqual(["decision", "notes"]);
    expect(props("submit_for_review")).toEqual(["note", "skip_agent_review", "skip_human_review", "spec_is_up_to_date"]);
    expect(props("post_note")).toEqual(["note"]);
    expect(props("read_spec")).toEqual(["revision"]);
    expect(props("edit_spec")).toEqual(["base_revision", "edits", "note"]);
    expect(props("update_spec")).toEqual(["base_revision", "note", "spec", "title"]);
    expect(props("complete_ticket")).toEqual(["action", "instructions", "key"]);
    expect(props("review_ticket")).toEqual(["action", "decision", "key", "notes"]);
    expect(props("record_pull_request")).toEqual(["head", "url"]);
    expect(props("list_tickets")).toEqual(["limit", "project_key", "scope", "status"]);
    expect(props("get_ticket")).toEqual(["include_transcript", "key"]);
    expect(props("search_tickets")).toEqual(["cursor", "limit", "project_key", "query"]);
  });
});

describe("ticket tools → HarnessOps", () => {
  test("post_note passes the note and returns a confirmation", async () => {
    const ops = fakeOps();
    const r = await tool("post_note").execute({ note: "did X" }, fakeContext({ ops }));
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe("Note added to Activity.");
    expect(ops.calls).toEqual([{ method: "postNote", args: ["did X"] }]);
  });

  test("read_spec passes the optional revision and returns what ops returns", async () => {
    const ops = fakeOps({ readSpec: async (_ctx, rev?: number) => `Revision ${rev ?? 4}\n   1\tGoal` });
    const current = await tool("read_spec").execute({}, fakeContext({ ops }));
    const earlier = await tool("read_spec").execute({ revision: 2 }, fakeContext({ ops }));
    expect(text(current)).toBe("Revision 4\n   1\tGoal");
    expect(text(earlier)).toBe("Revision 2\n   1\tGoal");
    expect(ops.calls).toEqual([
      { method: "readSpec", args: [undefined] },
      { method: "readSpec", args: [2] },
    ]);
    const bad = await tool("read_spec").execute({ revision: 0 }, fakeContext({ ops }));
    expect(bad.isError).toBe(true);
    expect(ops.calls).toHaveLength(2);
  });

  test("edit_spec maps base_revision and passes the edits through untouched", async () => {
    const ops = fakeOps();
    const edits = [{ old_string: "a", new_string: "b" }, { start_line: 3, end_line: 2, new_text: "* note" }];
    const r = await tool("edit_spec").execute({ base_revision: 3, note: "Status", edits }, fakeContext({ ops }));
    expect(text(r)).toBe("Spec updated to revision 2.");
    expect(ops.calls).toEqual([{ method: "editSpec", args: [{ baseRevision: 3, note: "Status", edits }] }]);
    // A missing base_revision or a non-list of edits never reaches ops (an empty list is spec.ts's to refuse).
    const noBase = await tool("edit_spec").execute({ note: "x", edits } as any, fakeContext({ ops }));
    const notList = await tool("edit_spec").execute({ base_revision: 3, note: "x", edits: "a" } as any, fakeContext({ ops }));
    for (const bad of [noBase, notList]) expect(bad.isError).toBe(true);
    expect(text(noBase)).toContain('"base_revision" is required');
    expect(ops.calls).toHaveLength(1);
  });

  test("update_spec maps base_revision and passes the optional title through", async () => {
    const ops = fakeOps();
    await tool("update_spec").execute({ spec: "1. a", note: "Plan drafted", base_revision: 1 }, fakeContext({ ops }));
    await tool("update_spec").execute({ spec: "1. b", note: "Retitled", base_revision: 2, title: "New" }, fakeContext({ ops }));
    expect(ops.calls).toEqual([
      { method: "updateSpec", args: [{ spec: "1. a", note: "Plan drafted", baseRevision: 1, title: undefined }] },
      { method: "updateSpec", args: [{ spec: "1. b", note: "Retitled", baseRevision: 2, title: "New" }] },
    ]);
    const noNote = await tool("update_spec").execute({ spec: "x", base_revision: 1 } as any, fakeContext({ ops }));
    expect(noNote.isError).toBe(true);
    expect(ops.calls).toHaveLength(2);
  });

  test("submit_for_review advertises spec_is_up_to_date as required but leaves the check to ops", async () => {
    expect(tool("submit_for_review").inputSchema.required).toEqual(["note", "spec_is_up_to_date"]);
    // A missing or false value still reaches ops, which refuses it with guidance (not a generic "is required").
    const ops = fakeOps();
    const missing = await tool("submit_for_review").execute({ note: "done" } as any, fakeContext({ ops }));
    expect(missing.isError).toBeUndefined();
    await tool("submit_for_review").execute({ note: "done", spec_is_up_to_date: false }, fakeContext({ ops }));
    expect(ops.calls.map((c) => c.args[1])).toEqual([undefined, false]);
    const refusing = fakeOps({
      submitForReview: async (_ctx, _note, upToDate) => {
        if (upToDate !== true) throw new Error("Bring the spec up to date with edit_spec or update_spec first");
      },
    });
    await expect(tool("submit_for_review").execute({ note: "done", spec_is_up_to_date: false }, fakeContext({ ops: refusing }))).rejects.toThrow("Bring the spec up to date");
  });

  test("submit_for_review passes both review skips through", async () => {
    const ops = fakeOps();
    await tool("submit_for_review").execute({ note: "done", spec_is_up_to_date: true, skip_agent_review: false, skip_human_review: true }, fakeContext({ ops }));
    expect(ops.calls).toEqual([{ method: "submitForReview", args: ["done", true, { skipAgentReview: false, skipHumanReview: true }] }]);
  });

  test("block and submit_for_review tell the model to stop", async () => {
    const ops = fakeOps();
    const b = await tool("block").execute({ question: "Which DB?" }, fakeContext({ ops }));
    const s = await tool("submit_for_review").execute({ note: "done", spec_is_up_to_date: true }, fakeContext({ ops }));
    expect(text(b)).toContain("Stop here");
    expect(text(s)).toBe("Ticket moved to review. Stop here.");
    expect(ops.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ["block", "Which DB?"],
      ["submitForReview", "done"],
    ]);
  });

  test("unblock passes its note along and tells the model to carry on, not stop", async () => {
    const ops = fakeOps();
    const r = await tool("unblock").execute({ note: "they picked Postgres" }, fakeContext({ ops }));
    expect(text(r)).toContain("Carry on with the work");
    expect(text(r)).not.toContain("Stop here");
    await tool("unblock").execute({}, fakeContext({ ops }));
    expect(ops.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ["unblock", "they picked Postgres"],
      ["unblock", undefined],
    ]);
    const refusing = fakeOps({ unblock: async () => { throw new Error("ACME-1 is review, not blocked"); } });
    await expect(tool("unblock").execute({}, fakeContext({ ops: refusing }))).rejects.toThrow("not blocked");
  });

  test("resume_work tells the model to make the changes and resubmit, not stop", async () => {
    const r = await tool("resume_work").execute({ note: "fixing the bug" }, fakeContext({ ops: fakeOps() }));
    expect(text(r)).toContain("submit_for_review");
    expect(text(r)).not.toContain("Stop here");
    expect(text(r)).not.toContain("working directory is now");
  });

  test("resume_work that moved the ticket's workdir (a re-opened done ticket) says where to work", async () => {
    const r = await tool("resume_work").execute({}, fakeContext({ ops: fakeOps({ resumeWork: async () => "/w/ACME-1" }) }));
    expect(text(r)).toContain("working directory is now /w/ACME-1");
    expect(text(r)).toContain("git -C /w/ACME-1");
  });

  test("review_decision rejects an unknown decision without calling ops", async () => {
    const ops = fakeOps();
    const bad = await tool("review_decision").execute({ decision: "maybe", notes: "" } as any, fakeContext({ ops }));
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('"decision" must be one of');
    expect(ops.calls).toEqual([]);
    await tool("review_decision").execute({ decision: "request_changes", notes: "fix foo" }, fakeContext({ ops }));
    expect(ops.calls).toEqual([{ method: "reviewDecision", args: ["request_changes", "fix foo"] }]);
  });

  test("missing, empty and mistyped required inputs are isError results", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    const missing = await tool("post_note").execute({} as any, ctx);
    const empty = await tool("block").execute({ question: "   " }, ctx);
    const typed = await tool("submit_for_review").execute({ note: 5, spec_is_up_to_date: true } as any, ctx);
    const nullInput = await tool("post_note").execute(null as any, ctx);
    for (const r of [missing, empty, typed, nullInput]) expect(r.isError).toBe(true);
    expect(text(missing)).toBe('Invalid input for post_note: "note" is required.');
    expect(text(empty)).toContain("must not be empty");
    expect(text(typed)).toContain('"note" must be a string');
    expect(ops.calls).toEqual([]);
  });

  test("errors thrown by ops propagate (executeTool turns them into isError)", async () => {
    const ops = fakeOps({ block: async () => { throw new Error("Only work runs can block"); } });
    await expect(tool("block").execute({ question: "q" }, fakeContext({ ops }))).rejects.toThrow("Only work runs can block");
  });
});

describe("board write tools → HarnessOps", () => {
  test("create_ticket passes start, conductor, project, driver; an empty model means the driver default", async () => {
    const ops = fakeOps();
    await tool("create_ticket").execute(
      { title: "Docs", spec: "Write docs", project_key: "WEB", start: true, conductor: true, driver: "claude-code", model: " " },
      fakeContext({ ops }),
    );
    expect(ops.calls[0]!.args[0]).toEqual({
      title: "Docs",
      spec: "Write docs",
      projectKey: "WEB",
      start: true,
      conductor: true,
      driver: "claude-code",
      model: null,
    });
  });

  test("update_ticket maps permission_mode \"inherit\" to null", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", spec: "d" }, ctx);
    const r = await tool("update_ticket").execute({ key: "TEST-2", title: "Renamed", permission_mode: "inherit", depends_on: [] }, ctx);
    await tool("update_ticket").execute({ key: "TEST-2", permission_mode: "read_only", model: "claude-opus-5-5" }, ctx);
    const patches = ops.calls.filter((c) => c.method === "updateTicket").map((c) => c.args);
    expect(patches[0]).toEqual(["TEST-2", { title: "Renamed", permissionMode: null, dependsOn: [] }]);
    expect(patches[1]).toEqual(["TEST-2", { permissionMode: "read_only", model: "claude-opus-5-5" }]);
    expect(JSON.parse(text(r).split("\n").slice(1).join("\n"))).toMatchObject({ key: "TEST-2", title: "Renamed" });
  });

  test("update_ticket and move_ticket reject unknown enum values before calling ops", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    const bad = await tool("update_ticket").execute({ key: "TEST-2", permission_mode: "yolo" } as any, ctx);
    expect(text(bad)).toContain('"permission_mode" must be one of');
    const move = await tool("move_ticket").execute({ key: "TEST-2", status: "archived" } as any, ctx);
    expect(text(move)).toContain('"status" must be one of');
    const pos = await tool("move_ticket").execute({ key: "TEST-2", status: "planning", position: 1.5 }, ctx);
    expect(text(pos)).toContain('"position" must be an integer');
    expect(ops.calls).toEqual([]);
  });

  test("move/cancel/reopen map key and arguments", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", spec: "d" }, ctx);
    const m = await tool("move_ticket").execute({ key: "TEST-2", status: "in_progress", position: 0 }, ctx);
    await tool("move_ticket").execute({ key: "TEST-2", status: "blocked" }, ctx);
    await tool("cancel_ticket").execute({ key: "TEST-2" }, ctx);
    await tool("reopen_ticket").execute({ key: "TEST-2", notes: "the footer is still broken" }, ctx);
    expect(ops.calls.slice(1)).toEqual([
      { method: "moveTicket", args: ["TEST-2", "in_progress", 0] },
      { method: "moveTicket", args: ["TEST-2", "blocked", undefined] },
      { method: "cancelTicket", args: ["TEST-2"] },
      { method: "reopenTicket", args: ["TEST-2", "the footer is still broken"] },
    ]);
    expect(text(m)).toBe("Moved TEST-2 (status: in_progress).");
    expect((await tool("reopen_ticket").execute({ key: "TEST-2", notes: " " }, ctx)).isError).toBe(true);
  });
});

describe("conductor tools → HarnessOps", () => {
  test("create_ticket maps snake_case to the ops input and returns the key", async () => {
    const ops = fakeOps();
    const r = await tool("create_ticket").execute(
      { title: "API", spec: "Build the API", depends_on: ["TEST-7"], auto_start: false },
      fakeContext({ ops }),
    );
    expect(ops.calls[0]).toEqual({
      method: "createTicket",
      args: [{ title: "API", spec: "Build the API", dependsOn: ["TEST-7"], autoStart: false }],
    });
    expect(text(r)).toStartWith("Created TEST-2.");
    expect(JSON.parse(text(r).split("\n").slice(1).join("\n"))).toMatchObject({ key: "TEST-2", dependsOn: ["TEST-7"], autoStart: false });
  });

  test("create_ticket rejects non-string depends_on entries", async () => {
    const ops = fakeOps();
    const r = await tool("create_ticket").execute({ title: "a", spec: "b", depends_on: [1] } as any, fakeContext({ ops }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"depends_on[0]" must be a string');
    expect(ops.calls).toEqual([]);
  });

  test("start/message/review/complete map key and arguments", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", spec: "d" }, ctx);
    await tool("start_ticket").execute({ key: "TEST-2" }, ctx);
    await tool("message_ticket").execute({ key: "TEST-2", text: "use postgres" }, ctx);
    const rv = await tool("review_ticket").execute({ key: "TEST-2", decision: "approve", notes: "ok" }, ctx);
    await tool("complete_ticket").execute({ key: "TEST-2", instructions: "merge into main" }, ctx);
    await tool("complete_ticket").execute({ key: "TEST-2" }, ctx);
    await tool("complete_ticket").execute({ key: "TEST-2", action: "pr" }, ctx);
    await tool("review_ticket").execute({ key: "TEST-2", decision: "approve", notes: "ok", action: "custom" }, ctx);
    expect(ops.calls.slice(1)).toEqual([
      { method: "startTicket", args: ["TEST-2"] },
      { method: "messageTicket", args: ["TEST-2", "use postgres"] },
      { method: "reviewTicket", args: ["TEST-2", "approve", "ok", undefined] },
      { method: "completeTicket", args: ["TEST-2", "merge into main", undefined] },
      { method: "completeTicket", args: ["TEST-2", undefined, undefined] },
      { method: "completeTicket", args: ["TEST-2", undefined, "pr"] },
      { method: "reviewTicket", args: ["TEST-2", "approve", "ok", "custom"] },
    ]);
    expect(text(rv)).toContain("human review: approved");
  });
});

describe("board tools → HarnessOps", () => {
  test("list_tickets maps snake_case filters, applies the default limit, and returns parseable JSON without specs", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    expect(text(await tool("list_tickets").execute({}, ctx))).toContain("no child tickets");
    await tool("create_ticket").execute({ title: "one", spec: "d" }, ctx);
    const r = await tool("list_tickets").execute({ scope: "all", project_key: "WEB", status: ["planning", "review"], limit: 5 }, ctx);
    expect(ops.calls.filter((c) => c.method === "listTickets").map((c) => c.args)).toEqual([
      [{ scope: undefined, projectKey: undefined, statuses: undefined, limit: 50 }],
      [{ scope: "all", projectKey: "WEB", statuses: ["planning", "review"], limit: 5 }],
    ]);
    const parsed = JSON.parse(text(r));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ key: "TEST-2", title: "one", status: "planning", agentReview: "pending", project: "TEST" });
    expect(parsed[0].spec).toBeUndefined();
  });

  test("list_tickets rejects unknown statuses and scopes before calling ops", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    const badStatus = await tool("list_tickets").execute({ status: ["archived"] } as any, ctx);
    const badScope = await tool("list_tickets").execute({ scope: "everything" } as any, ctx);
    const badLimit = await tool("list_tickets").execute({ limit: 0 }, ctx);
    for (const r of [badStatus, badScope, badLimit]) expect(r.isError).toBe(true);
    expect(text(badStatus)).toContain('"status[0]" must be one of');
    expect(ops.calls).toEqual([]);
  });

  test("list_tickets says so when the page was capped", async () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ ...fakeTicket({ key: `WEB-${i}` }), projectKey: "WEB" }));
    const ops = fakeOps({ listTickets: async () => ({ tickets: many, total: 120, scope: "project" }) });
    const out = text(await tool("list_tickets").execute({ limit: 3 }, fakeContext({ ops })));
    expect(out.split("\n")[0]).toBe("Showing 3 of 120 tickets. Narrow with status or project_key, raise limit, or use search_tickets.");
    expect(JSON.parse(out.split("\n").slice(1).join("\n"))).toHaveLength(3);
    const empty = fakeOps({ listTickets: async () => ({ tickets: [], total: 0, scope: "all" }) });
    expect(text(await tool("list_tickets").execute({ status: ["blocked"] }, fakeContext({ ops: empty })))).toBe('No tickets match (scope "all", status blocked).');
  });

  test("get_ticket includes spec and its revisions, parent, driver, Activity and attachments; transcript only when asked", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", spec: "the brief" }, ctx);
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "TEST-2" }, ctx)));
    expect(r).toMatchObject({ key: "TEST-2", project: "TEST", spec: "the brief", specRevision: 1, specBaselineRevision: 1, parent: "TEST-1", driver: "dummy", model: null });
    expect(r.activity).toEqual([{ kind: "note", author: "agent", body: "did it", meta: {}, createdAt: 1 }]);
    expect(r.attachments).toEqual([]);
    expect(r.description).toBeUndefined();
    expect(r.summaries).toBeUndefined();
    expect(r.transcript).toBeUndefined();
    await tool("get_ticket").execute({ key: "TEST-2", include_transcript: 5 }, ctx);
    expect(ops.calls.filter((c) => c.method === "getTicket").map((c) => c.args)).toEqual([
      ["TEST-2", undefined],
      ["TEST-2", { transcript: 5 }],
    ]);
    const tooMany = await tool("get_ticket").execute({ key: "TEST-2", include_transcript: 51 }, ctx);
    expect(tooMany.isError).toBe(true);
  });

  test("get_ticket reports an alias it resolved through", async () => {
    const ops = fakeOps({
      getTicket: async () => ({
        ticket: { ...fakeTicket({ key: "NEW-1", branch: "medl-1223-ai-app", requestedBranch: "medl-1223-ai-app" }), projectKey: "NEW" },
        resolvedFrom: "OLD-1",
        relatedTickets: [],
        parent: null,
        children: [],
        base: { branch: "develop", source: "project" },
        specRevision: 1,
        specBaselineRevision: null,
        activity: [],
        attachments: [],
      }),
    });
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "OLD-1" }, fakeContext({ ops }))));
    expect(r).toMatchObject({ key: "NEW-1", resolvedFrom: "OLD-1" });
    // The branches a client or agent needs: the worktree's, the chosen one, the override and what it merges into.
    expect(r).toMatchObject({ branch: "medl-1223-ai-app", requestedBranch: "medl-1223-ai-app", baseBranch: null, effectiveBaseBranch: "develop", baseBranchSource: "project" });
  });

  test("get_ticket lists related tickets and the ticket's remote ID", async () => {
    const ops = fakeOps({
      getTicket: async () => ({
        ticket: { ...fakeTicket({ key: "MH-124", externalRef: { source: "jira", key: "MH-62", url: "https://jira/MH-62", raw: null } }), projectKey: "MH" },
        resolvedFrom: null,
        relatedTickets: [{ key: "MH-130", title: "Stage 2", status: "planning", projectId: "p_1", projectKey: "MH", externalKey: "MH-62" }],
        parent: null,
        children: [],
        base: { branch: "main", source: "settings" },
        specRevision: 1,
        specBaselineRevision: null,
        activity: [],
        attachments: [],
      }),
    });
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "MH-124" }, fakeContext({ ops }))));
    expect(r).toMatchObject({ key: "MH-124", externalKey: "MH-62", externalUrl: "https://jira/MH-62" });
    expect(r.relatedTickets).toEqual([{ key: "MH-130", title: "Stage 2", status: "planning", project: "MH", externalKey: "MH-62" }]);
  });

  test("get_ticket for a remote-only key returns ticket null with the linked tickets, not an error", async () => {
    const matches = {
      ticket: null,
      requested: "JIRA-9",
      relatedTickets: [{ key: "MH-5", title: "One", status: "done" as const, projectId: "p_1", projectKey: "MH", externalKey: "JIRA-9" }],
    };
    const ops = fakeOps({
      getTicket: async () => {
        throw new RemoteIdError("JIRA-9 is a remote ID", matches);
      },
    });
    const r = await tool("get_ticket").execute({ key: "JIRA-9" }, fakeContext({ ops }));
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({
      ticket: null,
      requested: "JIRA-9",
      relatedTickets: [{ key: "MH-5", title: "One", status: "done", project: "MH", externalKey: "JIRA-9" }],
    });
    // Any other failure is still an error.
    const unknown = fakeOps({
      getTicket: async () => {
        throw new Error("Unknown ticket: NOPE-1");
      },
    });
    await expect(tool("get_ticket").execute({ key: "NOPE-1" }, fakeContext({ ops: unknown }))).rejects.toThrow("Unknown ticket: NOPE-1");
  });

  test("search_tickets maps inputs and returns compact hits with nextCursor", async () => {
    const hit = { ticket: { ...fakeTicket({ key: "WEB-3", title: "Nav", status: "done", spec: "long brief" }), projectKey: "WEB" }, snippet: "…the nav…" };
    const ops = fakeOps({ searchTickets: async () => ({ hits: [hit], nextCursor: "abc", total: 7 }) });
    const ctx = fakeContext({ ops, runKind: "triage", ticket: null });
    const r = JSON.parse(text(await tool("search_tickets").execute({ query: "nav", project_key: "WEB", limit: 1, cursor: "prev" }, ctx)));
    expect(ops.calls).toEqual([{ method: "searchTickets", args: [{ query: "nav", projectKey: "WEB", limit: 1, cursor: "prev" }] }]);
    expect(r).toEqual({ total: 7, hits: [{ key: "WEB-3", title: "Nav", status: "done", project: "WEB", snippet: "…the nav…" }], nextCursor: "abc" });
    const none = fakeOps();
    expect(text(await tool("search_tickets").execute({ query: "x", cursor: "c" }, fakeContext({ ops: none })))).toBe("No more matches.");
    const blank = await tool("search_tickets").execute({ query: "  " }, fakeContext({ ops: none }));
    expect(blank.isError).toBe(true);
  });

  test("list_projects", async () => {
    const ops = fakeOps();
    expect(JSON.parse(text(await tool("list_projects").execute({}, fakeContext({ ops }))))).toEqual([{ key: "WEB", name: "Website", path: "/code/web" }]);
    const empty = fakeOps({ listProjects: async () => [] });
    expect(text(await tool("list_projects").execute({}, fakeContext({ ops: empty })))).toBe("No projects are configured.");
  });
});

describe("triage tools → HarnessOps", () => {
  test("dispatch_ticket maps project_key and flags", async () => {
    const ops = fakeOps();
    const r = await tool("dispatch_ticket").execute(
      { project_key: "WEB", key: "FOO-9", title: "Fix nav", spec: "brief", start: true },
      fakeContext({ ops, runKind: "triage", ticket: null }),
    );
    expect(ops.calls).toEqual([
      { method: "dispatchTicket", args: [{ projectKey: "WEB", key: "FOO-9", title: "Fix nav", spec: "brief", start: true, conductor: undefined }] },
    ]);
    expect(text(r)).toContain("Dispatched as FOO-9");
    expect(text(r)).toContain("Stop here");
  });

  test("dispatch_ticket passes ticket_key through and says the update went to that ticket", async () => {
    const ops = fakeOps({
      dispatchTicket: async () => fakeTicket({ key: "WEB-3", externalRef: { source: "jira", key: "FOO-9", url: null, raw: null } }),
    });
    const r = await tool("dispatch_ticket").execute(
      { project_key: "WEB", key: "FOO-9", ticket_key: "WEB-3", title: "Fix nav", spec: "update" },
      fakeContext({ ops, runKind: "triage", ticket: null }),
    );
    expect(ops.calls[0]).toMatchObject({ method: "dispatchTicket", args: [{ projectKey: "WEB", key: "FOO-9", ticketKey: "WEB-3" }] });
    expect(text(r)).toContain("Sent the update to WEB-3");
    expect(text(r)).toContain("remote ID FOO-9");
  });

  test("dispatch_ticket requires project_key", async () => {
    const ops = fakeOps();
    const r = await tool("dispatch_ticket").execute({ title: "x", spec: "y" } as any, fakeContext({ ops }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"project_key" is required');
  });

  test("decline_work", async () => {
    const ops = fakeOps();
    const r = await tool("decline_work").execute({ reason: "no project" }, fakeContext({ ops }));
    expect(ops.calls).toEqual([{ method: "declineWork", args: ["no project"] }]);
    expect(text(r)).toContain("Stop here");
  });
});

describe("wait_for and browser_wait", () => {
  test("a bad wait_for is refused before the tool touches the page", async () => {
    for (const [name, input] of [
      ["browser_click", { selector: "#go", wait_for: { timeout: 5 } }],
      ["browser_type", { selector: "input", text: "x", wait_for: { selector: "#a", bogus: 1 } }],
      ["browser_open", { url: "http://a.test", wait_for: { idle: true, timeout: 500 } }],
      ["browser_screenshot", { wait_for: { url: "/[/" } }],
      ["browser_content", { wait_for: { state: "gone" } }],
      ["browser_eval", { expression: "1", wait_for: { selector: "" } }],
      ["browser_resize", { width: 500, wait_for: { idle: "yes" } }],
    ] as const) {
      const browser = fakeBrowser();
      const r = await tool(name).execute(input, fakeContext({ browser }));
      expect(r.isError).toBe(true);
      expect(text(r)).toStartWith("wait_for: ");
      expect(browser.calls).toEqual([]);
    }
  });

  test("actions wait after acting and reads wait before reading, on the same tab", async () => {
    const browser = fakeBrowser();
    const ctx = fakeContext({ browser });
    const cond = { selector: ".done" };
    await tool("browser_click").execute({ selector: "#go", tab: 2, wait_for: cond }, ctx);
    await tool("browser_screenshot").execute({ tab: 2, wait_for: cond }, ctx);
    expect(browser.calls.filter((c) => c.method !== "state").map((c) => [c.method, c.args.at(-1)])).toEqual([
      ["click", { tab: 2 }],
      ["waitFor", { tab: 2 }],
      ["waitFor", { tab: 2 }],
      ["screenshot", { tab: 2 }],
    ]);
    expect(browser.calls.find((c) => c.method === "waitFor")!.args[1]).toEqual(cond);
  });

  test("browser_screenshot passes full_page or selector through, but not both", async () => {
    const browser = fakeBrowser();
    const ctx = fakeContext({ browser });
    await tool("browser_screenshot").execute({ full_page: true, tab: 2 }, ctx);
    await tool("browser_screenshot").execute({ selector: "#card" }, ctx);
    const both = await tool("browser_screenshot").execute({ full_page: true, selector: "#card" }, ctx);
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("not both");
    expect(browser.calls.filter((c) => c.method === "screenshot").map((c) => c.args.at(-1))).toEqual([
      { tab: 2, fullPage: true },
      { tab: undefined, selector: "#card" },
    ]);
  });

  test("a timed-out wait makes the result an error but keeps what the tool did or read", async () => {
    const timedOut = { met: false, elapsedMs: 15_000, url: "http://a.test/", summary: "Timed out after 15.0s waiting for \".done\" visible." };
    const browser = fakeBrowser({ waitFor: async () => timedOut });
    const ctx = fakeContext({ browser });
    const clicked = await tool("browser_click").execute({ selector: "#go", wait_for: { selector: ".done" } }, ctx);
    expect(clicked.isError).toBe(true);
    expect(text(clicked)).toContain("Clicked #go. Now at http://a.test/");
    expect(text(clicked)).toContain("Timed out after 15.0s");
    const shot = await tool("browser_screenshot").execute({ wait_for: { selector: ".done" } }, ctx);
    expect(shot.isError).toBe(true);
    expect(shot.content.some((c) => c.type === "image")).toBe(true);
  });

  test("browser_wait needs something to wait for, and reports a timeout as an error", async () => {
    expect(text(await tool("browser_wait").execute({ timeout: 3 }, fakeContext()))).toContain("Say what to wait for");
    const browser = fakeBrowser({ waitFor: async () => ({ met: false, elapsedMs: 2000, url: "u", summary: "Timed out after 2.0s waiting for network idle." }) });
    const r = await tool("browser_wait").execute({ idle: true, timeout: 2 }, fakeContext({ browser }));
    expect(r.isError).toBe(true);
    expect(browser.calls.find((c) => c.method === "waitFor")!.args[1]).toEqual({ idle: true, timeout: 2 });
  });

  test("a click on a disabled or busy target says the page may have ignored it", async () => {
    const browser = fakeBrowser({ click: async () => ({ disabled: true, busy: true }) });
    const r = await tool("browser_click").execute({ selector: "#go" }, fakeContext({ browser }));
    expect(text(r)).toContain("It was disabled and inside an element marked aria-busy");
  });

  test("browser_run_status and browser_run_stop refuse a job that doesn't exist", async () => {
    for (const name of ["browser_run_status", "browser_run_stop"]) {
      const r = await tool(name).execute({ job: 999_999 }, fakeContext());
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("No browser_run job 999999 in this session");
    }
  });
});

describe("browser tools → BrowserService", () => {
  test("every browser tool acts on the run's session id", async () => {
    const browser = fakeBrowser();
    const ctx = fakeContext({ browser });
    const opened = await tool("browser_open").execute({ url: "http://localhost:3000" }, ctx);
    expect(text(opened)).toContain("Opened http://localhost:3000 in tab 1");
    expect(text(opened)).toContain("Title of http://localhost:3000");
    await tool("browser_content").execute({}, ctx);
    await tool("browser_content").execute({ selector: "main", format: "html", max_chars: 50 }, ctx);
    await tool("browser_click").execute({ selector: "#go" }, ctx);
    await tool("browser_type").execute({ selector: "input", text: "hi", submit: true }, ctx);
    await tool("browser_type").execute({ selector: "input", text: "hi" }, ctx);
    const ev = await tool("browser_eval").execute({ expression: "6*7" }, ctx);
    expect(text(ev)).toBe("42");
    const shot = await tool("browser_screenshot").execute({}, ctx);
    expect(shot.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);

    const calls = browser.calls.filter((c) => c.method !== "state");
    expect(calls).toEqual([
      { method: "open", args: ["s_1", "http://localhost:3000", { tab: undefined, newTab: false }] },
      { method: "content", args: ["s_1", { selector: undefined, format: "text", maxChars: 20000, tab: undefined }] },
      { method: "content", args: ["s_1", { selector: "main", format: "html", maxChars: 50, tab: undefined }] },
      { method: "click", args: ["s_1", "#go", { tab: undefined }] },
      { method: "type", args: ["s_1", "input", "hi", { submit: true, tab: undefined }] },
      { method: "type", args: ["s_1", "input", "hi", { submit: false, tab: undefined }] },
      { method: "evaluate", args: ["s_1", "6*7", { tab: undefined }] },
      { method: "screenshot", args: ["s_1", { tab: undefined }] },
    ]);
  });

  test("tab and new_tab reach the browser, and the result names the tab", async () => {
    const browser = fakeBrowser();
    const ctx = fakeContext({ browser });
    expect(text(await tool("browser_open").execute({ url: "http://a.test", new_tab: true }, ctx))).toContain("Opened http://a.test in tab 2");
    expect(text(await tool("browser_open").execute({ url: "http://b.test", tab: 3 }, ctx))).toContain("in tab 3");
    await tool("browser_content").execute({ tab: 2 }, ctx);
    await tool("browser_click").execute({ selector: "#go", tab: 2 }, ctx);
    await tool("browser_type").execute({ selector: "input", text: "hi", tab: 2 }, ctx);
    await tool("browser_eval").execute({ expression: "1", tab: 2 }, ctx);
    await tool("browser_screenshot").execute({ tab: 2 }, ctx);
    const calls = browser.calls.filter((c) => c.method !== "state");
    expect(calls.map((c) => c.args.at(-1))).toEqual([
      { tab: undefined, newTab: true },
      { tab: 3, newTab: false },
      { selector: undefined, format: "text", maxChars: 20000, tab: 2 },
      { tab: 2 },
      { submit: false, tab: 2 },
      { tab: 2 },
      { tab: 2 },
    ]);
    // browser_click reports the url of the tab it clicked in
    expect(browser.calls.find((c) => c.method === "state")?.args).toEqual(["s_1", { tab: 2 }]);
  });

  test("browser_open refuses tab together with new_tab, before touching the browser", async () => {
    const browser = fakeBrowser();
    const r = await tool("browser_open").execute({ url: "http://a.test", tab: 1, new_tab: true }, fakeContext({ browser }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not both");
    expect(browser.calls).toEqual([]);
  });

  test("tab must be a whole number from 1", async () => {
    const r = await tool("browser_content").execute({ tab: 0 }, fakeContext());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(">= 1");
  });

  test("browser_tabs and browser_close_tab list what is open", async () => {
    const desktop = { device: "desktop", width: 1280, height: 800, responsive: false };
    const tabs = [
      { id: 1, url: "http://a.test/", title: "A", loading: false, size: { ...desktop, responsive: true }, failedRequests: 0, consoleErrors: 0 },
      { id: 3, url: "http://c.test/", title: "", loading: true, size: { device: "mobile", width: 393, height: 852, responsive: false }, failedRequests: 2, consoleErrors: 1 },
      { id: 4, url: "http://d.test/", title: "D", loading: false, suspended: true, size: { ...desktop, width: 800 } },
    ];
    const browser = fakeBrowser({ tabs: async () => tabs });
    const ctx = fakeContext({ browser });
    const listing =
      "Tab 1: A — http://a.test/ [desktop 1280×800, responsive]\n" +
      "Tab 3: (untitled) — http://c.test/ [mobile 393×852] (loading) (2 failed requests, 1 console error)\n" +
      "Tab 4: D — http://d.test/ [desktop 800×800] (suspended: reloads when you use it)";
    expect(text(await tool("browser_tabs").execute({}, ctx))).toBe(listing);
    const closed = await tool("browser_close_tab").execute({ tab: 2 }, ctx);
    expect(text(closed)).toBe(`Closed tab 2.\nOpen tabs:\n${listing}`);
    expect(browser.calls.find((c) => c.method === "closeTab")?.args).toEqual(["s_1", 2]);
    const none = fakeBrowser({ tabs: async () => [] });
    expect(text(await tool("browser_tabs").execute({}, fakeContext({ browser: none })))).toContain("No tabs are open");
    expect(text(await tool("browser_close_tab").execute({ tab: 1 }, fakeContext({ browser: none })))).toBe("Closed tab 1. No tabs are open.");
  });

  test("browser_tabs with a tab reports it in full, failed requests first", async () => {
    const browser = fakeBrowser({
      tabInfo: async (_s: string, id: number) => ({
        id,
        url: "http://a.test/",
        title: "A",
        loading: false,
        size: { device: "mobile", width: 1024, height: 1366, responsive: true },
        following: true,
        scroll: { x: 0, y: 240 },
        requests: [
          { method: "GET", url: "http://a.test/", type: "Document", status: 200, durationMs: 12 },
          { method: "GET", url: "http://a.test/app.js", type: "Script", status: 404, durationMs: 3 },
          { method: "POST", url: "http://api.test/x", type: "Fetch", failure: "net::ERR_CONNECTION_REFUSED", durationMs: 1 },
          { method: "GET", url: "http://a.test/old", type: "Fetch", failure: "canceled" },
          { method: "GET", url: "http://a.test/slow", type: "XHR" },
        ],
        console: [{ level: "error", text: "boom", source: "http://a.test/app.js:3" }],
      }),
    });
    const out = text(await tool("browser_tabs").execute({ tab: 5 }, fakeContext({ browser })));
    expect(browser.calls.map((c) => c.method)).toEqual(["tabInfo"]);
    expect(browser.calls[0]?.args).toEqual(["s_1", 5]);
    expect(out).toBe(
      [
        "Tab 5: A — http://a.test/",
        "State: loaded",
        "Size: mobile 1024×1366 (touch, iPhone user agent), following a human's pane (Responsive): it changes when they resize their window; browser_resize sets a size that holds still",
        "Scroll: 0, 240",
        "",
        "Network requests since the page loaded (5; failed ones first):",
        "  GET http://a.test/app.js Script 404 3 ms",
        "  POST http://api.test/x Fetch net::ERR_CONNECTION_REFUSED 1 ms",
        "  GET http://a.test/ Document 200 12 ms",
        "  GET http://a.test/old Fetch canceled",
        "  GET http://a.test/slow XHR pending",
        "",
        "Console errors and warnings (1):",
        "  error: boom (http://a.test/app.js:3)",
      ].join("\n"),
    );
    const suspended = fakeBrowser({
      tabInfo: async () => ({ id: 2, url: "http://b.test/", title: "B", loading: false, suspended: true, size: { device: "desktop", width: 1280, height: 800, responsive: true }, following: false, requests: [], console: [] }),
    });
    expect(text(await tool("browser_tabs").execute({ tab: 2 }, fakeContext({ browser: suspended })))).toBe(
      "Tab 2: B — http://b.test/\nState: suspended (its page is closed; it reloads when you use it)\nSize: desktop 1280×800 (mouse), Responsive: it takes the size of the next human pane that opens it; browser_resize sets a size that holds still",
    );
    const missing = fakeBrowser({ tabInfo: async () => { throw new Error("No browser tab 9. Open tabs: 1."); } });
    // Thrown like every browser tool's errors; the tool layer reports it to the agent.
    await expect(tool("browser_tabs").execute({ tab: 9 }, fakeContext({ browser: missing }))).rejects.toThrow("No browser tab 9");
  });

  test("browser_open and browser_resize pass device, width and height through; resize needs one of them", async () => {
    const browser = fakeBrowser({
      resize: async (sessionId: string, change: { device?: string; width?: number }, opts: { tab?: number }) => ({
        sessionId,
        tabId: opts.tab ?? 1,
        url: "http://a.test/",
        title: "A",
        loading: false,
        size: { device: change.device ?? "desktop", width: change.width ?? 393, height: 852, responsive: false },
      }),
    });
    const ctx = fakeContext({ browser });
    await tool("browser_open").execute({ url: "http://a.test", new_tab: true, device: "mobile" }, ctx);
    await tool("browser_open").execute({ url: "http://a.test", tab: 2 }, ctx);
    expect(text(await tool("browser_resize").execute({ device: "mobile", tab: 2 }, ctx))).toBe("Tab 2 is mobile 393×852 (reloaded): http://a.test/");
    expect(text(await tool("browser_resize").execute({ width: 1024 }, ctx))).toBe("Tab 1 is desktop 1024×852: http://a.test/");
    const r = await tool("browser_resize").execute({ tab: 2 }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("device, width or height");
    expect((await tool("browser_resize").execute({ width: 50 }, ctx)).isError).toBe(true);
    expect((await tool("browser_resize").execute({ device: "tablet" }, ctx)).isError).toBe(true);
    expect(browser.calls.filter((c) => c.method !== "state").map((c) => [c.method, ...c.args.slice(1)])).toEqual([
      ["open", "http://a.test", { tab: undefined, newTab: true, size: { device: "mobile", width: undefined, height: undefined } }],
      ["open", "http://a.test", { tab: 2, newTab: false }],
      ["resize", { device: "mobile", width: undefined, height: undefined }, { tab: 2 }],
      ["resize", { device: undefined, width: 1024, height: undefined }, { tab: undefined }],
    ]);
  });

  describe("browser_screenshot save_to", () => {
    const SHOT = Buffer.from("iVBORw0KGgo=", "base64"); // the fake browser's PNG signature bytes
    function setup(readOnly = false) {
      // realpath: macOS temp dirs live behind the /var → /private/var symlink
      const cwd = realpathSync(tempDir("harness-shot-"));
      const scratchDir = join(realpathSync(tempDir("harness-scratch-")), "s_1");
      const browser = fakeBrowser();
      const ctx = fakeContext({ browser, cwd, ops: fakeOps({ fileOutputScope: () => ({ scratchDir, readOnly }) }) });
      const shoot = (save_to: string) => tool("browser_screenshot").execute({ save_to }, ctx);
      return { cwd, scratchDir, browser, shoot };
    }

    test("a relative path writes under the working directory, creating folders, and says where", async () => {
      const { cwd, shoot } = setup();
      const r = await shoot("shots/deep/after.png");
      const saved = join(cwd, "shots/deep/after.png");
      expect(readFileSync(saved)).toEqual(SHOT);
      expect(r.content).toEqual([
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        { type: "text", text: `Saved the screenshot to ${saved}` }, // no scratch-folder note in the cwd
      ]);
      // an existing PNG is replaced
      expect(text(await shoot("shots/deep/after.png"))).toContain(`Saved the screenshot to ${saved}`);
    });

    test("an absolute path in the scratch folder works; one outside both roots is refused before the shot", async () => {
      const { scratchDir, browser, shoot } = setup();
      expect(text(await shoot(join(scratchDir, "a.png")))).toContain(`Saved the screenshot to ${join(scratchDir, "a.png")}`);
      const outside = join(tempDir("harness-elsewhere-"), "x.png");
      await expect(shoot(outside)).rejects.toThrow("save_to must be inside your working directory");
      await expect(shoot("../escape.png")).rejects.toThrow("save_to must be inside your working directory");
      expect(existsSync(outside)).toBe(false);
      expect(browser.calls.filter((c) => c.method === "screenshot")).toHaveLength(1);
    });

    test("a symlink inside the working directory can't lead out of it", async () => {
      const { cwd, shoot } = setup();
      const outside = tempDir("harness-elsewhere-");
      symlinkSync(outside, join(cwd, "link"));
      await expect(shoot("link/x.png")).rejects.toThrow("save_to must be inside your working directory");
      expect(existsSync(join(outside, "x.png"))).toBe(false);
      symlinkSync(join(outside, "nothing-here.png"), join(cwd, "dangling.png"));
      await expect(shoot("dangling.png")).rejects.toThrow("is a symlink that points nowhere");
      expect(existsSync(join(outside, "nothing-here.png"))).toBe(false);
    });

    test("an existing file that isn't a PNG is never overwritten", async () => {
      const { cwd, shoot } = setup();
      writeFileSync(join(cwd, "notes.png"), "my notes");
      await expect(shoot("notes.png")).rejects.toThrow("a file that isn't a PNG is already there");
      expect(readFileSync(join(cwd, "notes.png"), "utf8")).toBe("my notes");
      mkdirSync(join(cwd, "folder.png"));
      await expect(shoot("folder.png")).rejects.toThrow("it is a folder");
    });

    test("read-only: a relative path lands in the scratch folder, and the working directory is refused", async () => {
      const { cwd, scratchDir, shoot } = setup(true);
      const r = await shoot("shot.png");
      expect(text(r)).toContain(`Saved the screenshot to ${join(scratchDir, "shot.png")} (this run's scratch folder)`);
      expect(readFileSync(join(scratchDir, "shot.png"))).toEqual(SHOT);
      expect(existsSync(join(cwd, "shot.png"))).toBe(false);
      await expect(shoot(join(cwd, "shot.png"))).rejects.toThrow("this run is read-only, so screenshots go in its scratch folder");
      expect(existsSync(join(cwd, "shot.png"))).toBe(false);
    });
  });

  test("browser_content validates format and max_chars", async () => {
    const browser = fakeBrowser();
    const ctx = fakeContext({ browser });
    const badFormat = await tool("browser_content").execute({ format: "pdf" } as any, ctx);
    const badMax = await tool("browser_content").execute({ max_chars: 0 }, ctx);
    const fractional = await tool("browser_content").execute({ max_chars: 1.5 }, ctx);
    for (const r of [badFormat, badMax, fractional]) expect(r.isError).toBe(true);
    expect(browser.calls).toEqual([]);
  });

  test("browser errors (e.g. selector matches nothing) propagate", async () => {
    const browser = fakeBrowser({ content: async () => { throw new Error("No element matches .missing"); } });
    await expect(tool("browser_content").execute({ selector: ".missing" }, fakeContext({ browser }))).rejects.toThrow("No element matches");
  });
});

describe("list_watchers", () => {
  test("shows a watcher's triage prompt when it has one, and hides env values", async () => {
    const base = { args: ["-lc", "watch-jira --once"], cwd: null, mode: "interval", intervalSec: 600, enabled: true, driver: null, lastRunAt: null, lastError: null, createdAt: 0, updatedAt: 0 };
    const ops = fakeOps({
      listWatchers: async () => [
        { ...base, id: "w_1", name: "jira", command: "/bin/zsh", env: { JIRA_TOKEN: "tok-secret" }, prompt: "Dispatch new PLAYR tickets." },
        { ...base, id: "w_2", name: "plain", command: "/bin/zsh", env: {}, prompt: "" },
      ],
    });
    const out = text(await tool("list_watchers").execute({}, fakeContext({ ops })));
    expect(out).not.toContain("tok-secret");
    const [withPrompt, without] = JSON.parse(out);
    expect(withPrompt).toMatchObject({ prompt: "Dispatch new PLAYR tickets.", command_line: "watch-jira --once", env: { JIRA_TOKEN: "(set)" } });
    expect("prompt" in without).toBe(false);
  });
});

describe("watcher approval headline", () => {
  /** The card summary a gated watcher call puts in front of the human. */
  async function headline(name: string, input: Record<string, unknown>): Promise<string> {
    let summary = "";
    const ops = fakeOps({
      requestApproval: async (_ctx, _tool, i, meta) => ((summary = meta?.summary ?? ""), { behavior: "allow", updatedInput: i }),
      updateWatcher: async () => ({ id: "w_1", name: "events", command: "x", args: [], env: {}, prompt: "", cwd: null, mode: "loop", intervalSec: 60, enabled: true, driver: null, lastRunAt: null, lastError: null, createdAt: 0, updatedAt: 0 }),
    });
    await tool(name).execute(input, fakeContext({ ops }));
    return summary;
  }

  test("create_watcher names env keys (sorted) and a set cwd, never values", async () => {
    const s = await headline("create_watcher", { name: "events", command: "poll-events", env: { ZDOTDIR: "/tmp/zd", EVENTS_TOKEN: "s3cret" }, cwd: "~/work" });
    expect(s).toBe('Create watcher "events" (loop): poll-events; env: EVENTS_TOKEN, ZDOTDIR; cwd: ~/work');
    expect(s).not.toContain("s3cret");
    expect(s).not.toContain("/tmp/zd");
  });

  test("create_watcher without env or cwd adds neither segment", async () => {
    expect(await headline("create_watcher", { name: "events", command: "poll-events", env: {}, cwd: "" })).toBe('Create watcher "events" (loop): poll-events');
  });

  test("update_watcher separates keys set from keys removed, hides values, and says when cwd is cleared", async () => {
    const s = await headline("update_watcher", { watcher: "events", env: { ZDOTDIR: "/tmp/zd", OLD_TOKEN: "" }, cwd: "" });
    expect(s).toBe('Update watcher "events": env: set ZDOTDIR; removes OLD_TOKEN; cwd: service default');
    expect(s).not.toContain("/tmp/zd");
    expect(await headline("update_watcher", { watcher: "events", enabled: false, cwd: "/srv" })).toBe('Update watcher "events": enabled=false; cwd: /srv');
  });
});
