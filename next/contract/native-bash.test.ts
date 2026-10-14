// The one permission test that needs the real native bash tool: an auto-mode classifier allow runs
// the command for real. The gate's other paths (deny, ask, read-only) never reach the shell and stay
// in next/orchestrator/permissions.test.ts. This tier is allowed to spawn.

import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DummyDriver } from "../../service/src/drivers/dummy";
import type { Classifier, ClassifierRequest } from "../../service/src/permissions/classifier";
import { makeOrchestrator } from "../../service/src/testing/fakes";
import { toolsForRun } from "../../service/src/tools/index";

test("auto: classifier allow runs the command and logs an audit entry", async () => {
  const calls: ClassifierRequest[] = [];
  const classifier: Classifier = {
    backend: "fake",
    async classify(req) {
      calls.push(req);
      return { decision: "allow", reason: "creating a repo in the workdir is routine" };
    },
  };
  const h = makeOrchestrator({ drivers: [new DummyDriver({ delayMs: 0 })], tools: (kind, d) => toolsForRun(kind, d), classifier });
  h.store.settings.set({ defaultDriver: "dummy" });
  const dir = join(h.home, "proj");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, useWorktrees: false });
  const t = await h.orch.createTicket({ projectId: project.id, spec: "/bash git init -q && touch made.txt" });
  await h.orch.idle();
  expect(existsSync(join(dir, "made.txt"))).toBe(true);
  expect(calls[0]).toMatchObject({ tool: "bash", input: { command: "git init -q && touch made.txt" }, ticket: { key: t.key } });
  const logs = h.store.transcript.list(t.sessionId).flatMap((e) => (e.content.type === "status" && e.content.permission ? [e.content.permission] : []));
  expect(logs).toEqual([expect.objectContaining({ decision: "allow", source: "classifier", backend: "fake", mode: "auto", summary: "git init -q && touch made.txt" })]);
});
