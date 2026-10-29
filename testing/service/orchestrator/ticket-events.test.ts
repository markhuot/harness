import { afterEach, expect, test } from "bun:test";
import { executeTool } from "../../../service/src/drivers/types";
import { FakeDriver, gate, replyScript, type Step } from "../fake-driver";
import { ensureHome } from "../../../service/src/config";
import { EventBus } from "../../../service/src/events";
import { Orchestrator } from "../../../service/src/orchestrator/orchestrator";
import { QuietBrowser } from "../../builders/harness";
import { callTools, makeOrchestrator, stopAll, type OrchestratorRig } from "../orchestrator-harness";

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
    // The rows' debounce runs on the service's clock, which only moves when the test says so.
    const poll = setInterval(() => (h.clock.advance(5), seen.length && (clearInterval(poll), resolve())), 5);
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
  // Its target is over, so there is nothing left to wait for: the row is gone and the ticket was submitted.
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
  expect(h.ticket(me.key).status).toBe("review");
});

test("a ticket that subscribed and then went to review keeps the subscription, and the change is delivered once it is in progress again", async () => {
  const { h, other, me, results } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }], ["submit_for_review", { note: "done for now", spec_is_up_to_date: true }]]);
  expect(results[0]).toMatchObject({ isError: false });
  expect(h.ticket(me.key).status).toBe("review");
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(1);
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(wakes(h)).toHaveLength(0);
  expect(h.store.ticketEvents.byTarget("escalated", me.id, "ticket").length).toBeGreaterThan(0);
  h.orch.humanReview(me.key, { decision: "request_changes", notes: "more" });
  await h.settle();
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain(`${other.key} "Other"`);
});

async function doneSubscriber(mode: "once" | "forever", reason?: string) {
  const r = await subscriber((key) => [["subscribe_ticket", { key, mode, reason }]]);
  await r.h.orch.updateTicket(r.me.key, { status: "done" });
  await r.h.settle();
  expect(r.h.ticket(r.me.key).status).toBe("done");
  expect(r.h.store.subscriptions.listBySubscriber(r.me.id)).toHaveLength(1);
  return r;
}

test("a done ticket can subscribe, and the change re-opens it as an automatic re-open that says why it subscribed, then delivers the update", async () => {
  const { h, other, me } = await doneSubscriber("once", "wait for Other to start");
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(h.ticket(me.key).status).not.toBe("done");
  const reopen = h.driver.requests.find((r) => r.prompt.includes("re-opened automatically"))!;
  expect(reopen.prompt).toContain("wait for Other to start");
  expect(reopen.prompt).not.toContain("What the human wants");
  const entry = h.store.activity.listBySession(me.sessionId).find((e) => e.kind === "reopened")!;
  expect(entry.author).toBe("system");
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain(`${other.key} "Other": planning → in_progress`);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
});

test("two changes in a row while the subscriber is done are both delivered, with one re-open", async () => {
  const { h, other, me } = await doneSubscriber("forever");
  await h.orch.updateTicket(other.key, { status: "blocked" });
  await h.orch.updateTicket(other.key, { status: "review" });
  await h.settle();
  expect(h.ticket(me.key).status).not.toBe("done");
  expect(h.driver.requests.filter((r) => r.prompt.includes("re-opened automatically"))).toHaveLength(1);
  // The two moves are collapsed into one change in a single message
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain(`${other.key} "Other": planning → review`);
  // The forever subscription is spent by the re-open: a chatty target can't keep re-opening it.
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
});

test("a re-open that is rejected keeps the change as a waiting row and the subscription", async () => {
  const { h, other, me } = await doneSubscriber("once");
  h.store.tickets.update(me.id, { draft: true });
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(h.ticket(me.key).status).toBe("done");
  expect(h.store.ticketEvents.byTarget("escalated", me.id, "ticket")).toHaveLength(1);
});

test("a subscriber that goes from review to done with a change waiting is re-opened with it", async () => {
  const { h, other, me } = await subscriber((key) => [["subscribe_ticket", { key }], ["submit_for_review", { note: "waiting", spec_is_up_to_date: true }]]);
  expect(h.ticket(me.key).status).toBe("review");
  await h.orch.startTicket(other.key);
  await h.settle();
  expect(h.store.ticketEvents.byTarget("escalated", me.id, "ticket").length).toBeGreaterThan(0);
  await h.orch.updateTicket(me.key, { status: "done" });
  await h.settle();
  expect(h.ticket(me.key).status).not.toBe("done");
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain(`${other.key} "Other": planning → in_progress`);
});

