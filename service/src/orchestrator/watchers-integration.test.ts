import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { WatcherRunner } from "./watchers";

describe("watchers → triage", () => {
  test("a real watcher's output is one triage item with its driver, deduped until it changes", async () => {
    const other = new FakeDriver("other");
    const main = new FakeDriver("fake");
    let runner!: WatcherRunner;
    const h = makeOrchestrator({
      driver: main,
      drivers: [main, other],
      watchers: (handlers) => (runner = new WatcherRunner({ ...handlers, timing: { batchIdleMs: 5, batchMaxMs: 20, restartDelayMs: 60_000 } })),
    });
    const dir = join(h.home, "foo");
    mkdirSync(dir);
    const p = h.orch.createProject({ path: dir });
    const lines = [
      { key: "FOO-1", summary: "one", updated: "a" },
      { key: "FOO-2", summary: "two", updated: "a" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const w = h.orch.createWatcher({ name: "jira", command: "/bin/echo", args: [lines], mode: "loop", driver: "other", prompt: "Dispatch mine to FOO [dummy:project FOO]" });
    const waitForSessions = async (n: number) => {
      const deadline = Date.now() + 5000;
      while (h.orch.listSessions("triage").length < n && Date.now() < deadline) await Bun.sleep(10);
      await h.orch.idle();
    };
    await waitForSessions(1);
    const triage = h.orch.listSessions("triage");
    expect(triage).toHaveLength(1); // one run, one burst, one item
    expect(triage[0]!.driver).toBe("other");
    const prompt = other.calls.find((c) => c.kind === "triage")!.prompt;
    expect(prompt).toContain("## What the human wants (their prompt for this watcher)\nDispatch mine to FOO [dummy:project FOO]");
    expect(prompt).toContain(lines);
    expect(h.orch.listTickets().map((t) => [t.key, t.projectId])).toEqual([["FOO-1", p.id]]); // the prompt's project, with the first key in the output
    expect(h.store.watchers.get(w.id)!.lastRunAt).not.toBeNull();

    // Re-running prints the same text: nothing new is triaged
    await h.orch.runWatcher(w.id);
    await Bun.sleep(200);
    await h.orch.idle();
    expect(h.orch.listSessions("triage").length).toBe(1);

    // Changed output is a new item
    h.orch.updateWatcher(w.id, { args: [lines.replace('"two"', '"two, edited"')] });
    await waitForSessions(2);
    expect(h.orch.listSessions("triage").length).toBe(2);
    await h.orch.stop();
    expect(runner).toBeDefined();
  }, 15_000);
});
