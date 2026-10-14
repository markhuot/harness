// A watcher created through the config tools really runs: its command goes through the login shell
// and its output reaches triage and the Inbox. The tools' approval flow stays in
// next/orchestrator/config-tools.test.ts; this half needs a real process, so it lives in the tier
// that may spawn.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeTool } from "../../service/src/drivers/types";
import { FakeDriver, makeOrchestrator } from "../../service/src/testing/fakes";
import { toolsForRun } from "../../service/src/tools/index";
import { WatcherRunner } from "../../service/src/orchestrator/watchers";

describe("config tools behind human approval", () => {
  test("a watcher created through the tools runs and its output reaches the Inbox", async () => {
    const driver = new FakeDriver("fake");
    const h = makeOrchestrator({
      driver,
      tools: (kind, d) => toolsForRun(kind, d),
      watchers: (handlers) => new WatcherRunner({ ...handlers, timing: { batchIdleMs: 5, batchMaxMs: 20, minIntervalMs: 10 } }),
    });
    const dir = join(h.home, "site");
    mkdirSync(dir);
    const project = h.orch.createProject({ path: dir, key: "SITE", useWorktrees: false });
    // Stands in for a tool the user has installed: prints plain text, no particular format.
    const tool = join(h.home, "watch-fake");
    writeFileSync(tool, `#!/bin/sh\necho "ACME-7 Fix the footer (assigned to $1)"\n`);
    chmodSync(tool, 0o755);
    // A shell command line (pipe included), the way create_watcher teaches it
    const input = { name: "fake", command: `${tool} mark | tr a-z A-Z`, mode: "interval", interval_sec: 600, prompt: "File footer bugs in SITE." };
    let done = false;
    const worker = driver.run.bind(driver);
    driver.run = async function* (req) {
      if (req.kind !== "work") return yield* worker(req);
      if (!done) done = !(await executeTool(req.tools, "create_watcher", input, req.toolContext)).isError;
    };
    const t = await h.orch.createTicket({ projectId: project.id, spec: "add the fake watcher" });
    await h.orch.idle();
    expect(h.orch.listWatchers()).toEqual([]);
    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    const deadline = Date.now() + 10_000;
    while (h.orch.listSessions("triage").length === 0 && Date.now() < deadline) await Bun.sleep(20);
    await h.orch.idle();
    expect(h.orch.listSessions("triage")).toHaveLength(1);
    // The output went through the login shell, and triage got it with the watcher's prompt
    const triage = driver.calls.find((c) => c.kind === "triage")!;
    expect(triage.prompt).toContain("ACME-7 FIX THE FOOTER (ASSIGNED TO MARK)");
    expect(triage.prompt).toContain("File footer bugs in SITE.");
    expect(h.orch.listWatchers()[0]!.lastError).toBeNull();
    await h.orch.stop();
  });
});
