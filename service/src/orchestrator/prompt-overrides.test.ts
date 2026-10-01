// Prompt overrides (DESIGN.md "Prompt overrides"): the registry, precedence between the user's
// override and the built-in, settings validation, and an override reaching a real run.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseTemplate, PROMPT_IDS, templateVariables, type Project, type Session, type Ticket } from "@harness/shared";
import { makeOrchestrator } from "../testing/fakes";
import { HarnessError } from "./errors";
import { PROMPTS, renderPrompt } from "./prompt-templates";
import { promptsWith, systemPrompt, workStartPrompt } from "./prompts";
import { applySettingsPatch, DEFAULT_SETTINGS, resolveSettings, validateSettingsPatch } from "./settings";

describe("prompt registry", () => {
  test("has exactly the protocol's prompt ids", () => {
    expect(Object.keys(PROMPTS).sort()).toEqual([...PROMPT_IDS].sort());
  });

  for (const id of PROMPT_IDS) {
    test(`${id}: the built-in uses every declared variable and nothing else`, () => {
      const used = templateVariables(parseTemplate(PROMPTS[id].template)).sort();
      expect(used).toEqual(Object.keys(PROMPTS[id].variables).sort());
      expect(PROMPTS[id].label.trim()).not.toBe("");
      expect(PROMPTS[id].description.trim()).not.toBe("");
    });
  }
});

describe("renderPrompt precedence", () => {
  const vars = { branch: "harness/x", onBase: false, skipAgentReview: false, canSkipReview: true };

  test("an override replaces the built-in and gets the same variables", () => {
    expect(renderPrompt("system.work", vars, { "system.work": "  ## Work\nOn {{branch}}.\n" })).toBe("## Work\nOn harness/x.");
  });

  test("unset, null or an empty override is the built-in", () => {
    const builtin = renderPrompt("system.work", vars);
    expect(builtin).toContain("on branch `harness/x`");
    expect(renderPrompt("system.work", vars, {})).toBe(builtin);
    expect(renderPrompt("system.work", vars, { "system.work": null })).toBe(builtin);
    expect(renderPrompt("system.work", vars, { "system.work": "" })).toBe(builtin);
    expect(renderPrompt("system.work", vars, null)).toBe(builtin);
  });

  test("an override for another prompt doesn't touch this one", () => {
    expect(renderPrompt("system.work", vars, { "system.plan": "X" })).toBe(renderPrompt("system.work", vars));
  });

  test("a stored override that no longer validates falls back to the built-in instead of reaching the agent", () => {
    const builtin = renderPrompt("system.work", vars);
    expect(renderPrompt("system.work", vars, { "system.work": "On {{branchName}}" })).toBe(builtin);
    expect(renderPrompt("system.work", vars, { "system.work": "{{#if branch}}open" })).toBe(builtin);
  });

  test("the code must pass every declared variable", () => {
    expect(() => renderPrompt("system.work", {})).toThrow("missing variable branch");
  });
});

const project: Project = {
  id: "p1",
  key: "NYT",
  name: "NYT",
  path: "/p",
  nextSeq: 1,
  defaultDriver: null,
  useWorktrees: true,
  requireHumanReview: true,
  autoComplete: true,
  defaultModels: {},
  permissionMode: null,
  color: null,
  createdAt: 0,
  updatedAt: 0,
};
const session = { id: "s1", key: "NYT-1", kind: "ticket", ticketId: "t1", driver: "d", cwd: "/p", title: "", triageStatus: null, outcome: null, busy: false, createdAt: 0, updatedAt: 0 } as Session;
const ticket = {
  id: "t1",
  key: "NYT-1",
  kind: "task",
  title: "Dark mode",
  description: "Add it.",
  status: "in_progress",
  dependsOn: [],
  branch: null,
  workdir: null,
  externalRef: null,
} as unknown as Ticket;

