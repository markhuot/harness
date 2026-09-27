import { describe, expect, test } from "bun:test";
import { fakeBrowser, fakeContext, fakeOps } from "./fakes";
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
    expect(props("create_ticket")).toEqual(["auto_start", "depends_on", "description", "title"]);
    expect(props("dispatch_ticket")).toEqual(["conductor", "description", "key", "project_key", "start", "title"]);
    expect(props("browser_content")).toEqual(["format", "max_chars", "selector"]);
    expect(props("browser_type")).toEqual(["selector", "submit", "text"]);
    expect(props("edit_file")).toEqual(["new_string", "old_string", "path", "replace_all"]);
    expect(props("bash")).toEqual(["command", "timeout_ms"]);
    expect(props("review_decision")).toEqual(["decision", "notes"]);
    expect(props("complete_ticket")).toEqual(["instructions", "key"]);
  });
});

describe("ticket tools → HarnessOps", () => {
  test("post_summary", async () => {
    const ops = fakeOps();
    const r = await tool("post_summary").execute({ summary: "did X" }, fakeContext({ ops }));
    expect(r.isError).toBeUndefined();
    expect(ops.calls).toEqual([{ method: "postSummary", args: ["did X"] }]);
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

  test("list_tickets defaults to children scope and returns JSON the model (and dummy) can parse", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    expect(text(await tool("list_tickets").execute({}, ctx))).toContain("no child tickets");
    await tool("create_ticket").execute({ title: "one", description: "d" }, ctx);
    const r = await tool("list_tickets").execute({ scope: "project" }, ctx);
    expect(ops.calls.filter((c) => c.method === "listTickets").map((c) => c.args)).toEqual([["children"], ["project"]]);
    const parsed = JSON.parse(text(r));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ key: "TEST-2", title: "one", status: "planning", agentReview: "pending" });
    expect(parsed[0].description).toBeUndefined();
  });

  test("get_ticket includes description and summaries", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    await tool("create_ticket").execute({ title: "one", description: "the brief" }, ctx);
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "TEST-2" }, ctx)));
    expect(r.description).toBe("the brief");
    expect(r.summaries[0].body).toBe("did it");
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

  test("list_projects and decline_work", async () => {
    const ops = fakeOps();
    const ctx = fakeContext({ ops });
    expect(JSON.parse(text(await tool("list_projects").execute({}, ctx)))).toEqual([{ key: "WEB", name: "Website", path: "/code/web" }]);
    await tool("decline_work").execute({ reason: "no project" }, ctx);
    expect(ops.calls.map((c) => c.method)).toEqual(["listProjects", "declineWork"]);
    const empty = fakeOps({ listProjects: async () => [] });
    expect(text(await tool("list_projects").execute({}, fakeContext({ ops: empty })))).toBe("No projects are configured.");
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
