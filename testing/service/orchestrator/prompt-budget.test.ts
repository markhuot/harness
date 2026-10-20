// Harness's share of an agent run's first request, by run kind: the system prompt section, the run
// context (the <harness_run> block) and the advertised tool view. Tokens are estimated at 3.7
// characters each, which matched the API's counts to within ~10% for this text. The limits sit just
// above today's sizes, so a section that grows has to say so here. `PROMPT_BUDGET=1 bun test
// testing/service/orchestrator/prompt-budget.test.ts` prints the table.
import { expect, test } from "bun:test";
import { advertisedTools } from "../../../service/src/tools/dispatch";
import { toolsForRun } from "../../../service/src/tools";
import { runContext, systemPrompt, type PromptInfo } from "../../../service/src/orchestrator/prompts";
import { addProject, addTicket, makeStore } from "../../builders/store";

const tokens = (chars: number) => Math.round(chars / 3.7);

function measure(kind: "plan" | "work" | "review") {
  const store = makeStore();
  const project = addProject(store);
  const created = addTicket(store, project, { status: kind === "plan" ? "planning" : kind === "work" ? "in_progress" : "review" });
  const ticket = store.tickets.update(created.id, { branch: "harness/test-1", agentNotes: "x".repeat(400) }) ?? created;
  const session = store.sessions.get(ticket.sessionId)!;
  const info: PromptInfo = { kind, project, ticket, session, builtinTools: true, subagentTool: "Claude Code's `Agent` tool", activity: [] };
  const view = advertisedTools(toolsForRun(kind, { hasBuiltinTools: true, usesPermissionPromptTool: true }, ticket));
  return {
    system: tokens(systemPrompt(info).length),
    run: tokens(runContext(info).length),
    tools: tokens(JSON.stringify(view.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))).length),
  };
}

const LIMITS = {
  plan: { system: 1500, run: 2200, tools: 2550 },
  work: { system: 2500, run: 3100, tools: 3900 },
  review: { system: 1300, run: 1100, tools: 2250 },
};

for (const kind of ["plan", "work", "review"] as const) {
  test(`${kind} runs keep Harness's first-request share under its limit`, () => {
    const m = measure(kind);
    if (process.env.PROMPT_BUDGET) console.log(`${kind}: system ${m.system}, run ${m.run}, tools ${m.tools}, total ${m.system + m.run + m.tools} (estimated tokens)`);
    expect(m.system).toBeLessThanOrEqual(LIMITS[kind].system);
    expect(m.run).toBeLessThanOrEqual(LIMITS[kind].run);
    expect(m.tools).toBeLessThanOrEqual(LIMITS[kind].tools);
  });
}

// Trimming must not drop a rule an agent acts on: each one stays in the prompt of the run kinds that need it.
function prompts(kind: "plan" | "work" | "review") {
  const store = makeStore();
  const project = addProject(store);
  const created = addTicket(store, project, { status: kind === "plan" ? "planning" : "in_progress" });
  const ticket = store.tickets.update(created.id, { branch: "harness/test-1" }) ?? created;
  const info: PromptInfo = { kind, project, ticket, session: store.sessions.get(ticket.sessionId)!, builtinTools: true };
  const view = advertisedTools(toolsForRun(kind, { hasBuiltinTools: true, usesPermissionPromptTool: false }, ticket));
  return { text: `${systemPrompt(info)}\n${runContext(info)}`, tool: (name: string) => view.find((t) => t.name === name)! };
}

test("work runs still read the spec, Activity, notes and ending rules, and the tools carry the Activity-line rules", () => {
  const { text, tool } = prompts("work");
  for (const rule of ["Write it like a product requirements doc", "![Settings", "I changed X because Y", "`post_note` has the rules", "`update_notes` { notes }", "Write them before you submit for review or block", "`submit_for_review` { note, spec_is_up_to_date }", "call `unblock` first"]) expect(text).toContain(rule);
  expect(tool("post_note").description).toContain("MUST say what happened on its own");
  expect(tool("edit_spec").description).toContain("attachment:<id>");
  expect(tool("update_notes").description).toContain("rewrite it to stay current");
  expect(tool("submit_for_review").description).toContain("MUST stand on its own");
});

test("plan runs write the first full spec and their notes; review runs only add to Open questions", () => {
  const plan = prompts("plan").text;
  expect(plan).toContain("use it to write the first full spec");
  expect(plan).toContain("Write them before you end the planning run");
  const review = prompts("review").text;
  expect(review).toContain("Open questions");
  expect(review).not.toContain("Write it like a product requirements doc");
  expect(review).not.toContain("`update_notes` { notes }");
});
