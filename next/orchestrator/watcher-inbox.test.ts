// Watchers end to end: a watcher's command output becomes an Inbox triage session (dummy
// driver) whose prompt carries both the output and the watcher's prompt. The process is a fake;
// what's checked is the argv the runner hands to spawn and what the orchestrator does with output.

import { describe, expect, test } from "bun:test";
import { DummyDriver } from "../../service/src/drivers/dummy";
import { makeOrchestrator } from "../../service/src/testing/fakes";
import { toolsForRun } from "../../service/src/tools/index";
import { WatcherRunner } from "../../service/src/orchestrator/watchers";
import { fakeSpawn, printAndExit } from "../support/fake-spawn";
import { afterTest } from "../support/teardown";
import { waitFor } from "../support/wait";

const PROMPT = "If this event is assigned to me and has actionable next steps, dispatch it to an agent.";
const EVENT = '{"event":"assigned","to":"mark"}';

function setup() {
  const procs = fakeSpawn(printAndExit(`${EVENT}\n`));
  const handled: string[] = [];
  const h = makeOrchestrator({
    drivers: [new DummyDriver({ delayMs: 0 })],
    tools: (kind, driver) => toolsForRun(kind, driver),
    watchers: (handlers) =>
      new WatcherRunner({
        ...handlers,
        onOutput: async (w, o) => {
          await handlers.onOutput(w, o);
          handled.push(o.text);
        },
        shell: "/bin/sh",
        timing: { batchIdleMs: 5, batchMaxMs: 50, restartDelayMs: 60_000, minIntervalMs: 60_000 },
        spawn: procs.spawn,
      }),
  });
  h.orch.updateSettings({ defaultDriver: "dummy" });
  afterTest(() => h.orch.stop());
  const spawned = () => procs.procs.map((p) => ({ cmd: p.cmd, args: p.args }));
  return { ...h, spawned, handled };
}

async function triageSession(h: ReturnType<typeof setup>) {
  await waitFor(() => h.orch.listSessions("triage").length > 0, { label: "a triage session" });
  return h.orch.listSessions("triage")[0]!;
}

function firstPrompt(h: ReturnType<typeof setup>, sessionId: string): string {
  const entry = h.orch.transcript(sessionId).find((e) => e.role === "user")!;
  return (entry.content as { text: string }).text;
}

describe("watcher output → Inbox", () => {
  test("a command line's output and the watcher prompt reach one triage session; the same output again doesn't", async () => {
    const h = setup();
    const w = h.orch.createWatcher({ name: "events", command: `echo '${EVENT}'`, prompt: PROMPT, mode: "interval", intervalSec: 3600 });
    const s = await triageSession(h);
    expect(h.spawned()).toEqual([{ cmd: "/bin/sh", args: ["-lc", `echo '${EVENT}'`] }]);
    expect(s.title).toBe(EVENT);
    const prompt = firstPrompt(h, s.id);
    expect(prompt).toContain(EVENT);
    expect(prompt).toContain(PROMPT);
    expect(prompt).toContain('New output from watcher "events".');
    await h.orch.idle();
    expect(h.orch.getSession(s.id).triageStatus).toBe("declined"); // the prompt names no project, so the dummy can't route it

    // The same output on the next run is not triaged again.
    await h.orch.runWatcher(w.id);
    await waitFor(() => h.handled.length === 2, { label: "the second run's output to be handled" });
    await h.orch.idle();
    expect(h.spawned()).toHaveLength(2);
    expect(h.orch.listSessions("triage")).toHaveLength(1);
  });
});