test("a change that fires while the done ticket's chat run is still going re-opens it once that run ends", async () => {
  const { h, other, me } = await subscriber(() => []);
  await h.orch.updateTicket(me.key, { status: "done" });
  await h.settle();
  const release = gate();
  h.driver.script([...callTools([["subscribe_ticket", { key: other.key }]]).steps, { wait: release }, ...replyScript("watching")]);
  await h.orch.sendMessage(me.key, "keep an eye on Other");
  while (!h.store.subscriptions.listBySubscriber(me.id).length) await new Promise((r) => setTimeout(r, 5));
  await h.orch.startTicket(other.key);
  await new Promise((r) => setTimeout(r, 50));
  expect(h.ticket(me.key).status).toBe("done");
  expect(h.store.ticketEvents.byTarget("escalated", me.id, "ticket")).toHaveLength(1);
  release.open();
  await h.settle();
  expect(h.ticket(me.key).status).not.toBe("done");
  expect(wakes(h)).toHaveLength(1);
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

test("stopping a run that was woken by a change doesn't restart the ticket once the backoff passes", async () => {
  const { h, other, me } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }]]);
  const hold = gate();
  // Only the wake's run holds; the other ticket's own run answers at once.
  h.driver.script((req) => (req.prompt.includes("Updates from tickets you subscribed to") ? [{ wait: hold }, ...replyScript("woken")] : replyScript("other")));
  await h.orch.startTicket(other.key);
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => (h.clock.advance(5), wakes(h).length && (clearInterval(poll), resolve())), 5);
  });
  await h.orch.cancelTicket(me.key);
  const before = wakes(h).length;
  h.clock.advance(60_000);
  await h.settle();
  expect(wakes(h)).toHaveLength(before);
  expect(h.store.ticketEvents.byStatus("escalated", undefined, "ticket")).toHaveLength(0);
  expect(h.store.ticketEvents.byStatus("handling", undefined, "ticket")).toHaveLength(0);
});

test("a subscriber is woken at most eight times in a window; the events past that are held, not lost, and arrive together once there is room", async () => {
  const { h, other } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }]]);
  await h.orch.startTicket(other.key);
  await h.settle();
  for (let i = 0; i < 13; i++) {
    await h.orch.updateTicket(other.key, { status: i % 2 === 0 ? "blocked" : "planning" });
    await h.settle();
  }
  expect(wakes(h)).toHaveLength(8);
  // The rows past the cap wait in the table, not in memory.
  expect(h.store.ticketEvents.byStatus("escalated", undefined, "ticket").length).toBeGreaterThan(0);
  // The window passes: the next change wakes it once, with the held changes collapsed to the ticket's latest status.
  h.clock.advance(5 * 60_000 + 1);
  await h.orch.updateTicket(other.key, { status: "review" });
  await h.settle();
  expect(wakes(h)).toHaveLength(9);
  expect(wakes(h)[8]!.prompt).toContain("planning → review");
  expect(wakes(h)[8]!.prompt.match(/^\d+\. /gm)).toHaveLength(1);
  expect(h.store.ticketEvents.byStatus("escalated", undefined, "ticket")).toHaveLength(0);
});

test("a change the subscriber's own tool call set going doesn't hide the target's later change from it", async () => {
  // start_ticket queues the target's run from inside the subscriber's tool call; that run's own moves are the target's.
  const { h, other, results } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }], ["start_ticket", { key }]]);
  expect(results.map((r) => r.isError)).toEqual([false, false]);
  expect(h.ticket(other.key).status).toBe("review");
  // Its start was the subscriber's own doing; the run's submit for review wasn't.
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain("in_progress → review");
});

test("subscribe_ticket refuses a ticket that is done", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  await h.orch.updateTicket(other.key, { status: "done" });
  await h.settle();
  const { steps, results } = callTools([["subscribe_ticket", { key: other.key }]]);
  h.driver.script(steps);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "Me", ...ONE_RUN });
  await h.settle();
  expect(results[0]).toMatchObject({ isError: true });
  expect(results[0]!.text).toMatch(/is done/);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
});

test("a forever subscription ends with its target: the done event wakes the subscriber, the row goes, and the ticket is submitted instead of waiting for good", async () => {
  const { h, other, me } = await subscriber((key) => [["subscribe_ticket", { key, mode: "forever" }]]);
  await h.orch.updateTicket(other.key, { status: "done" });
  await h.settle();
  expect(wakes(h)).toHaveLength(1);
  expect(h.store.subscriptions.listBySubscriber(me.id)).toHaveLength(0);
  expect(h.ticket(me.key).status).toBe("review");
});