describe("overrides in the prompt builders", () => {
  test("a section override lands in its place in the system prompt; the other sections stay built-in", () => {
    const builtin = systemPrompt({ kind: "work", project, ticket, session });
    const custom = systemPrompt({ kind: "work", project, ticket, session, overrides: { "system.browser": "## Browser\nNo browsing, {{nope}}" } });
    expect(custom).toBe(builtin); // invalid: ignored
    const replaced = systemPrompt({ kind: "work", project, ticket, session, overrides: { "system.lifecycle": "## Lifecycle\nShort version." } });
    expect(replaced).not.toContain("Tickets move planning");
    expect(replaced).toBe(builtin.replace(/## Ticket lifecycle\n[\s\S]*?\n\n(?=## This run: work)/, "## Lifecycle\nShort version.\n\n"));
  });

  test("an override that renders to nothing drops its section", () => {
    const dropped = systemPrompt({ kind: "work", project, ticket, session, overrides: { "system.config": "{{#if canChange}}{{/if}}" } });
    expect(dropped).not.toContain("## Harness configuration");
    expect(dropped).toContain("## Board");
    expect(dropped).not.toContain("\n\n\n");
  });

  test("promptsWith binds the overrides to every builder", () => {
    const p = promptsWith({ "run.work_start": "Go: {{ticket}}\n{{brief}}", "system.intro": "Hi." });
    expect(p.workStartPrompt(ticket)).toBe('Go: NYT-1 "Dark mode"\nAdd it.');
    expect(p.systemPrompt({ kind: "work", project, ticket, session }).startsWith("Hi.\n\n## Context")).toBe(true);
    // conductor tickets use their own prompt id, still built-in
    expect(p.workStartPrompt({ ...ticket, kind: "conductor" })).toBe(workStartPrompt({ ...ticket, kind: "conductor" }));
  });
});

describe("settings.prompts", () => {
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return [(err as HarnessError).status, (err as Error).message];
    }
    return null;
  };

  test("defaults to every prompt unset", () => {
    expect(Object.keys(DEFAULT_SETTINGS.prompts!).sort()).toEqual([...PROMPT_IDS].sort());
    expect(Object.values(DEFAULT_SETTINGS.prompts!).every((v) => v === null)).toBe(true);
    expect(resolveSettings({}).prompts).toEqual(DEFAULT_SETTINGS.prompts);
  });

  test("PATCH refuses unknown ids, invalid templates and non-strings with a 400 naming the problem", () => {
    expect(status(() => validateSettingsPatch({ prompts: { "system.wrok": "x" } }))).toEqual([400, "Unknown prompt: system.wrok (GET /prompts lists them)"]);
    expect(status(() => validateSettingsPatch({ prompts: { "system.work": "On {{brnch}}" } }))).toEqual([
      400,
      "prompts.system.work: Unknown variable {{brnch}}: the variables are {{branch}}, {{onBase}}, {{skipAgentReview}}, {{canSkipReview}}",
    ]);
    expect(status(() => validateSettingsPatch({ prompts: { "system.work": "{{#if branch}}x" } }))).toEqual([
      400,
      "prompts.system.work: Line 1: {{#if branch}} is never closed with {{/if}}",
    ]);
    expect(status(() => validateSettingsPatch({ prompts: { "system.intro": 3 } }))).toEqual([400, "prompts.system.intro must be template text or null"]);
    expect(status(() => validateSettingsPatch({ prompts: ["x"] }))?.[0]).toBe(400);
  });

  test("null and blank reset; valid templates pass", () => {
    expect(validateSettingsPatch({ prompts: { "system.work": null, "system.plan": "  \n", "run.review": "Review {{ticket}}" } })).toEqual({
      prompts: { "system.work": null, "system.plan": null, "run.review": "Review {{ticket}}" },
    });
  });

  test("an override echoed back unchanged isn't re-validated, a changed one is", () => {
    const current = { ...DEFAULT_SETTINGS, prompts: { ...DEFAULT_SETTINGS.prompts, "system.work": "stale {{gone}}" } };
    expect(validateSettingsPatch({ prompts: { "system.work": "stale {{gone}}" }, maxConcurrentRuns: 2 }, undefined, current)).toEqual({ prompts: {}, maxConcurrentRuns: 2 });
    expect(status(() => validateSettingsPatch({ prompts: { "system.work": "new {{gone}}" } }, undefined, current))?.[0]).toBe(400);
  });

  test("PATCH merges per id, and null removes one", () => {
    let s = resolveSettings({});
    s = resolveSettings(applySettingsPatch(s, validateSettingsPatch({ prompts: { "system.work": "A", "system.plan": "B" } })) as Record<string, unknown>);
    s = resolveSettings(applySettingsPatch(s, validateSettingsPatch({ prompts: { "system.plan": null, "run.review": "C" } })) as Record<string, unknown>);
    expect(Object.fromEntries(Object.entries(s.prompts!).filter(([, v]) => v))).toEqual({ "system.work": "A", "run.review": "C" });
    // stored compactly
    expect(applySettingsPatch(s, validateSettingsPatch({ prompts: { "run.review": null } })).prompts).toEqual({ "system.work": "A" });
  });

  test("stored overrides for ids that no longer exist are ignored; stale templates are kept for the user to fix", () => {
    const s = resolveSettings({ maxConcurrentRuns: 3, prompts: { "system.retired": "old", "system.work": "On {{gone}}", "system.plan": 5, "run.review": "R" } });
    expect(s.maxConcurrentRuns).toBe(3);
    expect(s.prompts!["system.work"]).toBe("On {{gone}}");
    expect(s.prompts!["run.review"]).toBe("R");
    expect(s.prompts!["system.plan"]).toBeNull();
    expect("system.retired" in s.prompts!).toBe(false);
    // a malformed prompts value costs only the overrides
    expect(resolveSettings({ maxConcurrentRuns: 3, prompts: "nope" })).toMatchObject({ maxConcurrentRuns: 3, prompts: DEFAULT_SETTINGS.prompts });
  });
});

