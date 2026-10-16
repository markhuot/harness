import { expect, test } from "bun:test";
import { PROMPT_IDS, parseTemplate, type ActivityEntry } from "@harness/shared";
import { isPromptId, promptTemplateError, PROMPTS, renderPrompt } from "../../../service/src/orchestrator/prompt-templates";
import { activityLines, changesRequestedPrompt, completePrompt, conductorUpdatePrompt, pullRequestList, reopenPrompt, replanPrompt, reviewPrompt, systemPrompt, workStartPrompt } from "../../../service/src/orchestrator/prompts";
import { makeTicket } from "../../builders/ticket";

test("every prompt id has a definition, and the registry holds nothing else", () => {
  expect(Object.keys(PROMPTS).sort()).toEqual([...PROMPT_IDS].sort());
  expect(isPromptId("run.review")).toBe(true);
  expect(isPromptId("toString")).toBe(false);
  expect(isPromptId("nope")).toBe(false);
});

test("every built-in template is valid for its own variables, so rendering can't hit an unknown one", () => {
  for (const [id, def] of Object.entries(PROMPTS)) {
    expect(promptTemplateError(id as never, def.template), id).toBeNull();
    expect(() => parseTemplate(def.template), id).not.toThrow();
  }
});

test("renderPrompt refuses a call that leaves a declared variable out", () => {
  expect(() => renderPrompt("run.changes_requested", { notes: "x" })).toThrow(/missing variable/);
});

test("a valid override replaces the built-in, a blank or null one doesn't, and an invalid one falls back to the built-in", () => {
  const vars = { notes: "fix it", byAgent: false, byHuman: true, byConductor: false, specRevision: "3" };
  const builtin = renderPrompt("run.changes_requested", vars);
  expect(renderPrompt("run.changes_requested", vars, { "run.changes_requested": "Redo: {{notes}} @{{specRevision}}" })).toBe("Redo: fix it @3");
  expect(renderPrompt("run.changes_requested", vars, { "run.changes_requested": null })).toBe(builtin);
  expect(renderPrompt("run.changes_requested", vars, { "run.changes_requested": "" })).toBe(builtin);
  const bad = "Uses {{notAVariable}}";
  expect(promptTemplateError("run.changes_requested", bad)).toMatch(/notAVariable/);
  expect(renderPrompt("run.changes_requested", vars, { "run.changes_requested": bad })).toBe(builtin);
});

test("conditionals in an override follow the variables", () => {
  const t = "{{#if byHuman}}Human said: {{notes}}{{else}}Someone else{{/if}}";
  const o = { "run.changes_requested": t };
  expect(changesRequestedPrompt("go on", "human", 1, o)).toBe("Human said: go on");
  expect(changesRequestedPrompt("go on", "agent", 1, o)).toBe("Someone else");
});

const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({ id: "a", sessionId: "s", ticketId: "t", kind: "note", author: "agent", body: "b", meta: {}, createdAt: 0, ...over });

test("activityLines puts each entry on one line with kind and author, and clips long bodies", () => {
  expect(activityLines([entry({ body: "first\nsecond  line" })])).toBe("* note, agent: first second line");
  const clipped = activityLines([entry({ body: "x".repeat(50) })], 10);
  expect(clipped).toBe(`* note, agent: ${"x".repeat(9)}…`);
});

test("a review entry shows its round and the commit it judged; a permission entry shows what was denied", () => {
  const lines = activityLines([
    entry({ kind: "review_approved", meta: { round: 2, commit: "abcdef1234567890" } }),
    entry({ kind: "changes_requested", meta: {} }),
    entry({ kind: "permission", body: "summary", meta: { detail: "denied Bash(rm)" } }),
  ]);
  expect(lines.split("\n")).toEqual(["* review_approved (round 2, commit abcdef123456), agent: b", "* changes_requested (round ?), agent: b", "* permission, agent: denied Bash(rm)"]);
});

