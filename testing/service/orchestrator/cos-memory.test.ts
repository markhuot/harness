import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CosScope } from "@harness/shared";
import { triageGuidance } from "../../../service/src/cos/engine";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

/** A Work group ticket that has asked a question, a Home group ticket, and a runner for scripted chiefs of staff. */
async function board() {
  const h = makeOrchestrator({ tools: undefined });
  const project = (key: string, group: string) => {
    const dir = join(h.home, "proj", key.toLowerCase());
    mkdirSync(dir, { recursive: true });
    return h.orch.createProject({ path: dir, name: key, key, useWorktrees: false, group });
  };
  const work = project("WORK1", "Work");
  const home = project("HOME1", "Home");
  const groupOf = (name: string) => h.store.groups.findByName(name)!.id;
  const ticket = async (projectId: string, spec: string) => {
    const t = await h.orch.createTicket({ projectId, spec, start: false });
    await h.settle();
    return t;
  };
  const w = await ticket(work.id, "Work ticket");
  const o = await ticket(home.id, "Home ticket");
  /** The ticket's own agent asks its question; it ends up blocked. */
  async function ask(key: string, question: string) {
    h.driver.script(callTools([["block", { question }]]).steps);
    await h.orch.startTicket(key);
    await h.settle();
  }
  async function asCos(scope: CosScope, calls: [string, unknown][], cosKey?: string) {
    const cos = cosKey ? h.store.tickets.getByKey(cosKey)! : h.orch.openCos(scope);
    const { steps, results } = callTools(calls);
    h.driver.script(steps);
    await h.orch.sendMessage(cos.key, "go");
    await h.settle();
    return { results, cos };
  }
  return { h, w, o, groupOf, ask, asCos };
}
const entries = (text: string) => (JSON.parse(text) as { entries: { ticket: string; kind: string; text: string; replies?: { text: string }[] }[] }).entries;

test("a human's message to a blocked ticket and the notes it is unblocked with are recorded as answers to that block, and query_activity returns them with the question", async () => {
  const { h, w, ask, asCos, groupOf } = await board();
  await ask(w.key, "Which database should I use?");
  expect(h.ticket(w.key).status).toBe("blocked");
  const blocked = h.store.activity.latestOfKind(w.sessionId, "blocked")!;

  h.driver.script([]);
  await h.orch.sendMessage(w.key, "Use Postgres, it is what we run");
  await h.settle();
  await h.orch.unblockTicket(w.key, { notes: "Go with Postgres" });
  await h.settle();

  const answered = h.store.activity.listBySession(w.sessionId).filter((e) => e.kind === "answered");
  expect(answered.map((e) => [e.author, e.body, e.meta.answers])).toEqual([
    ["human", "Use Postgres, it is what we run", blocked.id],
    ["human", "Go with Postgres", blocked.id],
  ]);

  const { results } = await asCos({ group: groupOf("Work") }, [["query_activity", { ticket_key: w.key, kinds: ["blocked"] }]]);
  const [hit] = entries(results[0]!.text);
  expect(hit).toMatchObject({ ticket: w.key, kind: "blocked", text: "Which database should I use?" });
  expect(hit!.replies!.map((r) => r.text)).toEqual(["Use Postgres, it is what we run", "Go with Postgres"]);
});

test("a message to a ticket that isn't blocked records no answer", async () => {
  const { h, o } = await board();
  h.driver.script([]);
  await h.orch.sendMessage(o.key, "hello there");
  await h.settle();
  expect(h.store.activity.listBySession(o.sessionId).filter((e) => e.kind === "answered")).toEqual([]);
});

test("query_activity never returns another group's tickets, even when asked for one by key, and All sees every group", async () => {
  const { w, o, ask, asCos, groupOf } = await board();
  await ask(w.key, "Work question");
  await ask(o.key, "Home question");
  const { results } = await asCos({ group: groupOf("Work") }, [
    ["query_activity", { kinds: ["blocked"] }],
    ["query_activity", { ticket_key: o.key }],
    ["query_activity", { project_keys: ["HOME1"] }],
    ["query_activity", { ticket_key: "ZZZ-99" }],
  ]);
  expect(entries(results[0]!.text).map((e) => e.ticket)).toEqual([w.key]);
  expect(entries(results[1]!.text)).toEqual([]);
  expect(entries(results[2]!.text)).toEqual([]);
  expect(results[3]!.text.replace(/"now": "[^"]*"/, "")).toBe(results[1]!.text.replace(/"now": "[^"]*"/, ""));
  const all = await asCos("all", [["query_activity", { kinds: ["blocked"] }]]);
  expect(entries(all.results[0]!.text).map((e) => e.ticket).sort()).toEqual([o.key, w.key].sort());
});

