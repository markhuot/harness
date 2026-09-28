import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { fakeBrowser, fakeContext, fakeOps, fakeTicket } from "./fakes";
import { allTools } from "./index";
import type { ToolResult } from "./types";

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
    expect(props("create_ticket")).toEqual(["auto_start", "conductor", "depends_on", "description", "driver", "model", "project_key", "start", "title", "use_worktree"]);
    expect(props("update_ticket")).toEqual(["depends_on", "description", "driver", "key", "model", "permission_mode", "title"]);
    expect(props("move_ticket")).toEqual(["key", "position", "status"]);
    expect(props("cancel_ticket")).toEqual(["key"]);
    expect(props("reopen_ticket")).toEqual(["key", "notes"]);
    expect(props("dispatch_ticket")).toEqual(["conductor", "description", "key", "project_key", "start", "title", "url"]);
    expect(props("decline_work")).toEqual(["reason", "title"]);
    expect(props("browser_content")).toEqual(["format", "max_chars", "selector"]);
    expect(props("browser_type")).toEqual(["selector", "submit", "text"]);
    expect(props("edit_file")).toEqual(["new_string", "old_string", "path", "replace_all"]);
    expect(props("bash")).toEqual(["command", "timeout_ms"]);
    expect(props("review_decision")).toEqual(["decision", "notes"]);
    expect(props("complete_ticket")).toEqual(["instructions", "key"]);
    expect(props("list_tickets")).toEqual(["limit", "project_key", "scope", "status"]);
    expect(props("get_ticket")).toEqual(["include_transcript", "key"]);
    expect(props("search_tickets")).toEqual(["cursor", "limit", "project_key", "query"]);
  });
});