test("a subscription event still waiting in the debounce when the run ends is delivered, not left unread behind an auto-submit", async () => {
  const driver = new FakeDriver({ supportsSteering: true });
  const h = makeOrchestrator({ driver, tools: undefined, liveDebounceMs: 60_000 });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  await h.settle();
  const hold = gate();
  const { steps } = callTools([["subscribe_ticket", { key: other.key }]]);
  driver.script([...steps, { wait: hold }, ...replyScript("waiting")]);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "Waiting on other", ...ONE_RUN });
  await driver.runStarted();
  await h.orch.startTicket(other.key);
  // The event is buffered behind the debounce; the run ends before it is pushed.
  hold.open();
  await h.settle();
  expect(wakes(h)).toHaveLength(1);
  expect(wakes(h)[0]!.prompt).toContain(other.key);
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

/** The service restarted: a second orchestrator over the same database, stopped by the test. */
async function restart(h: OrchestratorRig, opts: { liveDebounceMs?: number } = {}) {
  await h.orch.stop();
  const orch = new Orchestrator({
    store: h.store,
    bus: new EventBus(),
    drivers: [h.driver],
    browser: new QuietBrowser(),
    paths: ensureHome(h.home),
    tools: () => [],
    baseUrl: () => "http://127.0.0.1:1",
    watchers: null,
    log: () => {},
    classifier: null,
    reconcileIntervalMs: 0,
    fetchPullRequestTitle: async () => null,
    now: h.clock,
    liveDebounceMs: 0,
    ...opts,
  });
  orch.start();
  const idle = () => orch.idle();
  return { orch, idle, stop: () => orch.stop() };
}

const waitingRows = (h: OrchestratorRig) => h.store.ticketEvents.byStatus("escalated", undefined, "ticket");
const childPrompts = (h: { driver: FakeDriver }) => h.driver.requests.filter((r) => r.prompt.includes("Child ticket updates"));

test("a child's update held behind a parent run that can't take input is a row, and a restart delivers it", async () => {
  const h = makeOrchestrator({ liveDebounceMs: 0 });
  const hold = gate();
  h.driver.script([{ wait: hold }, ...replyScript("parent one")]);
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.driver.runStarted();
  const child = await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, ...ONE_RUN, start: true });
  await h.driver.runStarted(2);
  await Bun.sleep(20);
  // The parent's run can't take the push: the update is a stored row, not a buffer.
  expect(waitingRows(h)).toMatchObject([{ sourceKind: "child", targetId: parent.id, ticketId: child.id, status: "escalated" }]);
  expect(childPrompts(h)).toHaveLength(0);

  // The service goes down and comes back: the row is still there and the parent hears it in one run.
  h.driver.script(replyScript("parent after restart"));
  const again = await restart(h);
  await again.idle();
  expect(childPrompts(h)).toHaveLength(1);
  expect(childPrompts(h)[0]!.prompt).toContain(`${child.key} "Child": in_progress → review`);
  expect(h.store.ticketEvents.byStatus("handled", undefined, "ticket")).toHaveLength(1);
  expect(waitingRows(h)).toHaveLength(0);
  await again.stop();
});

test("rows held over a subscriber's wake cap survive a restart and are delivered once the window has room", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  await h.settle();
  const { steps } = callTools([["subscribe_ticket", { key: other.key, mode: "forever" }]]);
  h.driver.script(steps);
  const me = await h.orch.createTicket({ projectId: h.project.id, spec: "Waiting on other", ...ONE_RUN });
  await h.settle();
  await h.orch.startTicket(other.key);
  await h.settle();
  for (let i = 0; i < 12; i++) {
    await h.orch.updateTicket(other.key, { status: i % 2 === 0 ? "blocked" : "planning" });
    await h.settle();
  }
  await h.orch.updateTicket(other.key, { status: "blocked" });
  await h.settle();
  expect(wakes(h)).toHaveLength(8);
  expect(waitingRows(h).length).toBeGreaterThan(0);
  const held = waitingRows(h).map((e) => e.targetId);
  expect(new Set(held)).toEqual(new Set([me.id]));

  // The cap counts the wakes already made, also after a restart: nothing is delivered yet.
  const again = await restart(h);
  await again.idle();
  expect(wakes(h)).toHaveLength(8);
  expect(waitingRows(h).length).toBeGreaterThan(0);
  // The window passes and the next tick delivers what was held.
  h.clock.advance(5 * 60_000 + 1);
  await (again.orch as unknown as { ticketEvents: { tick(): Promise<void> } }).ticketEvents.tick();
  await again.idle();
  expect(wakes(h)).toHaveLength(9);
  expect(waitingRows(h)).toHaveLength(0);
  await again.stop();
});

test("a chief that subscribes to a ticket it dispatched hears each change once", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.settle();
  const child = await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, start: false });
  h.store.subscriptions.upsert(parent.id, child.id, "forever", ["status", "note"]);
  await h.orch.updateTicket(child.key, { status: "blocked" });
  await h.settle();
  const rows = h.store.ticketEvents.list({ targetId: parent.id, limit: 50 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ sourceKind: "child" });
});

