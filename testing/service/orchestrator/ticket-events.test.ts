import { afterEach, expect, test } from "bun:test";
import { executeTool } from "../../../service/src/drivers/types";
import { FakeDriver, gate, replyScript, type Step } from "../fake-driver";
import { callTools, makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const ONE_RUN = { skipAgentReview: true } as const;

/** A run that holds open until `release`, collecting what the harness pushes into it. */
function listening(seen: string[], release: ReturnType<typeof gate>): Step[] {
  return [
    {
      run: async (req) => {
        const input = req.input!;
        for (;;) {
          if (!input.pending) await new Promise<void>((resolve) => input.onPush(resolve));
          for (const m of input.take()) {
            seen.push(m.text);
            input.delivered(m.id);
          }
          if (seen.length) return;
        }
      },
    },
    { wait: release },
    ...replyScript("done"),
  ];
}

test("a child's move reaches its parent's run while that run is still going, with no second parent run", async () => {
  const driver = new FakeDriver({ supportsSteering: true });
  const h = makeOrchestrator({ driver, liveDebounceMs: 0 });
  const seen: string[] = [];
  const release = gate();
  driver.script(listening(seen, release));
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await driver.runStarted();
  // The child's run (default reply) submits it for review: one in_progress → review move.
  await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, ...ONE_RUN, start: true });
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => seen.length && (clearInterval(poll), resolve()), 5);
  });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("Child ticket updates");
  expect(seen[0]).toContain("in_progress → review");
  release.open();
  await h.settle();
  // The parent run + the child's run; the update never queued a run of its own.
  expect(driver.requests).toHaveLength(2);
});

test("changes of several children made while the parent's run is going arrive as one message", async () => {
  const driver = new FakeDriver({ supportsSteering: true });
  const h = makeOrchestrator({ driver, liveDebounceMs: 25 });
  const seen: string[] = [];
  const release = gate();
  driver.script(listening(seen, release));
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await driver.runStarted();
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "Child A", parentId: parent.key, ...ONE_RUN, start: true });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "Child B", parentId: parent.key, ...ONE_RUN, start: true });
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => seen.length && (clearInterval(poll), resolve()), 5);
  });
  release.open();
  await h.settle();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain(a.key);
  expect(seen[0]).toContain(b.key);
});

test("a driver that can't take input leaves the update buffered, and it runs as the parent's next run", async () => {
  const h = makeOrchestrator({ liveDebounceMs: 0 });
  const hold = gate();
  h.driver.script([{ wait: hold }, ...replyScript("parent one")]);
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.driver.runStarted();
  await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, ...ONE_RUN, start: true });
  // The child's run is the second request; wait for it to finish before letting the parent go.
  await h.driver.runStarted(2);
  hold.open();
  await h.settle();
  const updates = h.driver.requests.filter((r) => r.prompt.includes("Child ticket updates"));
  expect(updates).toHaveLength(1);
  expect(h.driver.requests.indexOf(updates[0]!)).toBeGreaterThan(1);
});

/** A work ticket that subscribes to OTHER (in planning) as its run's calls say, then ends its turn. */
async function subscriber(calls: (otherKey: string) => [string, unknown][], opts: { driver?: FakeDriver } = {}) {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  await h.settle();
  const { steps, results } = callTools(calls(other.key));
  h.driver.script(steps);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "Waiting on other", ...ONE_RUN });
  await h.settle();
  return { h, other, me, results, opts };
}

const wakes = (h: { driver: FakeDriver }) => h.driver.requests.filter((r) => r.prompt.includes("Updates from tickets you subscribed to"));

test("a once subscription wakes the ticket for the first change, then is gone; the ticket stays in progress until then", async () => {
  const { h, other, me, results } = await subscriber((key) => [["subscribe_ticket", { key }]]);
  expect(results[0]).toMatchObject({ isError: false });
  // It ended its turn but wasn't auto-submitted: it is waiting.
  expect(h.ticket(me.key).status).toBe("in_progress");
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(1);
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain(`${other.key} "Other": planning → in_progress`);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
});

