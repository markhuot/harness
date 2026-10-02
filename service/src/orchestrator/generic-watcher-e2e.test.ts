// The headline scenario, end to end with the dummy driver: a work run is asked in plain terms
// for "a watcher that runs this curl loop and dispatches events assigned to me with next steps
// to an agent in SHOP". It creates the watcher (command line + prompt) through the config
// tools, a human approves the card, the loop runs through the login shell, each event lands in
// the Inbox as a triage session carrying the prompt, and triage dispatches or declines it.
// __fixtures__/events-api.ts stands in for the curl call, so nothing touches the network.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Session, TranscriptEntry } from "@harness/shared";
import { DummyDriver } from "../drivers/dummy";
import { makeOrchestrator } from "../testing/fakes";
import { toolsForRun } from "../tools/index";
import { EVENTS } from "./__fixtures__/events-api";
import { WatcherRunner } from "./watchers";

const FIXTURE = join(import.meta.dir, "__fixtures__", "events-api.ts");
const SHELL = existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
const PROMPT =
  "If an event is assigned to me (mark) and has actionable next steps, dispatch it to an agent in SHOP; otherwise decline it. " +
  '[dummy:dispatch-if /"assignee":"mark"[^}]*"next_steps":\\[".+?"\\]/] [dummy:project SHOP]';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

function setup() {
  const h = makeOrchestrator({
    drivers: [new DummyDriver({ delayMs: 0 })],
    tools: (kind, d) => toolsForRun(kind, d),
    // One event per loop pass, 500ms apart: a 150ms idle flush keeps each in its own Inbox item.
    watchers: (handlers) => new WatcherRunner({ ...handlers, shell: SHELL, timing: { batchIdleMs: 150, batchMaxMs: 2000, restartDelayMs: 60_000, minIntervalMs: 60_000 } }),
  });
  h.orch.updateSettings({ defaultDriver: "dummy" });
  stop = () => h.orch.stop();
  const dir = join(h.home, "shop");
  mkdirSync(dir);
  const shop = h.orch.createProject({ path: dir, key: "SHOP", useWorktrees: false });
  const infra = join(h.home, "infra");
  mkdirSync(infra);
  h.orch.createProject({ path: infra, key: "INFRA", useWorktrees: false });
  return { ...h, shop };
}

async function until(what: string, ok: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
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
    const state = join(h.home, "events-state");
    const command = `while true; do '${process.execPath}' '${FIXTURE}' --state '${state}'; sleep 0.5; done`;
    const calls = [
      { name: "search_tickets", input: { query: "checkout" } },
      { name: "create_watcher", input: { name: "events", command, prompt: PROMPT, mode: "loop" } },
    ];
    const t = await h.orch.createTicket({
      projectId: h.shop.id,
      spec: `Add a watcher that runs this curl loop and dispatches my actionable events to SHOP /tools ${JSON.stringify(calls)}`,
    });
    await h.orch.idle();

    // The config call waits for a human; nothing exists yet
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.pendingApproval).toMatchObject({ toolName: "create_watcher", onceOnly: true });
    expect(cur.pendingApproval!.summary).toContain(`Create watcher "events" (loop): ${command}`);
    expect(h.orch.listWatchers()).toEqual([]);
    const searched = toolResults(h.store.transcript.list(t.sessionId), "search_tickets");
    expect(searched.map((r) => r.isError)).toEqual([false]);

    await h.orch.answerApproval(t.key, { decision: "allow_once" });
    await h.orch.idle();
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("review");
    const [w] = h.orch.listWatchers();
    expect(w).toMatchObject({ name: "events", command, args: [], prompt: PROMPT, mode: "loop", enabled: true });

    // Each event becomes its own Inbox session and gets triaged
    const triage = () => h.orch.listSessions("triage");
    await until("three triaged sessions", () => triage().length === 3 && triage().every((s) => s.triageStatus !== "triaging" && !s.busy));
    await h.orch.idle();
    const byEvent = new Map<string, Session>();
    for (const s of triage()) {
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
    rmSync(state);
    await until("the events to be re-printed", () => existsSync(state) && Bun.file(state).size > 0);
    await Bun.sleep(2500);
    await h.orch.idle();
    expect(triage()).toHaveLength(3);
  }, 60_000);

  test("routing lives in the prompt: two watchers on the same events send them to different projects", async () => {
    const h = setup();
    const infra = h.orch.listProjects().find((p) => p.key === "INFRA")!;
    const loop = (name: string) =>
      `while true; do '${process.execPath}' '${FIXTURE}' --state '${join(h.home, `${name}-state`)}'; sleep 0.5; done`;
    const toInfra = 'Dispatch what is assigned to sam to INFRA. [dummy:dispatch-if /"assignee":"sam"/] [dummy:project INFRA]';
    h.orch.createWatcher({ name: "mine", command: loop("mine"), prompt: PROMPT, mode: "loop" });
    h.orch.createWatcher({ name: "sams", command: loop("sams"), prompt: toInfra, mode: "loop" });

    const triage = () => h.orch.listSessions("triage");
    await until("six triaged sessions", () => triage().length === 6 && triage().every((s) => s.triageStatus !== "triaging" && !s.busy));
    await h.orch.idle();
    const where = h.orch
      .listTickets()
      .map((t) => [EVENTS.find((e) => t.title.startsWith(`{"id":"${e.id}"`))?.id, t.projectId])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // The same three events reached both watchers; each prompt picked its own event and project
    expect(where).toEqual([
      ["E1", h.shop.id],
      ["E2", infra.id],
    ]);
  }, 60_000);

  test("a failing command shows up as the watcher's error, with its stderr", async () => {
    const h = setup();
    const w = h.orch.createWatcher({
      name: "broken",
      command: `'${process.execPath}' '${FIXTURE}' --fail 'events API returned 503'`,
      prompt: PROMPT,
      mode: "interval",
      intervalSec: 3600,
    });
    await until("the watcher's error", () => !!h.store.watchers.get(w.id)!.lastError);
    expect(h.store.watchers.get(w.id)!.lastError).toBe("Command exited with code 2: events API returned 503");
    expect(h.orch.listSessions("triage")).toEqual([]);
  }, 30_000);
});
