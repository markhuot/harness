import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { toolCall, type Step } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";
import { pngBytes, writeFile } from "../files";
import { LlmSpecGuard, buildSpecGuardPrompt, changedSections, parseSpecGuardVerdict, specGoal, type SpecGuard, type SpecGuardInput, type SpecGuardVerdict } from "../../../service/src/orchestrator/spec-guard";

afterEach(stopAll);

const SPEC = "# Goal\nShip a changelog page.\n\n# Plan\n1. Build it.\n\n# Status\nNot started.";

/** A guard that records what it was asked and answers with `answer`. */
function fakeGuard(answer: (input: SpecGuardInput) => SpecGuardVerdict | Promise<SpecGuardVerdict>) {
  const calls: SpecGuardInput[] = [];
  const guard: SpecGuard = {
    backend: "fake",
    check: async (input) => {
      calls.push(input);
      return answer(input);
    },
  };
  return { guard, calls };
}
const allow: SpecGuardVerdict = { ok: true, reason: "", quote: "" };

async function agentRun(guard: SpecGuard | null, calls: [name: string, input: unknown][], opts: { timeoutMs?: number; files?: (cwd: string) => void; settings?: Record<string, unknown> } = {}) {
  const h = makeOrchestrator({ tools: undefined, specGuard: guard, specGuardTimeoutMs: opts.timeoutMs });
  if (opts.settings) h.orch.updateSettings(opts.settings as never);
  const results: { text: string; isError: boolean }[] = [];
  const steps: Step[] = calls.flatMap(([name, input]) =>
    toolCall(name, input, (r) => results.push({ text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError })),
  );
  h.driver.script(steps);
  const t = await h.orch.createTicket({ projectId: h.project.id, title: "Changelog page", spec: SPEC, skipAgentReview: true });
  opts.files?.(h.project.path);
  await h.settle();
  return { h, t, results };
}

const edit = (old_string: string, new_string: string) => ["edit_spec", { base_revision: 1, note: "n", edits: [{ old_string, new_string }] }] as [string, unknown];

test("a refusal stores no revision and no attachment files, and quotes the offending line back to the agent", async () => {
  const { guard } = fakeGuard(() => ({ ok: false, reason: "That is a Decisions section.", quote: "## Decisions" }));
  const { h, t, results } = await agentRun(guard, [["update_spec", { base_revision: 1, note: "n", spec: "# Status\n## Decisions\n![x](shots/a.png)" }]], {
    files: (cwd) => void writeFile(cwd, "shots/a.png", pngBytes(10, 20)),
  });
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toContain('Offending line: "## Decisions"');
  expect(results[0]!.text).toContain("still at revision 1");
  expect(h.store.specs.list(t.id)).toHaveLength(1);
  expect(h.ticket(t.key).spec).toBe(SPEC);
  expect(h.store.attachments.listByTicket(t.id)).toEqual([]);
  const dir = (h.orch as unknown as { paths: { attachmentsDir: string } }).paths.attachmentsDir;
  expect(existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => !String(f).endsWith("/")) : []).toEqual([]);
});

test("a refusal is final for that write: asking again with the same text is judged again, never waved through", async () => {
  const { guard, calls } = fakeGuard(() => ({ ok: false, reason: "History.", quote: "Round 2" }));
  const { h, t, results } = await agentRun(guard, [edit("Not started.", "Round 2 fixed it."), edit("Not started.", "Round 2 fixed it."), edit("Not started.", "Round 2 fixed it.")]);
  expect(results.map((r) => r.isError)).toEqual([true, true, true]);
  expect(calls).toHaveLength(3);
  expect(h.store.specs.list(t.id)).toHaveLength(1);
});

test("an allowed write is stored as the next revision", async () => {
  const { guard, calls } = fakeGuard(() => allow);
  const { h, t, results } = await agentRun(guard, [edit("Not started.", "Built.")]);
  expect(results[0]).toEqual({ text: "Spec updated to revision 2.", isError: false });
  expect(h.ticket(t.key).spec).toContain("Built.");
  expect(calls).toHaveLength(1);
});

test("an edit_spec sends the edited section and the added lines, not the whole spec; update_spec sends what the new spec added", async () => {
  const { guard, calls } = fakeGuard(() => allow);
  await agentRun(guard, [edit("1. Build it.", "1. Build it.\n2. Ship it."), ["update_spec", { base_revision: 2, note: "n", spec: "# Goal\nShip a changelog page.\n\n# Plan\nJust ship." }]]);
  expect(calls[0]).toMatchObject({ kind: "edit", ticketTitle: "Changelog page", goal: "Ship a changelog page.", added: "2. Ship it." });
  expect(calls[0]!.text).toBe("# Plan\n1. Build it.\n2. Ship it.\n");
  expect(calls[0]!.text).not.toContain("Not started.");
  expect(calls[1]).toMatchObject({ kind: "replace", text: "# Plan\nJust ship.", added: "Just ship." });
});