test("a forever subscription keeps waking the ticket", async () => {
  const { h, other, me } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }]]);
  await h.orch.startTicket(other.key);
  await h.settle();
  await h.orch.updateTicket(other.key, { status: "blocked" });
  await h.settle();
  // It started, its run submitted it for review, then it was blocked: three moves, three wakes.
  expect(wakes(h).map((r) => /: (\w+) → (\w+)/.exec(r.prompt)!.slice(1).join(">"))).toEqual(["planning>in_progress", "in_progress>review", "review>blocked"]);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(1);
});

test("a change the subscriber makes itself doesn't wake it", async () => {
  const { h, me, other, results } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }], ["move_ticket", { key, status: "done" }]]);
  expect(results.map((r) => r.isError)).toEqual([false, false]);
  expect(h.ticket(other.key).status).toBe("done");
  expect(wakes(h)).toHaveLength(0);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(1);
});

test("only the events a subscription asked for wake the ticket", async () => {
  const { h, other } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever", events: ["spec"] }]]);
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(wakes(h)).toHaveLength(0);
});

test("a subscription is dropped when its subscriber's run is cancelled, so an event doesn't restart it", async () => {
  const { h, other, me } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }]]);
  await h.orch.cancelTicket(me.key);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(wakes(h)).toHaveLength(0);
});

test("two tickets can't keep each other awake forever: a subscriber is woken at most eight times in a window", async () => {
  const { h, other } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }]]);
  await h.orch.startTicket(other.key);
  await h.settle();
  for (let i = 0; i < 12; i++) {
    await h.orch.updateTicket(other.key, { status: i % 2 === 0 ? "blocked" : "planning" });
    await h.settle();
  }
  expect(wakes(h)).toHaveLength(8);
  expect(h.logs.some((l) => l.includes("subscription wake dropped"))).toBe(true);
  // The window passes: it can be woken again.
  h.clock.advance(5 * 60_000 + 1);
  await h.orch.updateTicket(other.key, { status: "blocked" });
  await h.settle();
  expect(wakes(h)).toHaveLength(9);
});

test("subscribe_ticket refuses your own ticket, a redundant child status subscription, bad modes and unknown tickets; list and unsubscribe round-trip", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  await h.settle();
  const { steps, results } = callTools([
    ["subscribe_ticket", { key: "ACME-2" }],
    ["subscribe_ticket", { key: other.key, mode: "sometimes" }],
    ["subscribe_ticket", { key: "NOPE-1" }],
    ["subscribe_ticket", { key: other.key, events: ["note", "spec"] }],
    ["list_subscriptions", {}],
    ["unsubscribe_ticket", { key: other.key }],
    ["unsubscribe_ticket", { key: other.key }],
    ["list_subscriptions", {}],
  ]);
  h.driver.script(steps);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "Me", ...ONE_RUN });
  await h.settle();
  expect(me.key).toBe("ACME-2");
  expect(results[0]!.text).toMatch(/your own ticket/);
  expect(results[1]!.text).toMatch(/Invalid input.*mode/);
  expect(results[2]!.text).toMatch(/Unknown ticket: NOPE-1/);
  expect(results[3]).toMatchObject({ isError: false });
  expect(JSON.parse(results[4]!.text)).toEqual([expect.objectContaining({ key: other.key, mode: "once", events: ["note", "spec"], status: "planning" })]);
  expect(results[5]!.text).toBe(`Unsubscribed from ${other.key}.`);
  expect(results[6]!.text).toBe(`You weren't subscribed to ${other.key}.`);
  expect(results[7]!.text).toBe("You have no subscriptions.");
});

test("a conductor following its own child's status is told it already is woken for those", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const hold = gate();
  // The conductor's run waits until its child exists, so it ends with a child unfinished and stays in progress.
  const results: { text: string; isError: boolean }[] = [];
  h.driver.script([
    { wait: hold },
    {
      run: async (req) => {
        const child = h.store.tickets.list({}).find((t) => t.parentId)!;
        for (const input of [{ key: child.key }, { key: child.key, events: ["note"] }]) {
          const r = await executeTool(req.tools, "subscribe_ticket", input, req.toolContext);
          results.push({ text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""), isError: !!r.isError });
        }
      },
    },
    ...replyScript("waiting"),
  ]);
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.driver.runStarted();
  await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, start: false });
  hold.open();
  await h.settle();
  expect(results[0]!.isError).toBe(true);
  expect(results[0]!.text).toMatch(/already wake you/);
  expect(results[1]!.isError).toBe(false);
});