test("query_activity takes dates in the Mac's timezone for from and to, and refuses a bad date or an unknown kind", async () => {
  const { w, ask, asCos, h } = await board();
  await ask(w.key, "q");
  const at = new Date(h.clock());
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
  const { results } = await asCos("all", [
    ["query_activity", { from: day(at), to: day(next), kinds: ["blocked"] }],
    ["query_activity", { from: day(next), kinds: ["blocked"] }],
    ["query_activity", { from: "yesterday" }],
    ["query_activity", { kinds: ["nope"] }],
  ]);
  expect(entries(results[0]!.text)).toHaveLength(1);
  expect(entries(results[1]!.text)).toEqual([]);
  expect(results[2]).toMatchObject({ isError: true, text: expect.stringContaining("ISO 8601") });
  expect(results[3]).toMatchObject({ isError: true, text: expect.stringContaining("must be one of") });
});

test("update_memory_section edits one section; the triage guidance and the other sections survive each other's edits, and the triage layer reads the guidance", async () => {
  const { h, asCos } = await board();
  const { results, cos } = await asCos("all", [
    ["update_memory_section", { section: "Triage guidance", body: "Ignore dependabot PR events." }],
    ["update_memory_section", { section: "Preferences", body: "Short answers.\n\n```md\n## not a heading\n```" }],
    ["update_memory_section", { section: "Preferences", body: "Short answers, no emoji." }],
    ["read_memory", {}],
  ]);
  expect(results.map((r) => r.isError)).toEqual([false, false, false, false]);
  const text = h.store.tickets.getByKey(cos.key)!.agentNotes!;
  expect(text).toBe("## Triage guidance\n\nIgnore dependabot PR events.\n\n## Preferences\n\nShort answers, no emoji.\n");
  expect(results[3]!.text).toBe(text);
  expect(triageGuidance(h.store.tickets.getByKey(cos.key))).toBe("Ignore dependabot PR events.");

  const again = await asCos("all", [["update_memory_section", { section: "triage guidance", body: "Ignore dependabot; page me for prod alerts." }]], cos.key);
  expect(again.results[0]!.isError).toBe(false);
  expect(h.store.tickets.getByKey(cos.key)!.agentNotes).toBe("## Triage guidance\n\nIgnore dependabot; page me for prod alerts.\n\n## Preferences\n\nShort answers, no emoji.\n");
});

test("update_memory_section refuses a body that would start another section or overflow, and leaves the memory as it was", async () => {
  const { h, asCos } = await board();
  const { results, cos } = await asCos("all", [
    ["update_memory_section", { section: "Triage guidance", body: "keep" }],
    ["update_memory_section", { section: "Triage guidance", body: "x\n## Triage guidance\ny" }],
    ["update_memory_section", { section: "Triage guidance", body: "z".repeat(5000) }],
    ["update_memory_section", { section: "Big", body: "z".repeat(17_000) }],
  ]);
  expect(results.map((r) => r.isError)).toEqual([false, true, true, true]);
  expect(h.store.tickets.getByKey(cos.key)!.agentNotes).toBe("## Triage guidance\n\nkeep\n");
});

test("the chief's system prompt is the same with and without memory; the memory is in its run context", async () => {
  const { h, asCos, groupOf } = await board();
  await asCos("all", []);
  const bare = h.driver.requests.find((r) => r.kind === "cos")!;
  expect(bare.runContext).toContain("Your memory is empty");
  const other = h.orch.openCos({ group: groupOf("Home") });
  h.store.tickets.update(other.ticketId, { agentNotes: "## Triage guidance\n\nIgnore bots." });
  await asCos("all", [], other.key);
  const withMemory = h.driver.requests.filter((r) => r.kind === "cos").at(-1)!;
  const same = (s: string) => s.replace(/COS-\d+/g, "COS-N"); // the only thing in it that names the chief
  expect(same(withMemory.systemPrompt)).toBe(same(bare.systemPrompt));
  expect(withMemory.runContext).toContain("<memory>\n## Triage guidance\n\nIgnore bots.\n</memory>");
  expect(bare.systemPrompt).toContain("update_memory_section");
  expect(bare.systemPrompt).toContain("query_activity");
});