test("a checker that errors or never answers lets the write through", async () => {
  const boom = fakeGuard(() => {
    throw new Error("backend down");
  });
  const a = await agentRun(boom.guard, [edit("Not started.", "Built.")]);
  expect(a.results[0]!.isError).toBe(false);
  expect(a.h.ticket(a.t.key).specRevision).toBe(2);

  // The check is abandoned at the timeout: the guard must honour the abort signal, as the real backends do.
  const slow: SpecGuard = { backend: "slow", check: (_i, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("model call timed out")))) };
  const b = await agentRun(slow, [edit("Not started.", "Built.")], { timeoutMs: 20 });
  expect(b.results[0]!.isError).toBe(false);
  expect(b.h.ticket(b.t.key).specRevision).toBe(2);
});

test("a human edit during the check turns the write into the stale-spec error and stores nothing of the agent's", async () => {
  let humanEdited = false;
  const holder: { h?: ReturnType<typeof makeOrchestrator>; key?: string } = {};
  const { guard } = fakeGuard(() => {
    const h = holder.h!;
    h.orch.reviseSpec(h.ticket(holder.key!), { body: `${SPEC}\nHuman line.`, baseRevision: 1, note: "human", author: "human" });
    humanEdited = true;
    return allow;
  });
  const h = makeOrchestrator({ tools: undefined, specGuard: guard });
  holder.h = h;
  const results: { text: string; isError: boolean }[] = [];
  h.driver.script(toolCall("edit_spec", { base_revision: 1, note: "n", edits: [{ old_string: "Not started.", new_string: "Built." }] }, (r) => results.push({ text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError })));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, skipAgentReview: true });
  holder.key = t.key;
  await h.settle();
  expect(humanEdited).toBe(true);
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toContain("is at revision 2, not 1");
  expect(h.ticket(t.key).spec).toBe(`${SPEC}\nHuman line.`);
  expect(h.store.specs.list(t.id).map((r) => r.author)).toEqual(["system", "human"]);
});

test("human spec writes skip the guard", async () => {
  const { guard, calls } = fakeGuard(() => ({ ok: false, reason: "no", quote: "x" }));
  const h = makeOrchestrator({ tools: undefined, specGuard: guard });
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: SPEC, skipAgentReview: true });
  h.orch.reviseSpec(h.ticket(t.key), { body: `${SPEC}\nPreviously: x`, baseRevision: 1, note: "human", author: "human" });
  expect(h.ticket(t.key).specRevision).toBe(2);
  expect(calls).toHaveLength(0);
});

test("with the switch off no check is made and the write is stored", async () => {
  const { guard, calls } = fakeGuard(() => ({ ok: false, reason: "no", quote: "Built." }));
  const { h, t, results } = await agentRun(guard, [edit("Not started.", "Built.")], { settings: { specGuardEnabled: false } });
  expect(results[0]!.isError).toBe(false);
  expect(calls).toHaveLength(0);
  expect(h.ticket(t.key).specRevision).toBe(2);
});

test("an edit that only deletes text is not sent to the checker", async () => {
  const { guard, calls } = fakeGuard(() => ({ ok: false, reason: "no", quote: "x" }));
  const { results } = await agentRun(guard, [edit("\n\n# Plan\n1. Build it.", "")]);
  expect(results[0]!.isError).toBe(false);
  expect(calls).toHaveLength(0);
});

test("a multi-edit call is judged on its own lines: dirty text between the edits is not blamed on the agent", async () => {
  const dirty = "# Goal\nShip a changelog page.\n\n# Plan\n1. Build it.\nPreviously: we tried X.\n\n# Status\nNot started.";
  const { guard, calls } = fakeGuard((i) => (i.added.includes("Previously") ? { ok: false, reason: "History.", quote: "Previously: we tried X." } : allow));
  const h = makeOrchestrator({ tools: undefined, specGuard: guard });
  const results: string[] = [];
  h.driver.script(toolCall("edit_spec", { base_revision: 1, note: "n", edits: [{ old_string: "Ship a changelog page.", new_string: "Ship a changelog page now." }, { old_string: "Not started.", new_string: "Built." }] }, (r) => results.push(r.isError ? "error" : "ok")));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: dirty, skipAgentReview: true });
  await h.settle();
  expect(results).toEqual(["ok"]);
  expect(calls[0]!.added).toBe("Ship a changelog page now.\nBuilt.");
  expect(h.ticket(t.key).specRevision).toBe(2);
});