test("the same activity is one row per ticket it wakes, and a parent that also subscribes to the change gets only its child row", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  const watcher = await h.orch.createTicket({ projectId: h.project.id, spec: "Watcher", start: false });
  const child = await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, start: false });
  h.store.subscriptions.upsert(parent.id, child.id, "forever", ["status"]);
  h.store.subscriptions.upsert(watcher.id, child.id, "forever", ["status"]);
  await h.orch.updateTicket(child.key, { status: "blocked" });
  const rows = [parent.id, watcher.id].flatMap((targetId) => h.store.ticketEvents.list({ targetId, limit: 50 }));
  expect(rows.map((e) => [e.targetId, e.sourceKind]).sort()).toEqual(
    [
      [parent.id, "child"],
      [watcher.id, "subscription"],
    ].sort(),
  );
  expect(new Set(rows.map((e) => e.sourceRef)).size).toBe(1);
});

test("a ticket that is done closes its waiting rows as ignored with the reason", async () => {
  const h = makeOrchestrator({ liveDebounceMs: 0 });
  const hold = gate();
  h.driver.script([{ wait: hold }, ...replyScript("parent one")]);
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.driver.runStarted();
  await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, ...ONE_RUN, start: true });
  await h.driver.runStarted(2);
  await Bun.sleep(20);
  expect(waitingRows(h)).toHaveLength(1);
  await h.orch.updateTicket(parent.key, { status: "done" });
  expect(waitingRows(h)).toHaveLength(0);
  expect(h.store.ticketEvents.byStatus("ignored", undefined, "ticket")).toMatchObject([{ targetId: parent.id, reason: `${parent.key} is done` }]);
  hold.open();
  await h.settle();
  expect(childPrompts(h)).toHaveLength(0);
});

test("a non-chief ticket's rows are pushed to clients when they are inserted and when their status changes", async () => {
  const h = makeOrchestrator({ liveDebounceMs: 0 });
  const hold = gate();
  h.driver.script([{ wait: hold }, ...replyScript("parent one")]);
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.driver.runStarted();
  await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, ...ONE_RUN, start: true });
  await h.driver.runStarted(2);
  await Bun.sleep(20);
  const pushed = () => h.events.flatMap((e) => (e.kind === "ticket.event.upserted" && e.event.targetId === parent.id ? [`${e.event.id}:${e.event.status}`] : []));
  const row = waitingRows(h)[0]!;
  expect(pushed()).toContain(`${row.id}:escalated`);
  await h.orch.updateTicket(parent.key, { status: "done" });
  expect(pushed()).toContain(`${row.id}:ignored`);
  hold.open();
  await h.settle();
});

test("a subscription row never reaches a chief's triage, rehoming, Inbox list or badge", async () => {
  const h = makeOrchestrator({ tools: undefined, liveDebounceMs: 0 });
  const cos = h.orch.openCos("all");
  const other = await h.orch.createTicket({ projectId: h.project.id, spec: "Other", start: false });
  const row = h.store.ticketEvents.insert({ cosId: null, targetId: other.id, projectId: h.project.id, ticketId: other.id, sourceKind: "subscription", sourceRef: "a-x", actor: "system", title: "x", ready: true })!;
  const pendingRow = h.store.ticketEvents.insert({ cosId: null, targetId: other.id, projectId: h.project.id, ticketId: other.id, sourceKind: "child", sourceRef: "a-y", actor: "system", title: "y" })!;
  h.orch.cosEngine.rehome();
  await h.orch.cosEngine.tick();
  expect(h.store.ticketEvents.get(row.id)).toMatchObject({ cosId: null, status: "escalated" });
  expect(h.store.ticketEvents.get(pendingRow.id)).toMatchObject({ cosId: null, status: "pending" });
  expect(h.orch.eventsPage(cos.ticketId, {}).items.map((e) => e.id)).not.toContain(row.id);
  expect(h.orch.cosEngine.badge().total).toBe(0);
});

test("a restart with an interrupted parent run starts one run for the held update, not a resumed run and a wake", async () => {
  const h = makeOrchestrator({ liveDebounceMs: 0 });
  const hold = gate();
  h.driver.script([{ wait: hold }, ...replyScript("parent one")]);
  const parent = await h.orch.createTicket({ projectId: h.project.id, spec: "Conduct", kind: "conductor", ...ONE_RUN });
  await h.driver.runStarted();
  await h.orch.createTicket({ projectId: h.project.id, spec: "Child", parentId: parent.key, ...ONE_RUN, start: true });
  await h.driver.runStarted(2);
  await Bun.sleep(20);
  const before = h.driver.requests.length;
  h.driver.script(replyScript("after restart"));
  const again = await restart(h);
  await again.idle();
  expect(h.driver.requests.length - before).toBe(1);
  expect(childPrompts(h)).toHaveLength(1);
  await again.stop();
});