describe("ticket tools → HarnessOps", () => {
  test("post_summary", async () => {
    const ops = fakeOps();
    const r = await tool("post_summary").execute({ summary: "did X" }, fakeContext({ ops }));
    expect(r.isError).toBeUndefined();
    expect(ops.calls).toEqual([{ method: "postSummary", args: ["did X"] }]);
  });

  test("post_summary and submit_for_review pass attachments through and reject a non-list", async () => {
    const ops = fakeOps();
    const posted = await tool("post_summary").execute({ summary: "shots", attachments: ["a.png", "b.mp4"] }, fakeContext({ ops }));
    expect(text(posted)).toBe("Summary posted with 2 attachments.");
    await tool("submit_for_review").execute({ summary: "done", attachments: ["c.png"] }, fakeContext({ ops }));
    expect(ops.calls).toEqual([
      { method: "postSummary", args: ["shots", ["a.png", "b.mp4"]] },
      { method: "submitForReview", args: ["done", ["c.png"]] },
    ]);
    const bad = await tool("post_summary").execute({ summary: "x", attachments: "a.png" } as any, fakeContext({ ops }));
    expect(bad.isError).toBe(true);
    expect(ops.calls).toHaveLength(2);
  });

  test("update_plan passes the optional title through", async () => {
    const ops = fakeOps();
    await tool("update_plan").execute({ plan: "1. a" }, fakeContext({ ops }));
    await tool("update_plan").execute({ plan: "1. b", title: "New" }, fakeContext({ ops }));
    expect(ops.calls).toEqual([
      { method: "updatePlan", args: ["1. a", undefined] },
      { method: "updatePlan", args: ["1. b", "New"] },
    ]);
  });

  test("block and submit_for_review tell the model to stop", async () => {
    const ops = fakeOps();
    const b = await tool("block").execute({ question: "Which DB?" }, fakeContext({ ops }));
    const s = await tool("submit_for_review").execute({ summary: "done" }, fakeContext({ ops }));
    expect(text(b)).toContain("Stop here");
    expect(text(s)).toBe("Ticket moved to review. Stop here.");
    expect(ops.calls.map((c) => [c.method, c.args[0]])).toEqual([
      ["block", "Which DB?"],
      ["submitForReview", "done"],
    ]);
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
    const missing = await tool("post_summary").execute({} as any, ctx);
    const empty = await tool("block").execute({ question: "   " }, ctx);
    const typed = await tool("submit_for_review").execute({ summary: 5 } as any, ctx);
    const nullInput = await tool("post_summary").execute(null as any, ctx);
    for (const r of [missing, empty, typed, nullInput]) expect(r.isError).toBe(true);
    expect(text(missing)).toBe('Invalid input for post_summary: "summary" is required.');
    expect(text(empty)).toContain("must not be empty");
    expect(text(typed)).toContain('"summary" must be a string');
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
      { title: "Docs", description: "Write docs", project_key: "WEB", start: true, conductor: true, driver: "claude-code", model: " " },
      fakeContext({ ops }),
    );
    expect(ops.calls[0]!.args[0]).toEqual({
      title: "Docs",
      description: "Write docs",
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
    await tool("create_ticket").execute({ title: "one", description: "d" }, ctx);
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
    await tool("create_ticket").execute({ title: "one", description: "d" }, ctx);
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
      { title: "API", description: "Build the API", depends_on: ["TEST-7"], auto_start: false },
      fakeContext({ ops }),
    );
    expect(ops.calls[0]).toEqual({
      method: "createTicket",
      args: [{ title: "API", description: "Build the API", dependsOn: ["TEST-7"], autoStart: false }],
    });
    expect(text(r)).toStartWith("Created TEST-2.");
    expect(JSON.parse(text(r).split("\n").slice(1).join("\n"))).toMatchObject({ key: "TEST-2", dependsOn: ["TEST-7"], autoStart: false });
  });

  test("create_ticket rejects non-string depends_on entries", async () => {
    const ops = fakeOps();
    const r = await tool("create_ticket").execute({ title: "a", description: "b", depends_on: [1] } as any, fakeContext({ ops }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('"depends_on[0]" must be a string');
    expect(ops.calls).toEqual([]);
  });

  test("start/message/review/complete map key and arguments", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", description: "d" }, ctx);
    await tool("start_ticket").execute({ key: "TEST-2" }, ctx);
    await tool("message_ticket").execute({ key: "TEST-2", text: "use postgres" }, ctx);
    const rv = await tool("review_ticket").execute({ key: "TEST-2", decision: "approve", notes: "ok" }, ctx);
    await tool("complete_ticket").execute({ key: "TEST-2", instructions: "merge into main" }, ctx);
    await tool("complete_ticket").execute({ key: "TEST-2" }, ctx);
    expect(ops.calls.slice(1)).toEqual([
      { method: "startTicket", args: ["TEST-2"] },
      { method: "messageTicket", args: ["TEST-2", "use postgres"] },
      { method: "reviewTicket", args: ["TEST-2", "approve", "ok"] },
      { method: "completeTicket", args: ["TEST-2", "merge into main"] },
      { method: "completeTicket", args: ["TEST-2", undefined] },
    ]);
    expect(text(rv)).toContain("human review: approved");
  });
});

describe("board tools → HarnessOps", () => {
  test("list_tickets maps snake_case filters, applies the default limit, and returns parseable JSON without descriptions", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    expect(text(await tool("list_tickets").execute({}, ctx))).toContain("no child tickets");
    await tool("create_ticket").execute({ title: "one", description: "d" }, ctx);
    const r = await tool("list_tickets").execute({ scope: "all", project_key: "WEB", status: ["planning", "review"], limit: 5 }, ctx);
    expect(ops.calls.filter((c) => c.method === "listTickets").map((c) => c.args)).toEqual([
      [{ scope: undefined, projectKey: undefined, statuses: undefined, limit: 50 }],
      [{ scope: "all", projectKey: "WEB", statuses: ["planning", "review"], limit: 5 }],
    ]);
    const parsed = JSON.parse(text(r));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ key: "TEST-2", title: "one", status: "planning", agentReview: "pending", project: "TEST" });
    expect(parsed[0].description).toBeUndefined();
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

  test("get_ticket includes description, parent, driver and summaries; transcript only when asked", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", description: "the brief" }, ctx);
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "TEST-2" }, ctx)));
    expect(r).toMatchObject({ key: "TEST-2", project: "TEST", description: "the brief", parent: "TEST-1", driver: "dummy", model: null });
    expect(r.summaries[0].body).toBe("did it");
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
      getTicket: async () => ({ ticket: { ...fakeTicket({ key: "NEW-1" }), projectKey: "NEW" }, resolvedFrom: "OLD-1", parent: null, children: [], summaries: [] }),
    });
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "OLD-1" }, fakeContext({ ops }))));
    expect(r).toMatchObject({ key: "NEW-1", resolvedFrom: "OLD-1" });
  });

  test("search_tickets maps inputs and returns compact hits with nextCursor", async () => {
    const hit = { ticket: { ...fakeTicket({ key: "WEB-3", title: "Nav", status: "done", description: "long brief" }), projectKey: "WEB" }, snippet: "…the nav…" };
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
      { project_key: "WEB", key: "FOO-9", title: "Fix nav", description: "brief", start: true },
      fakeContext({ ops, runKind: "triage", ticket: null }),
    );
    expect(ops.calls).toEqual([
      { method: "dispatchTicket", args: [{ projectKey: "WEB", key: "FOO-9", title: "Fix nav", description: "brief", start: true, conductor: undefined }] },
    ]);
    expect(text(r)).toContain("Dispatched as FOO-9");
    expect(text(r)).toContain("Stop here");
  });

  test("dispatch_ticket requires project_key", async () => {
    const ops = fakeOps();
    const r = await tool("dispatch_ticket").execute({ title: "x", description: "y" } as any, fakeContext({ ops }));
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

describe("browser tools → BrowserService", () => {
  test("every browser tool acts on the run's session id", async () => {
    const browser = fakeBrowser();
    const ctx = fakeContext({ browser });
    const opened = await tool("browser_open").execute({ url: "http://localhost:3000" }, ctx);
    expect(text(opened)).toContain("Opened http://localhost:3000");
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
      { method: "open", args: ["s_1", "http://localhost:3000"] },
      { method: "content", args: ["s_1", { selector: undefined, format: "text", maxChars: 20000 }] },
      { method: "content", args: ["s_1", { selector: "main", format: "html", maxChars: 50 }] },
      { method: "click", args: ["s_1", "#go"] },
      { method: "type", args: ["s_1", "input", "hi", { submit: true }] },
      { method: "type", args: ["s_1", "input", "hi", { submit: false }] },
      { method: "evaluate", args: ["s_1", "6*7"] },
      { method: "screenshot", args: ["s_1"] },
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
