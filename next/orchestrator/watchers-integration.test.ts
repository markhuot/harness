// Watchers through the orchestrator: a watcher's output becomes one triage item with the watcher's
// driver, repeats are deduped, and the watcher list and events carry the process's live state. The
// processes are fakes (next/support/fake-spawn.ts); the runner and orchestrator are the real ones.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeDriver, makeOrchestrator } from "../../service/src/testing/fakes";
import { WatcherRunner } from "../../service/src/orchestrator/watchers";
import { fakeSpawn } from "../support/fake-spawn";
import { waitFor } from "../support/wait";

describe("watchers → triage", () => {
  test("a watcher's output is one triage item with its driver, deduped until it changes", async () => {
    const other = new FakeDriver("other");
    const main = new FakeDriver("fake");
    // A stand-in for /bin/echo: prints its arguments and exits 0
    const echo = fakeSpawn((p) => {
      p.write(p.args.join(" ") + "\n");
      p.exit(0);
    });
    const handled: string[] = [];
    const h = makeOrchestrator({
      driver: main,
      drivers: [main, other],
      watchers: (handlers) =>
        new WatcherRunner({
          ...handlers,
          onOutput: async (w, o) => {
            await handlers.onOutput(w, o);
            handled.push(o.text);
          },
          spawn: echo.spawn,
          timing: { batchIdleMs: 5, batchMaxMs: 20, restartDelayMs: 60_000 },
        }),
    });
    const dir = join(h.home, "foo");
    mkdirSync(dir);
    const p = h.orch.createProject({ path: dir, useWorktrees: false });
    const lines = [
      { key: "FOO-1", summary: "one", updated: "a" },
      { key: "FOO-2", summary: "two", updated: "a" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const w = h.orch.createWatcher({ name: "jira", command: "/bin/echo", args: [lines], mode: "loop", driver: "other", prompt: "Dispatch mine to FOO [dummy:project FOO]" });
    await waitFor(() => h.orch.listSessions("triage").length >= 1, { label: "the first triage session" });
    await h.orch.idle();
    expect(echo.procs.map((x) => [x.cmd, x.args])).toEqual([["/bin/echo", [lines]]]); // legacy args: spawned directly
    const triage = h.orch.listSessions("triage");
    expect(triage).toHaveLength(1); // one run, one burst, one item
    expect(triage[0]!.driver).toBe("other");
    const prompt = other.calls.find((c) => c.kind === "triage")!.prompt;
    expect(prompt).toContain("## What the human wants (their prompt for this watcher)\nDispatch mine to FOO [dummy:project FOO]");
    expect(prompt).toContain(lines);
    expect(h.orch.listTickets().map((t) => [t.key, t.projectId])).toEqual([["FOO-1", p.id]]); // the prompt's project, with the first key in the output
    expect(h.store.watchers.get(w.id)!.lastRunAt).not.toBeNull();

    // Re-running prints the same text: it is handled, and nothing new is triaged
    await h.orch.runWatcher(w.id);
    await waitFor(() => handled.length === 2, { label: "the re-run's output to be handled" });
    await h.orch.idle();
    expect(echo.procs).toHaveLength(2);
    expect(h.orch.listSessions("triage").length).toBe(1);

    // Changed output is a new item
    h.orch.updateWatcher(w.id, { args: [lines.replace('"two"', '"two, edited"')] });
    await waitFor(() => h.orch.listSessions("triage").length >= 2, { label: "the second triage session" });
    await h.orch.idle();
    expect(h.orch.listSessions("triage").length).toBe(2);
    await h.orch.stop();
  });

  test("watcher events and the list carry the process state, live as it changes", async () => {
    const { spawn, procs } = fakeSpawn();
    const h = makeOrchestrator({
      watchers: (handlers) => new WatcherRunner({ ...handlers, spawn, shell: "/bin/sh", timing: { backoffBaseMs: 60_000 } }),
    });
    const seen: string[] = [];
    h.bus.on((e) => {
      if (e.kind === "watcher.upserted") seen.push(`${e.watcher.live?.state ?? "none"}${e.watcher.lastError ? " (error)" : ""}`);
    });
    const w = h.orch.createWatcher({ name: "flaky", command: "sleep 0.2; echo nope >&2; exit 3", mode: "loop" });
    // The create response already knows it is starting up.
    expect(w.live?.state).toBe("waiting");
    await waitFor(() => seen.includes("running"), { label: "the running event" });
    expect(h.orch.listWatchers()[0]!.live?.state).toBe("running");
    procs[0]!.writeErr("nope\n");
    procs[0]!.exit(3);
    await waitFor(() => !!h.orch.listWatchers()[0]!.lastError, { label: "the watcher's error" });
    const [listed] = h.orch.listWatchers();
    expect(listed!.lastError).toBe("Command exited with code 3: nope");
    expect(listed!.live).toMatchObject({ state: "waiting", failures: 1 });
    expect(listed!.live!.nextRunAt).toBeGreaterThan(Date.now() + 50_000);
    expect(seen.at(-1)).toBe("waiting (error)");

    h.orch.updateWatcher(w.id, { enabled: false });
    expect(h.orch.listWatchers()[0]!.live?.state).toBe("stopped");
    expect(seen.at(-1)).toBe("stopped (error)");
    await h.orch.stop();
    expect(procs).toHaveLength(1); // the backoff never came due
  });
});
