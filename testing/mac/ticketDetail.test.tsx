import { describe, expect, test } from "bun:test";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { all, click, edited, mount, text } from "./render";

const detail = (key: string, tab: "spec" | "activity" | "transcript" | "details" | "events" = "spec") => <TicketDetail paneId="p1" ticketKey={key} tab={tab} zoomed={false} />;
const buttons = (m: { container: HTMLElement }) => all(m.container, "button").map((b) => text(b));

const tabs = (m: { container: HTMLElement }) => all(m.container, "[role=tab]").map((t) => t.dataset.tab ?? t.dataset.pluginTab);
const eventRows = (m: { container: HTMLElement }) => all(m.container, '[data-testid="cos-event"]');

describe("TicketDetail Events tab", () => {
  test("a ticket with no events has no Events tab, and asking for it opens the Spec", async () => {
    const m = await mount(detail("HARNESS-2", "events"));
    await m.until("loads", () => text(m.container).includes("Fix socket reconnect after sleep"));
    expect(tabs(m)).not.toContain("events");
    expect(all(m.container, '[data-tab="spec"]')[0]!.getAttribute("aria-selected")).toBe("true");
    expect(m.client.requests.some((r) => r.endsWith("/events") || r.includes("/events?"))).toBe(false);
  });

  test("a ticket with events shows them, newest first, with what kind each is and no Escalate button", async () => {
    const m = await mount(detail("HARNESS-8", "events"));
    await m.until("the events", () => eventRows(m).length > 0);
    expect(tabs(m)).toContain("events");
    expect(m.client.requests).toContain("GET /tickets/ticket-HARNESS-8/events?limit=50");
    expect(eventRows(m).map((e) => e.dataset.event)).toEqual(["ev-child", "ev-subscription"]);
    expect(text(eventRows(m)[0])).toContain("Child");
    expect(text(eventRows(m)[0])).toContain("HARNESS-9 moved to review");
    expect(text(eventRows(m)[1])).toContain("Subscription");
    // Nobody triages these: they wait for delivery instead of for a verdict.
    expect(text(eventRows(m)[1])).toContain("Queued for the ticket");
    expect(all(m.container, '[data-testid="cos-escalate"]')).toHaveLength(0);
    expect(all(m.container, '[data-testid="cos-listen"]')).toHaveLength(0);
  });

  test("rows the chief's rules dropped and rows aimed at other tickets stay out", async () => {
    const world = edited((w) => {
      const base = w.ticketEvents.find((e) => e.id === "ev-child")!;
      w.ticketEvents.push({ ...base, id: "ev-dropped", verdict: "filtered", status: "ignored" }, { ...base, id: "ev-elsewhere", targetId: "ticket-HARNESS-9" });
    });
    const m = await mount(detail("HARNESS-8", "events"), { world });
    await m.until("the events", () => eventRows(m).length > 0);
    expect(eventRows(m).map((e) => e.dataset.event)).toEqual(["ev-child", "ev-subscription"]);
  });

  test("a live event appears in the open tab", async () => {
    const m = await mount(detail("HARNESS-8", "events"));
    await m.until("the events", () => eventRows(m).length > 0);
    const base = m.client.world.ticketEvents.find((e) => e.id === "ev-child")!;
    await m.settle(() => m.client.push({ kind: "ticket.event.upserted", event: { ...base, id: "ev-live", title: "HARNESS-10 started", createdAt: base.createdAt + 1 } }));
    expect(eventRows(m)[0]!.dataset.event).toBe("ev-live");
  });

  test("when pruning leaves the ticket with no events the tab goes and the Spec opens", async () => {
    const m = await mount(detail("HARNESS-8", "events"));
    await m.until("the events", () => eventRows(m).length > 0);
    const ticket = m.client.world.tickets.find((t) => t.key === "HARNESS-8")!;
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...ticket, hasEvents: false } }));
    expect(tabs(m)).not.toContain("events");
    expect(all(m.container, '[data-tab="spec"]')[0]!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("TicketDetail", () => {
  test("a ticket in review whose agent review passed offers approve and request changes", async () => {
    const m = await mount(detail("HARNESS-5"));
    await m.until("the ticket loads", () => text(m.container).includes("Speed up the board"));
    expect(buttons(m)).toContain("Approve and merge");
    expect(buttons(m)).toContain("Request changes");
    expect(buttons(m)).not.toContain("Start work");
    expect(m.client.unrouted).toEqual([]);
  });

  test("a planning ticket offers to start; a done one offers to re-open and nothing else", async () => {
    const planning = await mount(detail("HARNESS-1"));
    await planning.until("loads", () => text(planning.container).includes("Draft the release notes"));
    expect(buttons(planning)).toContain("Start work");
    expect(buttons(planning)).not.toContain("Re-open");
    planning.unmount();

    const done = await mount(detail("HARNESS-7"));
    await done.until("loads", () => text(done.container).includes("Rename project keys"));
    expect(buttons(done)).toContain("Re-open");
    expect(buttons(done)).not.toContain("Start work");
    expect(buttons(done).some((b) => b.startsWith("Approve"))).toBe(false);
  });

  test("a blocked ticket offers Unblock; its dialog sends the notes, which are optional", async () => {
    const m = await mount(detail("HARNESS-4"));
    await m.until("loads", () => text(m.container).includes("Choose a storage backend"));
    expect(buttons(m)).toContain("Unblock");
    await click(m, all(m.container, "button").find((b) => text(b) === "Unblock")!);
    const dialog = all(document.body, ".modal-foot button").find((b) => text(b).startsWith("Unblock"))!;
    expect(dialog.hasAttribute("disabled")).toBe(false);
    await click(m, dialog);
    expect(m.client.requests).toContain("POST /tickets/HARNESS-4/unblock");
  });

  test("a blocked ticket with a restart time or a pending approval offers no Unblock", async () => {
    const timed = await mount(detail("HARNESS-4"), { world: edited((w) => void (w.tickets.find((t) => t.key === "HARNESS-4")!.resumeAt = world.now + 60_000)) });
    await timed.until("loads", () => text(timed.container).includes("Choose a storage backend"));
    expect(buttons(timed)).not.toContain("Unblock");
    expect(all(timed.container, "[data-testid=restart-waiting]")).toHaveLength(1);
    timed.unmount();

    const approval = await mount(detail("WEB-2"));
    await approval.until("the approval", () => text(approval.container).includes("The agent wants to use Bash"));
    expect(buttons(approval)).not.toContain("Unblock");
  });

  test("an approved review shows what it waits on instead of an empty row", async () => {
    const standIn = async (patch: Record<string, unknown>) => {
      const m = await mount(detail("HARNESS-5"), { world: edited((w) => void Object.assign(w.tickets.find((t) => t.key === "HARNESS-5")!, { humanReview: "approved", ...patch })) });
      await m.until("loads", () => text(m.container).includes("Speed up the board"));
      const found = text(all(m.container, "[data-testid=approved-stand-in]")[0]);
      expect(buttons(m).some((b) => b.startsWith("Approve"))).toBe(false);
      m.unmount();
      return found;
    };
    expect(await standIn({ agentReview: "pending", busy: true })).toBe("Waiting on agent review");
    expect(await standIn({ agentReview: "approved", completing: true, busy: true })).toBe("Moving to done…");
    expect(await standIn({ agentReview: "approved" })).toBe("Moving to done…");
    expect(await standIn({ agentReview: "changes_requested" })).toBe("Agent review needed");
  });

  test("the More menu offers Cancel auto start on a queued planning ticket and Withdraw approval on an approved review, each calling its endpoint", async () => {
    const { FakeClient } = await import("./fakeClient");
    const moreItems = async (m: Awaited<ReturnType<typeof mount>>) => {
      await click(m, m.container.querySelector("[data-testid=ticket-more]")!);
      return all(document.body, "[role=menuitem]");
    };

    const queued = new FakeClient(edited((w) => void Object.assign(w.tickets.find((t) => t.key === "HARNESS-1")!, { autoStart: true })));
    queued.overrides.set("POST /tickets/HARNESS-1/cancel-start", () => queued.world.tickets.find((t) => t.key === "HARNESS-1"));
    const planning = await mount(detail("HARNESS-1"), { client: queued });
    await planning.until("loads", () => text(planning.container).includes("Draft the release notes"));
    const cancel = (await moreItems(planning)).find((i) => text(i) === "Cancel auto start")!;
    expect(cancel).toBeDefined();
    await click(planning, cancel);
    expect(queued.requests).toContain("POST /tickets/HARNESS-1/cancel-start");
    planning.unmount();

    const approved = new FakeClient(edited((w) => void Object.assign(w.tickets.find((t) => t.key === "HARNESS-5")!, { humanReview: "approved", agentReview: "pending", busy: true })));
    approved.overrides.set("POST /tickets/HARNESS-5/withdraw-approval", () => approved.world.tickets.find((t) => t.key === "HARNESS-5"));
    const review = await mount(detail("HARNESS-5"), { client: approved });
    await review.until("loads", () => text(review.container).includes("Speed up the board"));
    const withdraw = (await moreItems(review)).find((i) => text(i) === "Withdraw approval")!;
    expect(withdraw).toBeDefined();
    await click(review, withdraw);
    expect(approved.requests).toContain("POST /tickets/HARNESS-5/withdraw-approval");
    review.unmount();

    // Once the complete run has started the item is gone.
    const completing = await mount(detail("HARNESS-5"), { world: edited((w) => void Object.assign(w.tickets.find((t) => t.key === "HARNESS-5")!, { humanReview: "approved", agentReview: "approved" })) });
    await completing.until("loads", () => text(completing.container).includes("Speed up the board"));
    expect((await moreItems(completing)).map((i) => text(i))).not.toContain("Withdraw approval");
  });

  test("a pending tool approval shows what the agent wants to run and the ways to answer", async () => {
    const m = await mount(detail("WEB-2"));
    await m.until("the approval", () => text(m.container).includes("The agent wants to use Bash"));
    expect(text(m.container)).toContain("npm install sharp");
    expect(text(m.container)).toContain("Installs a package");
    expect(buttons(m)).toEqual(expect.arrayContaining(["Allow once", "Deny…"]));
  });

  test("a conductor shows its children in a tab with their count", async () => {
    const m = await mount(detail("HARNESS-8"));
    await m.until("loads", () => text(m.container).includes("Ship the iPad layout"));
    expect(buttons(m).find((b) => b.startsWith("Tickets"))).toBe("Tickets2");
  });

  test("on the Tickets tab a child's ref is its own element before the title row, not inside it", async () => {
    const m = await mount(<TicketDetail paneId="p1" ticketKey="HARNESS-8" tab={"children" as never} zoomed={false} />);
    await m.until("the children", () => all(m.container, ".child-row").length === 2);
    for (const row of all(m.container, ".child-row")) {
      const main = row.querySelector(".child-main")!;
      const key = main.querySelector(":scope > .child-key")!;
      const top = main.querySelector(":scope > .child-top")!;
      expect(key.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(top.contains(key)).toBe(false);
      expect(text(top)).not.toContain(text(key));
    }
  });

  test("the activity tab lists the ticket's entries in order, with their authors' words", async () => {
    const m = await mount(detail("HARNESS-5", "activity"));
    await m.until("activity", () => text(m.container).includes("Submitted for review"));
    const body = text(m.container);
    expect(body.indexOf("Submitted for review")).toBeLessThan(body.indexOf("Review approved"));
    expect(body).toContain("Cached the first page of tickets");
  });

  test("an activity entry the service pushes appears without a reload", async () => {
    const m = await mount(detail("HARNESS-5", "activity"));
    await m.until("activity", () => text(m.container).includes("Review approved"));
    const t = world.tickets.find((x) => x.key === "HARNESS-5")!;
    await m.settle(() =>
      m.client.push({
        kind: "activity.added",
        entry: { id: "act-new", sessionId: t.sessionId, ticketId: t.id, kind: "note", author: "human", body: "Looks good to me", meta: {}, createdAt: world.now },
      }),
    );
    expect(text(m.container)).toContain("Looks good to me");
  });

  test("the transcript renders each kind of entry: your message, thinking, tool calls, errors", async () => {
    const m = await mount(detail("HARNESS-2", "transcript"));
    await m.until("transcript", () => text(m.container).includes("laptop sleeps"));
    const body = text(m.container);
    expect(body).toContain("You");
    expect(body).toContain("Thinking");
    expect(body).toContain("The test run reported failures");
    // The tool call and its result collapse into one row named for the tool.
    expect(all(m.container, "*").filter((e) => e.children.length === 0 && text(e) === "Read").length).toBeGreaterThan(0);
  });

  test("a tool's screenshot opens in the lightbox, stepping through that result's images", async () => {
    const png = (b: string) => ({ type: "image" as const, data: b, mimeType: "image/png" });
    const m = await mount(detail("HARNESS-2", "transcript"), {
      world: edited((w) => {
        const call = w.transcript.find((e) => e.id === "tr-4")!;
        w.transcript.push(
          { ...call, id: "tr-20", seq: 20, content: { type: "tool_call", callId: "call-shot", name: "screenshot", input: {} } },
          { ...call, id: "tr-21", seq: 21, content: { type: "tool_result", callId: "call-shot", name: "screenshot", output: [png("AAAA"), { type: "text", text: "two tabs" }, png("BBBB")], isError: false } },
        );
      }),
    });
    await m.until("transcript", () => text(m.container).includes("laptop sleeps"));
    await click(m, all(m.container, ".t-tool-head").find((b) => text(b).startsWith("screenshot"))!);
    await click(m, all(m.container, "button").find((b) => b.getAttribute("aria-label") === "Open screenshot output 2")!);
    const shown = () => all(document.body, ".lightbox-stage img")[0]?.getAttribute("src");
    expect(shown()).toBe("data:image/png;base64,BBBB");
    expect(text(all(document.body, ".lightbox-bar")[0])).toContain("2 / 2");
    await m.settle(() => void dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" })));
    expect(shown()).toBe("data:image/png;base64,AAAA");
    expect(text(all(document.body, ".lightbox-name")[0])).toBe("screenshot output 1");
    expect(m.client.unrouted).toEqual([]);
  });

  test("a transcript entry pushed during a run is appended below the others", async () => {
    const m = await mount(detail("HARNESS-2", "transcript"));
    await m.until("transcript", () => text(m.container).includes("laptop sleeps"));
    const t = world.tickets.find((x) => x.key === "HARNESS-2")!;
    await m.settle(() =>
      m.client.push({ kind: "transcript.appended", entry: { id: "tr-10", sessionId: t.sessionId, runId: "run-HARNESS-2-work", seq: 10, role: "assistant", content: { type: "text", text: "Fixed: the ping timeout now reconnects." }, createdAt: world.now } }),
    );
    expect(text(m.container)).toContain("Fixed: the ping timeout now reconnects.");
  });

  test("a ticket that doesn't exist says so instead of rendering a blank pane", async () => {
    const m = await mount(detail("NOPE-9"));
    await m.until("not found", () => text(m.container).includes("NOPE-9 not found"));
    expect(text(m.container)).toContain("It may have been deleted.");
    expect(buttons(m)).not.toContain("Start work");
  });
});