describe("overrides reach runs", () => {
  test("a system prompt section and the work-start prompt come from settings; resetting goes back to the built-in", async () => {
    const h = makeOrchestrator();
    const dir = join(h.home, "proj");
    mkdirSync(dir, { recursive: true });
    const project = h.orch.createProject({ path: dir, key: "PROJ", useWorktrees: false });
    h.orch.updateSettings({
      prompts: {
        "system.work": "## This run: work\nCustom rules for {{#if branch}}{{branch}}{{else}}the checkout{{/if}}.",
        "run.work_start": "Start {{ticket}} now.\n\n## Plan\n{{brief}}",
      },
    });
    const t = await h.orch.createTicket({ projectId: project.id, prompt: "Ship it", start: false });
    await h.orch.startTicket(t.key);
    await h.orch.idle();
    const work = h.driver.calls.find((c) => c.kind === "work")!;
    expect(work.systemPrompt).toContain("## This run: work\nCustom rules for the checkout.");
    expect(work.systemPrompt).not.toContain("Do the work the ticket describes");
    expect(work.systemPrompt).toContain("## Ticket lifecycle"); // untouched sections stay built-in
    expect(work.prompt).toMatch(/^Start PROJ-1 ".*" now\.\n\n## Plan\nShip it$/);

    const catalog = h.orch.promptCatalog();
    expect(catalog.map((e) => e.id)).toEqual([...PROMPT_IDS]);
    const entry = catalog.find((e) => e.id === "system.work")!;
    expect(entry).toMatchObject({ group: "system", override: expect.stringContaining("Custom rules"), overrideError: null, builtin: PROMPTS["system.work"].template });
    expect(entry.variables.map((v) => v.name)).toEqual(["branch", "onBase", "skipAgentReview", "canSkipReview"]);
    expect(entry.variables[0]).toEqual({ name: "branch", description: PROMPTS["system.work"].variables.branch! });
    expect(catalog.find((e) => e.id === "system.plan")).toMatchObject({ override: null, overrideError: null });

    h.orch.updateSettings({ prompts: { "system.work": null } });
    await h.orch.sendMessage(t.key, "again", { move: true });
    await h.orch.idle();
    const again = h.driver.calls.filter((c) => c.kind === "work").at(-1)!;
    expect(again.systemPrompt).toContain("Do the work the ticket describes");
    expect(h.orch.publicSettings().prompts).toMatchObject({ "system.work": null, "run.work_start": expect.stringContaining("Start") });
  });

  test("the catalog reports a stored override that no longer validates", () => {
    const h = makeOrchestrator();
    h.store.settings.set({ prompts: { "system.work": "On {{gone}}" } });
    expect(h.orch.promptCatalog().find((e) => e.id === "system.work")).toMatchObject({
      override: "On {{gone}}",
      overrideError: "Unknown variable {{gone}}: the variables are {{branch}}, {{onBase}}, {{skipAgentReview}}, {{canSkipReview}}",
    });
  });
});

describe("renamed prompt ids", () => {
  test("an override under system.complete / run.complete applies to the _merge prompts, read or sent", () => {
    const read = resolveSettings({ prompts: { "system.complete": "Merge it {{branch}}", "run.complete": "Go {{ticket}}" } }).prompts!;
    expect(read["system.complete_merge"]).toBe("Merge it {{branch}}");
    expect(read["run.complete_merge"]).toBe("Go {{ticket}}");
    // An override saved under the new id wins over one left under the old id.
    expect(resolveSettings({ prompts: { "system.complete": "old", "system.complete_merge": "new" } }).prompts!["system.complete_merge"]).toBe("new");
    // An older client sending the old id saves it under the new one.
    expect(validateSettingsPatch({ prompts: { "run.complete": "Finish {{ticket}}" } }).prompts).toEqual({ "run.complete_merge": "Finish {{ticket}}" });
    expect(() => validateSettingsPatch({ prompts: { "run.completely": "x" } })).toThrow(/Unknown prompt/);
  });
});