test("pullRequestList quotes titles as data, one line each and cut short", () => {
  expect(pullRequestList([])).toBe("");
  const out = pullRequestList([{ url: "https://x/1", title: null }, { url: "https://x/2", title: 'Fix\nthe "bug"' }, { url: "https://x/3", title: "t".repeat(200) }]);
  const [a, b, c] = out.split("\n");
  expect(a).toBe("- https://x/1");
  expect(b).toBe('- https://x/2 (title: "Fix the \\"bug\\"")');
  expect(c).toBe(`- https://x/3 (title: "${"t".repeat(120)}")`);
});

test("the work brief carries the ticket label, spec and revision; an empty spec says the title is the spec", () => {
  const t = makeTicket({ status: "planning", key: "ACME-7", title: "Add dark mode", spec: "  Make it dark  ", specRevision: 4 });
  const brief = workStartPrompt(t);
  expect(brief).toContain('ACME-7 "Add dark mode"');
  expect(brief).toContain("Make it dark");
  expect(workStartPrompt({ ...t, spec: " " })).toContain("the spec is empty; the title is the whole spec");
  expect(workStartPrompt({ ...t, kind: "conductor" })).not.toBe(brief);
});

test("the review prompt names the revisions to read, and a re-review lists the earlier rounds", () => {
  const t = makeTicket({ status: "review", key: "ACME-1", spec: "s", specRevision: 3 });
  const first = reviewPrompt(t, { baselineRevision: 1, earlier: [], round: 1, activity: [] });
  expect(first).toContain("revision 3");
  expect(first).toContain("The human approved revision 1");
  const again = reviewPrompt(t, { baselineRevision: 3, earlier: [{ round: 1, decision: "request_changes", commit: "abc123", notes: "Fix the label" }], round: 2, activity: [] });
  expect(again).toContain("round 2");
  expect(again).toContain("Round 1: changes requested at commit abc123");
  expect(again).toContain("Fix the label");
});

test("the completion prompt follows the ticket's completion action", () => {
  const base = makeTicket({ status: "review", key: "ACME-1", branch: "harness/acme-1" });
  const prompts = (["merge", "pr", "cleanup", "custom"] as const).map((completionAction) => completePrompt({ ...base, completionAction }, "ship it"));
  expect(new Set(prompts).size).toBe(4);
  for (const p of prompts) expect(p).toContain("ship it");
  expect(prompts[1]).toMatch(/pull request/i);
});

test("a conductor's update numbers each child change with its note indented under it", () => {
  const out = conductorUpdatePrompt([
    { key: "A-1", title: "One", from: "in_progress", to: "review", note: "line1\nline2", specRevision: 2 },
    { key: "A-2", title: "Two", from: "review", to: "done" },
  ]);
  expect(out).toContain('1. A-1 "One": in_progress → review (spec revision 2)\n   Note: line1\n   line2');
  expect(out).toContain('2. A-2 "Two": review → done');
});

test("reopen and replan prompts carry the human's words and the ticket's context", () => {
  const t = makeTicket({ status: "done", key: "ACME-1", branch: "harness/acme-1", pullRequests: [{ url: "https://x/1", title: null }] });
  const reopen = reopenPrompt(t, "  one more thing ", "main");
  expect(reopen).toContain("one more thing");
  expect(reopen).toContain("https://x/1");
  expect(replanPrompt(t, " too big ", " the human said so ", true)).toContain("too big");
  expect(replanPrompt(t, "r", "h", true)).not.toBe(replanPrompt(t, "r", "h", false));
});

test("the system prompt for a work run mentions the tools a work run has; a triage run's doesn't mention submitting", () => {
  const session = { key: "ACME-1", title: "t", cwd: "/p" };
  const ticket = makeTicket({ status: "in_progress", key: "ACME-1" });
  const work = systemPrompt({ kind: "work", ticket, project: null, session } as never);
  const triage = systemPrompt({ kind: "triage", ticket: null, project: null, session: { ...session, key: "TRIAGE-1" } } as never);
  expect(work).toContain("submit_for_review");
  expect(triage).not.toContain("submit_for_review");
  expect(work.startsWith("You are an autonomous coding agent running inside Harness")).toBe(true);
});