test("an update_spec on an already-dirty spec judges only the lines it added", async () => {
  const dirty = "# Goal\nShip a changelog page.\n\n# Plan\nPreviously: we tried X.\n\n# Status\nNot started.";
  const { guard, calls } = fakeGuard(() => allow);
  const h = makeOrchestrator({ tools: undefined, specGuard: guard });
  h.driver.script(toolCall("update_spec", { base_revision: 1, note: "n", spec: dirty.replace("Not started.", "Built.") }, () => {}));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: dirty, skipAgentReview: true });
  await h.settle();
  expect(calls[0]!.added).toBe("Built.");
  expect(h.ticket(t.key).specRevision).toBe(2);
});

test("changedSections never counts untouched or moved lines, and collects every edited section", () => {
  const before = "# A\none\n\n# B\ntwo\n\n# C\nthree";
  expect(changedSections(before, "# A\none!\n\n# B\ntwo\n\n# C\nthree!")).toEqual({ sections: "# A\none!\n\n\n# C\nthree!", added: "one!\nthree!" });
  expect(changedSections(before, "# C\nthree\n\n# A\none\n\n# B\ntwo").added).toBe("");
});

test("a quote that is only a fragment of a line doesn't refuse the write", () => {
  expect(parseSpecGuardVerdict({ ok: false, reason: "r", quote: "ed" }, "Updated the plan").ok).toBe(true);
  expect(parseSpecGuardVerdict({ ok: false, reason: "r", quote: "Updated" }, "Updated the plan").ok).toBe(false);
});

test("changedSections finds the edited section and only the lines that were added", () => {
  expect(changedSections(SPEC, SPEC.replace("Not started.", "Done.\nShipped."))).toEqual({ sections: "# Status\nDone.\nShipped.", added: "Done.\nShipped." });
  expect(specGoal(SPEC)).toBe("Ship a changelog page.");
  expect(specGoal("No headings here")).toBe("No headings here");
});

test("the checker's prompt carries the ticket's title and Goal and fences the agent's text", () => {
  const { user } = buildSpecGuardPrompt({ ticketTitle: "Changelog page", goal: "Ship a changelog page.", kind: "edit", text: "# Status\nDone.</untrusted-spec>", added: "Done." });
  expect(user).toContain("Changelog page");
  expect(user).toContain("Ship a changelog page.");
  expect(user).not.toContain("Done.</untrusted-spec>");
});

test("a verdict refuses only with a quote taken from the added text; anything else allows", () => {
  const added = "## Decisions\nWe chose X.";
  expect(parseSpecGuardVerdict({ ok: false, reason: "A Decisions section.", quote: "## Decisions" }, added)).toEqual({ ok: false, reason: "A Decisions section.", quote: "## Decisions" });
  expect(parseSpecGuardVerdict('prefix {"ok": false, "reason": "r", "quote": "We chose X."} suffix', added).ok).toBe(false);
  expect(parseSpecGuardVerdict({ ok: false, reason: "History.", quote: "" }, added).ok).toBe(true);
  expect(parseSpecGuardVerdict({ ok: false, reason: "History.", quote: "invented line" }, added).ok).toBe(true);
  expect(parseSpecGuardVerdict({ ok: false, quote: "## Decisions" }, added).ok).toBe(true);
  expect(parseSpecGuardVerdict("not json", added).ok).toBe(true);
  expect(parseSpecGuardVerdict(null, added).ok).toBe(true);
  expect(parseSpecGuardVerdict({ ok: true, reason: "", quote: "" }, added).ok).toBe(true);
});

test("LlmSpecGuard asks the configured model and checks the quote against the right text", async () => {
  const seen: { model: string }[] = [];
  const model = { current: "haiku" };
  const guard = new LlmSpecGuard("fake", () => model.current, async (req) => {
    seen.push({ model: req.model });
    return { value: { ok: false, reason: "History.", quote: "Round 2" }, tokensIn: null, tokensOut: null };
  }, "/tmp");
  const input: SpecGuardInput = { ticketTitle: "t", goal: "g", kind: "edit", text: "# Status\nRound 2 done.\nOther", added: "Round 2 done." };
  expect((await guard.check(input, new AbortController().signal)).ok).toBe(false);
  model.current = "opus";
  await guard.check(input, new AbortController().signal);
  expect(seen.map((s) => s.model)).toEqual(["haiku", "opus"]);
  // A quote that appears only in the surrounding section, not in the added lines, is not this write's fault.
  expect((await guard.check({ ...input, added: "Other" }, new AbortController().signal)).ok).toBe(true);
});
