// Watchers end to end: a watcher's command output becomes an Inbox triage session (dummy
// driver) whose prompt carries both the output and the watcher's prompt.
import { afterEach, describe, expect, test } from "bun:test";
import type { Session } from "@harness/shared";
import { DummyDriver } from "../drivers/dummy";
import { makeOrchestrator } from "../testing/fakes";
import { toolsForRun } from "../tools/index";
import { bunSpawn, WatcherRunner, type SpawnFn } from "./watchers";

const PROMPT = "If this event is assigned to me and has actionable next steps, dispatch it to an agent.";
const EVENT = '{"event":"assigned","to":"mark"}';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

function setup(spawn: SpawnFn) {
  const spawned: { cmd: string; args: string[] }[] = [];
  const h = makeOrchestrator({
    drivers: [new DummyDriver({ delayMs: 0 })],
    tools: (kind, driver) => toolsForRun(kind, driver),
    watchers: (handlers) =>
      new WatcherRunner({
        ...handlers,
        shell: "/bin/sh",
        timing: { batchIdleMs: 20, batchMaxMs: 200, restartDelayMs: 60_000, minIntervalMs: 60_000 },
        spawn: (cmd, args, opts) => (spawned.push({ cmd, args }), spawn(cmd, args, opts)),
      }),
  });
  h.orch.updateSettings({ defaultDriver: "dummy" });
  stop = () => h.orch.stop();
  return { ...h, spawned };
}

async function triageSession(h: ReturnType<typeof setup>, timeoutMs = 5000): Promise<Session> {
  const start = Date.now();
  for (;;) {
    const s = h.orch.listSessions("triage")[0];
    if (s) return s;
    if (Date.now() - start > timeoutMs) throw new Error("no triage session");
    await Bun.sleep(10);
  }
}

function firstPrompt(h: ReturnType<typeof setup>, sessionId: string): string {
  const entry = h.orch.transcript(sessionId).find((e) => e.role === "user")!;
  return (entry.content as { text: string }).text;
}

describe("watcher output → Inbox", () => {
  test("a command line's output and the watcher prompt reach one triage session (fake spawn)", async () => {
    const enc = new TextEncoder();
    const h = setup(() => {
      let exit!: (code: number) => void;
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode(`${EVENT}\n`));
            c.close();
            queueMicrotask(() => exit(0));
          },
        }),
        exited: new Promise<number>((r) => (exit = r)),
        kill() {},
      };
    });
    const w = h.orch.createWatcher({ name: "events", command: `echo '${EVENT}'`, prompt: PROMPT, mode: "interval", intervalSec: 3600 });
    const s = await triageSession(h);
    expect(h.spawned[0]).toEqual({ cmd: "/bin/sh", args: ["-lc", `echo '${EVENT}'`] });
    expect(s.title).toBe(EVENT);
    const prompt = firstPrompt(h, s.id);
    expect(prompt).toContain(EVENT);
    expect(prompt).toContain(PROMPT);
    expect(prompt).toContain('New output from watcher "events".');
    await h.orch.idle();
    expect(h.orch.getSession(s.id).triageStatus).toBe("declined"); // the prompt names no project, so the dummy can't route it

    // The same output on the next run is not triaged again.
    await h.orch.runWatcher(w.id);
    await Bun.sleep(100);
    expect(h.orch.listSessions("triage")).toHaveLength(1);
  });

  test("a real /bin/sh -c watcher produces the triage session", async () => {
    const h = setup(bunSpawn);
    h.orch.createWatcher({
      name: "events",
      command: "/bin/sh",
      args: ["-c", `echo '${EVENT}'`],
      prompt: PROMPT,
      mode: "interval",
      intervalSec: 3600,
    });
    const s = await triageSession(h);
    expect(h.spawned[0]).toEqual({ cmd: "/bin/sh", args: ["-c", `echo '${EVENT}'`] }); // legacy args: no extra shell
    const prompt = firstPrompt(h, s.id);
    expect(prompt).toContain(EVENT);
    expect(prompt).toContain(PROMPT);
    await h.orch.idle();
  }, 10_000);
});
