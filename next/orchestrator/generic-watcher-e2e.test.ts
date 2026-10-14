// The headline scenario, end to end with the dummy driver: a work run is asked in plain terms
// for "a watcher that runs this curl loop and dispatches events assigned to me with next steps
// to an agent in SHOP". It creates the watcher (command line + prompt) through the config
// tools, a human approves the card, the loop runs through the login shell, each event lands in
// the Inbox as a triage session carrying the prompt, and triage dispatches or declines it.
// The curl loop is a fake process (next/support/fake-spawn.ts) the test prints the events API's
// responses into, one per loop pass, the way service/src/orchestrator/__fixtures__/events-api.ts does.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session, TranscriptEntry } from "@harness/shared";
import { DummyDriver } from "../../service/src/drivers/dummy";
import { makeOrchestrator } from "../../service/src/testing/fakes";
import { toolsForRun } from "../../service/src/tools/index";
import { EVENTS } from "../../service/src/orchestrator/__fixtures__/events-api";
import { WatcherRunner } from "../../service/src/orchestrator/watchers";
import { type FakeProc, fakeSpawn } from "../support/fake-spawn";
import { afterTest } from "../support/teardown";
import { waitFor } from "../support/wait";

const SHELL = "/bin/zsh";
const PROMPT =
  "If an event is assigned to me (mark) and has actionable next steps, dispatch it to an agent in SHOP; otherwise decline it. " +
  '[dummy:dispatch-if /"assignee":"mark"[^}]*"next_steps":\\[".+?"\\]/] [dummy:project SHOP]';
const curlLoop = (state: string) => `while true; do curl -s "https://events.test/api?since=$(cat ${state})"; sleep 0.5; done`;

function setup() {
  /** Every output the orchestrator has finished handling (deduped or triaged), in order */
  const handled: string[] = [];
  const procs = fakeSpawn();
  const h = makeOrchestrator({
    drivers: [new DummyDriver({ delayMs: 0 })],
    tools: (kind, d) => toolsForRun(kind, d),
    watchers: (handlers) =>
      new WatcherRunner({
        ...handlers,
        onOutput: async (w, output) => {
          await handlers.onOutput(w, output);
          handled.push(output.text);
        },
        spawn: procs.spawn,
        shell: SHELL,
        timing: { batchIdleMs: 5, batchMaxMs: 200, restartDelayMs: 60_000, minIntervalMs: 60_000 },
      }),
  });
  h.orch.updateSettings({ defaultDriver: "dummy" });
  afterTest(() => h.orch.stop());
  const dir = join(h.home, "shop");
  mkdirSync(dir);
  const shop = h.orch.createProject({ path: dir, key: "SHOP", useWorktrees: false });
  const infraDir = join(h.home, "infra");
  mkdirSync(infraDir);
  const infra = h.orch.createProject({ path: infraDir, key: "INFRA", useWorktrees: false });

  /** One loop pass: the API prints the event as a JSON line, and the burst is handled before the next pass. */
  async function respond(proc: FakeProc, event: unknown) {
    const before = handled.length;
    proc.line(event);
    await waitFor(() => handled.length > before, { label: `the output ${JSON.stringify(event).slice(0, 20)}… to be handled` });
  }
  const triage = () => h.orch.listSessions("triage");
  const settled = (n: number) => waitFor(() => triage().length === n && triage().every((s) => s.triageStatus !== "triaging" && !s.busy), { label: `${n} triaged sessions` });
  return { ...h, shop, infra, handled, procs: procs.procs, respond, triage, settled };
}

const firstUserText = (entries: TranscriptEntry[]) => {
  const e = entries.find((x) => x.role === "user");
  return e && e.content.type === "text" ? e.content.text : "";
};

const toolResults = (entries: TranscriptEntry[], name: string) =>
  entries.flatMap((e) => (e.content.type === "tool_result" && e.content.name === name ? [e.content] : []));

