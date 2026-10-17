import { afterEach, expect, test } from "bun:test";
import type { Project, Ticket, TranscriptEntry } from "@harness/shared";
import { gate } from "../service/fake-driver";
import { boot, stopRigs } from "./boot";

afterEach(stopRigs);

// What a reconnecting client can rely on today: a new socket gets `welcome` and every event from then
// on, and `GET /sessions/:id/transcript?after=<seq>` returns what the session wrote while it was away.
// /ws has no replay: board and ticket events sent while a socket was down are not resent, so a client
// refetches those lists after reconnecting. That is a known product limit, not something tested as a guarantee.

const assistantText = (e: TranscriptEntry) => e.role === "assistant" && e.content.type === "text";

test("a client that drops mid-run catches up with ?after=<last seq>: exclusive, no gap, no duplicate", async () => {
  const rig = await boot();
  const release = gate();
  rig.driver.script([{ type: "text", text: "before the drop" }, { wait: release }, { type: "text", text: "while away" }, { type: "text", text: "also while away" }]);
  const first = await rig.socket();
  const project = await rig.project();
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Say hi", skipAgentReview: true });

  const dropped = await first.event("transcript.appended", (e) => e.entry.role === "assistant" && e.entry.content.type === "text");
  const seen = first.events().flatMap((e) => (e.kind === "transcript.appended" && e.entry.sessionId === ticket.sessionId ? [e.entry.seq] : []));
  first.close();
  await first.waitClosed();

  release.open();
  await rig.busEvent((e) => e.kind === "ticket.upserted" && e.ticket.status === "review");

  const missed = await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=${dropped.entry.seq}`);
  expect(missed.every((e) => e.seq > dropped.entry.seq)).toBe(true);
  expect(missed.filter(assistantText).map((e) => (e.content as { text: string }).text)).toEqual(["while away", "also while away"]);

  const whole = await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript`);
  const caughtUp = [...seen, ...missed.map((e) => e.seq)];
  expect(caughtUp).toEqual(whole.map((e) => e.seq));
  expect(caughtUp).toEqual(caughtUp.map((_, i) => i + 1));
});

test("?after is exclusive at the last entry, and a value that isn't a number reads as 0", async () => {
  const rig = await boot();
  const ws = await rig.socket();
  const project = await rig.project();
  const ticket = await rig.ok<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Say hi", skipAgentReview: true });
  await ws.next((m) => m.type === "event" && m.event.kind === "ticket.upserted" && m.event.ticket.status === "review");
  const whole = await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript`);
  const last = whole.at(-1)!.seq;
  expect(await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=${last}`)).toEqual([]);
  expect((await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=${last - 1}`)).map((e) => e.seq)).toEqual([last]);
  expect(await rig.ok<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=abc`)).toEqual(whole);
});

test("a reconnected socket is welcomed and receives later events, and the dropped one never sees them", async () => {
  const rig = await boot();
  const first = await rig.socket();
  first.close();
  await first.waitClosed();
  const second = await rig.socket();
  expect(second.messages[0]).toMatchObject({ type: "welcome" });

  const project = await rig.project();
  const renamed = await rig.ok<Project>("PATCH", `/projects/${project.id}`, { name: "After" });
  const event = await second.event("project.upserted", (e) => e.project.name === "After");
  expect(event.project.id).toBe(renamed.id);
  expect(first.events()).toEqual([]);
});

test("many reconnects in a row leave one working socket each time (no stale listener doubles the events)", async () => {
  const rig = await boot();
  // Count the bus subscriptions that are live: a closed socket must hand its own back.
  const bus = rig.harness.bus;
  const subscribe = bus.on.bind(bus);
  let live = 0;
  let released: (() => void)[] = [];
  bus.on = (listener) => {
    live++;
    const off = subscribe(listener);
    return () => {
      live--;
      off();
      for (const wake of released.splice(0)) wake();
    };
  };
  for (let i = 0; i < 5; i++) {
    const ws = await rig.socket();
    expect(live).toBe(1);
    ws.close();
    while (live > 0) await new Promise<void>((resolve) => released.push(resolve));
  }
  const last = await rig.socket();
  const project = await rig.project();
  await rig.ok("PATCH", `/projects/${project.id}`, { name: "Once" });
  await last.event("project.upserted", (e) => e.project.name === "Once");
  await rig.ok("PATCH", "/settings", { maxConcurrentRuns: 9 });
  await last.event("settings.updated");
  expect(last.events().filter((e) => e.kind === "project.upserted" && e.project.name === "Once")).toHaveLength(1);
});
