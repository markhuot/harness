import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { WatcherRunner } from "./watchers";

describe("watchers → triage", () => {
  test("a real watcher process feeds items that are deduped per watcher and triaged with its driver", async () => {
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
    h.orch.createMapping({ pattern: "FOO", projectId: p.id });
    const lines = [
      { key: "FOO-1", summary: "one", updated: "a" },
      { key: "FOO-1", summary: "one again", updated: "a" }, // duplicate version
      { key: "FOO-2", summary: "two", updated: "a" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const w = h.orch.createWatcher({ name: "jira", command: "/bin/echo", args: [lines], mode: "loop", driver: "other" });
    const deadline = Date.now() + 5000;
    while (h.orch.listSessions("triage").length < 2 && Date.now() < deadline) await Bun.sleep(10);
    await h.orch.idle();
    const triage = h.orch.listSessions("triage");
    expect(triage.map((s) => s.title).sort()).toEqual(["one", "two"]);
    expect(triage.every((s) => s.driver === "other")).toBe(true);
    expect(other.calls.filter((c) => c.kind === "triage").length).toBe(2);
    expect(h.orch.listTickets().map((t) => t.key).sort()).toEqual(["FOO-1", "FOO-2"]);
    expect(h.store.watchers.get(w.id)!.lastRunAt).not.toBeNull();

    // Re-running emits the same items: nothing new is triaged
    await h.orch.runWatcher(w.id);
    await Bun.sleep(200);
    await h.orch.idle();
    expect(h.orch.listSessions("triage").length).toBe(2);
    await h.orch.stop();
    expect(runner).toBeDefined();
  });
});
