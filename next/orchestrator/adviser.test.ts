import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../../service/src/testing/fakes";

// Planning and review runs launch an Opus adviser subagent when it applies: the run's driver has
// subagents, the Adviser phase resolves to the same driver, and its model differs from the run's.

const fake = (model: string | null) => ({ driver: "fake", model });

function setup(configure: (d: FakeDriver) => void = (d) => {
  d.subagentTool = "the `Agent` tool";
  d.adviserTool = "the `Agent` tool with the `general-purpose` subagent type";
}) {
  const driver = new FakeDriver();
  configure(driver);
  const h = makeOrchestrator({ driver, drivers: [driver, new FakeDriver("other")] });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  h.orch.updateSettings({ phaseModels: { plan: fake("sonnet"), work: fake("sonnet"), review: fake("sonnet"), adviser: fake("opus") } });
  return { ...h, project };
}

/** The system prompt of each run of a kind, in order. */
const prompts = (h: ReturnType<typeof setup>, kind: string) => h.driver.calls.filter((c) => c.kind === kind).map((c) => `${c.systemPrompt}\n\n${c.runContext}`);

describe("the adviser reaches planning and review runs", () => {
  test("when it applies, both get the adviser block with its model", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Refactor auth", start: false });
    await h.orch.idle();
    await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    const [plan] = prompts(h, "plan");
    const [review] = prompts(h, "review");
    expect(t.status).toBe("planning");
    expect(plan).toContain('passing model "opus"');
    expect(review).toContain('passing model "opus"');
    expect(review).toContain("`adviser_findings`");
    // The work run is never offered it.
    expect(prompts(h, "work")[0]).not.toContain("adviser");
  });

  test.each<[string, () => ReturnType<typeof setup>]>([
    [
      "an adviser on the run's own model adds nothing",
      () => {
        const h = setup();
        h.orch.updateSettings({ phaseModels: { adviser: fake("sonnet") } });
        return h;
      },
    ],
    ["a driver without subagents keeps today's prompt", () => setup(() => {})],
    [
      "an adviser set to another driver adds nothing",
      () => {
        const h = setup();
        h.orch.updateSettings({ phaseModels: { adviser: { driver: "other", model: "opus" } } });
        return h;
      },
    ],
    [
      "an adviser with no model of its own (the driver default) adds nothing",
      () => {
        const h = setup();
        h.orch.updateSettings({ phaseModels: { adviser: fake(null) } });
        return h;
      },
    ],
  ])("%s", async (_title, build) => {
    const h = build();
    await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    expect(prompts(h, "review")[0]).not.toContain("adviser");
  });

  test("a ticket's own Adviser choice wins over the settings'", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go", start: false, phaseModels: { adviser: fake("sonnet") } });
    await h.orch.idle();
    expect(t.phaseModels?.adviser).toEqual(fake("sonnet"));
    expect(prompts(h, "plan")[0]).not.toContain("adviser");
  });
});

describe("review_decision adviser_findings", () => {
  const findings = "1. src/cache.ts:42 high: the lookup isn't cached, so every request hits the API.\n2. src/db.ts:9 low: unused import.";

  test("the findings land verbatim under their own heading, after the notes", async () => {
    const h = setup();
    h.driver.adviserFindings = findings;
    h.driver.rejectsLeft = 1;
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    const entry = h.orch.activity(t.key).find((a) => a.kind === "changes_requested" && a.meta.by === "agent")!;
    expect(entry.body).toBe("Please fix X");
    expect(entry.meta.detail).toBe(`Please fix X\n\n### Adviser review\n${findings}`);
  });

  test("an approval carries them too, and no heading appears without findings", async () => {
    const h = setup();
    h.driver.adviserFindings = findings;
    const t = await h.orch.createTicket({ projectId: h.project.id, spec: "go" });
    await h.orch.idle();
    expect(h.orch.activity(t.key).find((a) => a.kind === "review_approved")!.meta.detail).toContain(`### Adviser review\n${findings}`);

    const plain = setup();
    const t2 = await plain.orch.createTicket({ projectId: plain.project.id, spec: "go" });
    await plain.orch.idle();
    const approved = plain.orch.activity(t2.key).find((a) => a.kind === "review_approved")!;
    expect(`${approved.body}\n${approved.meta.detail ?? ""}`).not.toContain("Adviser review");
  });
});