describe("generic watcher, end to end", () => {
  test("an agent sets up a curl-loop watcher after approval; its events are triaged by the watcher's prompt", async () => {
    const h = setup();
    const command = curlLoop(join(h.home, "events-state"));
    const calls = [
      { name: "search_tickets", input: { query: "checkout" } },
      { name: "create_watcher", input: { name: "events", command, prompt: PROMPT, mode: "loop" } },
    ];
    const t = await h.orch.createTicket({
      projectId: h.shop.id,
      spec: `Add a watcher that runs this curl loop and dispatches my actionable events to SHOP /tools ${JSON.stringify(calls)}`,
    });
    await h.orch.idle();

    // The config call waits for a human; nothing exists or runs yet
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.pendingApproval).toMatchObject({ toolName: "create_watcher", onceOnly: true });
    expect(cur.pendingApproval!.summary).toContain(`Create watcher "events" (loop): ${command}`);
    expect(h.orch.listWatchers()).toEqual([]);
    expect(h.procs).toEqual([]);
    const searched = toolResults(h.store.transcript.list(t.sessionId), "search_tickets");
    expect(searched.map((r) => r.isError)).toEqual([false]);

    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("review");
    const [w] = h.orch.listWatchers();
    expect(w).toMatchObject({ name: "events", command, args: [], prompt: PROMPT, mode: "loop", enabled: true });

    // The loop runs whole in the login shell
    await waitFor(() => h.procs.length === 1, { label: "the loop to start" });
    const loop = h.procs[0]!;
    expect([loop.cmd, loop.args]).toEqual([SHELL, ["-lc", command]]);

    // Each event becomes its own Inbox session and gets triaged
    for (const e of EVENTS) await h.respond(loop, e);
    await h.settled(3);
    await h.orch.idle();
    const byEvent = new Map<string, Session>();
    for (const s of h.triage()) {
      const text = firstUserText(h.store.transcript.list(s.id));
      const ev = EVENTS.find((e) => text.includes(JSON.stringify(e)));
      expect(ev).toBeDefined(); // the event's text reached the triage prompt, exactly as printed
      expect(text).toContain(PROMPT); // together with the watcher's prompt
      byEvent.set(ev!.id, s);
    }
    expect([...byEvent.keys()].sort()).toEqual(["E1", "E2", "E3"]);
    expect(byEvent.get("E1")!.triageStatus).toBe("dispatched");
    expect(byEvent.get("E2")!.triageStatus).toBe("declined");
    expect(byEvent.get("E3")!.triageStatus).toBe("declined");

    // E1 is a ticket in SHOP (besides the setup ticket); nothing went to INFRA
    const dispatched = h.orch.listTickets().filter((x) => x.key !== t.key);
    expect(dispatched.map((x) => x.projectId)).toEqual([h.shop.id]);
    expect(dispatched[0]!.title.startsWith('{"id":"E1"')).toBe(true); // the Inbox title: the output's first line, shortened
    expect(h.store.watchers.get(w!.id)!.lastError).toBeNull();
    expect(h.store.watchers.get(w!.id)!.lastRunAt).not.toBeNull();

    // The API "forgets" what it sent and re-prints the same events: none are triaged again
    for (const e of EVENTS) await h.respond(loop, e);
    await h.orch.idle();
    expect(h.handled).toHaveLength(6);
    expect(h.triage()).toHaveLength(3);
    expect(loop.killed).toBe(false); // one long-lived loop the whole time
  });

  test("routing lives in the prompt: two watchers on the same events send them to different projects", async () => {
    const h = setup();
    const toInfra = 'Dispatch what is assigned to sam to INFRA. [dummy:dispatch-if /"assignee":"sam"/] [dummy:project INFRA]';
    h.orch.createWatcher({ name: "mine", command: curlLoop("mine-state"), prompt: PROMPT, mode: "loop" });
    h.orch.createWatcher({ name: "sams", command: curlLoop("sams-state"), prompt: toInfra, mode: "loop" });
    await waitFor(() => h.procs.length === 2, { label: "both loops to start" });

    // The same three events reach both watchers
    for (const proc of h.procs) for (const e of EVENTS) await h.respond(proc, e);
    await h.settled(6);
    await h.orch.idle();
    const where = h.orch
      .listTickets()
      .map((t) => [EVENTS.find((e) => t.title.startsWith(`{"id":"${e.id}"`))?.id, t.projectId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // Each prompt picked its own event and project
    expect(where).toEqual([
      ["E1", h.shop.id],
      ["E2", h.infra.id],
    ]);
  });
});
