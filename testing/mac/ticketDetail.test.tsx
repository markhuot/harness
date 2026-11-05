import { afterEach, describe, expect, test } from "bun:test";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { all, click, edited, mount, text, type } from "./render";

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

  test("a blocked ticket has no Unblock: its question shows in the composer's Needs you panel, outside the spec, and a sent message answers it", async () => {
    const m = await mount(detail("HARNESS-4"));
    await m.until("the callout", () => all(m.container, "[data-testid=blocked-callout]").length === 1);
    expect(buttons(m).some((b) => b.includes("Unblock"))).toBe(false);
    const callout = all(m.container, "[data-testid=blocked-callout]")[0]!;
    expect(text(callout)).toContain("Postgres or SQLite for the hosted tier?");
    expect(callout.closest("[data-testid=composer] [data-testid=needs-you]")).not.toBeNull();
    expect(callout.closest(".spec-body")).toBeNull();
    expect(all(m.container, "[data-testid=spec-doc]").every((d) => !text(d).includes("Postgres or SQLite"))).toBe(true);
    const input = all(m.container, "[data-testid=composer] textarea.composer-input").at(-1) as HTMLTextAreaElement;
    expect(input.placeholder).toBe("Answer the block: your message goes to the agent…");
    await type(m, input, "SQLite");
    await click(m, all(m.container, "[data-testid=composer-send]")[0]!);
    expect(m.client.bodies.filter((b) => b.request === "POST /tickets/HARNESS-4/messages").map((b) => b.body)).toEqual([{ text: "SQLite" }]);
    expect(m.client.requests.some((r) => r.includes("/unblock"))).toBe(false);
  });

  test("the callout is absent unless blocked, and a long question is clamped until Show all", async () => {
    const review = await mount(detail("HARNESS-5"));
    await review.until("loads", () => text(review.container).includes("Speed up the board"));
    expect(all(review.container, "[data-testid=blocked-callout]")).toHaveLength(0);
    review.unmount();

    const long = "Which one?\n\n" + "A very long option. ".repeat(60);
    const m = await mount(detail("HARNESS-4"), { world: edited((w) => void (w.tickets.find((t) => t.key === "HARNESS-4")!.blockedReason = long)) });
    await m.until("the callout", () => all(m.container, "[data-testid=blocked-callout]").length === 1);
    expect(all(m.container, ".blocked-callout-body.is-clamped")).toHaveLength(1);
    await click(m, all(m.container, ".blocked-callout button").find((b) => text(b) === "Show all")!);
    expect(all(m.container, ".blocked-callout-body.is-clamped")).toHaveLength(0);
  });

  test("a restart time shows in the callout", async () => {
    const m = await mount(detail("HARNESS-4"), { world: edited((w) => void (w.tickets.find((t) => t.key === "HARNESS-4")!.resumeAt = world.now + 60_000)) });
    await m.until("the callout", () => all(m.container, "[data-testid=blocked-callout]").length === 1);
    expect(all(m.container, "[data-testid=blocked-callout]")[0]!.getAttribute("data-kind")).toBe("restart");
    expect(all(m.container, "[data-testid=restart-waiting]")).toHaveLength(1);
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

describe("Needs you: the spec's open questions above the composer", () => {
  // A question beside the plan step it affects counts as much as one under Open questions.
  const SPEC = "# Pick a cache\n\n## Plan\n\n1. Pick the store\n   - [ ] Which database?\n\n## Open questions\n\n- [x] Which port?\n- [ ] Ship when?\n";
  /** HARNESS-1 (planning) with open questions in its spec and a reply drafted under "Which database?". */
  const withQuestions = edited((w) => {
    const t = w.tickets.find((x) => x.key === "HARNESS-1")!;
    t.spec = SPEC;
    t.openQuestionCount = 2;
    t.messageDraft = { text: "", attachments: [], questionReplies: [{ question: "Which database?", body: "Postgres" }], origin: null, updatedAt: w.now };
    w.details["HARNESS-1"]!.ticket = t;
  });
  const questions = (m: { container: HTMLElement }) => all(m.container, "[data-testid=needs-you-question]");
  const reply = (q: HTMLElement) => all(q, "[data-testid=needs-you-reply]")[0] as HTMLTextAreaElement;

  test("lists each unchecked question with one reply box holding its draft; checked ones fold into N answered; the spec keeps its checkboxes", async () => {
    const m = await mount(detail("HARNESS-1"), { world: withQuestions });
    await m.until("the panel", () => questions(m).length === 2);
    expect(questions(m).map((q) => text(all(q, ".needs-you-q-text")[0]!))).toEqual(["Which database?", "Ship when?"]);
    expect(questions(m).map((q) => all(q, "textarea").length)).toEqual([1, 1]);
    expect(questions(m).map((q) => reply(q).value)).toEqual(["Postgres", ""]);
    expect(text(all(m.container, "[data-testid=needs-you-answered] summary")[0]!)).toBe("1 answered");
    expect(text(all(m.container, "[data-testid=needs-you]")[0]!)).toContain("Needs you · 2");
    // The spec keeps its task items, as read-only checkboxes, and no answer boxes of its own.
    expect(all(m.container, ".spec-doc [data-testid=needs-you-reply]")).toHaveLength(0);
    const boxes = all(m.container, ".spec-body [data-testid=md-task-box]") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
  });

  test("Send posts every open question's reply as one message, and the replies stay in their boxes to send again", async () => {
    const m = await mount(detail("HARNESS-1"), { world: withQuestions });
    await m.until("the panel", () => questions(m).length === 2);
    const kept = [{ question: "Which database?", body: "Postgres" }, { question: "Ship when?", body: "Next Friday" }];
    m.client.overrides.set("POST /tickets/HARNESS-1/messages", () => ({ ...withQuestions.details["HARNESS-1"]!.ticket, messageDraft: { text: "", attachments: [], questionReplies: kept, origin: null, updatedAt: 1 } }));
    const send = all(m.container, "[data-testid=composer-send]")[0]!;
    await type(m, reply(questions(m)[1]!), "Next Friday");
    expect(send.hasAttribute("disabled")).toBe(false);
    await click(m, send);
    const posts = () => m.client.bodies.filter((b) => b.request === "POST /tickets/HARNESS-1/messages").map((b) => b.body);
    expect(posts()).toEqual([{ text: "", questionReplies: kept }]);
    await m.until("the replies stay", () => questions(m).map((q) => reply(q).value).join("|") === "Postgres|Next Friday");
    // Send stays on: sending again delivers the same (or edited) replies as another message.
    expect(send.hasAttribute("disabled")).toBe(false);
    await click(m, send);
    expect(posts()).toHaveLength(2);
  });

  test("a reply under a question the agent has resolved doesn't go out", async () => {
    const world = edited((w) => {
      const t = w.tickets.find((x) => x.key === "HARNESS-1")!;
      t.messageDraft = { ...t.messageDraft!, questionReplies: [{ question: "Which port?", body: "5432" }] };
      w.details["HARNESS-1"]!.ticket = t;
    }, withQuestions);
    const m = await mount(detail("HARNESS-1"), { world });
    await m.until("the panel", () => questions(m).length === 2);
    expect(all(m.container, "[data-testid=composer-send]")[0]!.hasAttribute("disabled")).toBe(true);
  });

  test("off the Spec tab there's no Needs you, and a message goes without the drafted answers, which stay", async () => {
    const m = await mount(detail("HARNESS-1", "activity"), { world: withQuestions });
    await m.until("loads", () => all(m.container, "[data-testid=composer-send]").length === 1);
    expect(all(m.container, "[data-testid=needs-you]")).toHaveLength(0);
    expect(all(m.container, "[data-testid=needs-you-bar]")).toHaveLength(0);
    expect(text(all(m.container, "[data-testid=composer]")[0]!)).not.toContain("Needs you");
    // The drafted answer alone doesn't make a message here.
    expect(all(m.container, "[data-testid=composer-send]")[0]!.hasAttribute("disabled")).toBe(true);
    await type(m, all(m.container, "[data-testid=composer] textarea.composer-input").at(-1) as HTMLTextAreaElement, "Quick question first");
    await click(m, all(m.container, "[data-testid=composer-send]")[0]!);
    expect(m.client.bodies.filter((b) => b.request === "POST /tickets/HARNESS-1/messages").map((b) => b.body)).toEqual([{ text: "Quick question first" }]);
  });

  test("a spec without open questions shows no panel and no chip", async () => {
    const m = await mount(detail("HARNESS-5"));
    await m.until("loads", () => text(m.container).includes("Speed up the board"));
    expect(all(m.container, "[data-testid=needs-you]")).toHaveLength(0);
    expect(all(m.container, "[data-testid=needs-you-bar]")).toHaveLength(0);
  });
});

/**
 * Gives every ticket pane (.detail) a size and a ResizeObserver the test drives, the way the window
 * sizes it in the app; `resize` changes the size and tells the observers.
 */
function sizedPanes(width: number, height: number) {
  const size = { width, height };
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const RO = globalThis.ResizeObserver;
  const observers = new Set<{ cb: ResizeObserverCallback }>();
  proto.getBoundingClientRect = function (this: HTMLElement) {
    if (!this.classList.contains("detail")) return rect.call(this);
    return { x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height, width: size.width, height: size.height, toJSON: () => ({}) } as DOMRect;
  };
  globalThis.ResizeObserver = class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      observers.add(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observers.delete(this);
    }
  } as unknown as typeof ResizeObserver;
  return {
    resize(w: number, h: number) {
      size.width = w;
      size.height = h;
      for (const o of observers) o.cb([], o as unknown as ResizeObserver);
    },
    restore() {
      proto.getBoundingClientRect = rect;
      globalThis.ResizeObserver = RO;
    },
  };
}

describe("Needs you in a narrow pane: answers inline in the spec", () => {
  const SPEC = "# Pick a cache\n\n## Plan\n\n1. Pick the store\n   - [ ] Which database?\n\n## Open questions\n\n- [x] Which port?\n- [ ] Ship when?\n";
  const withQuestions = edited((w) => {
    const t = w.tickets.find((x) => x.key === "HARNESS-1")!;
    t.spec = SPEC;
    t.openQuestionCount = 2;
    t.messageDraft = { text: "", attachments: [], questionReplies: [{ question: "Which database?", body: "Postgres" }], origin: null, updatedAt: w.now };
    w.details["HARNESS-1"]!.ticket = t;
  });
  const inline = (m: { container: HTMLElement }) => all(m.container, ".spec-doc [data-testid=spec-question]");
  const box = (q: HTMLElement) => all(q, "[data-testid=needs-you-reply]")[0] as HTMLTextAreaElement;
  const bar = (m: { container: HTMLElement }) => all(m.container, "[data-testid=needs-you-bar]")[0];
  let panes: ReturnType<typeof sizedPanes>;
  afterEach(() => panes.restore());

  test("each open question gets its box where it sits in the spec; the composer has a one-line bar, not the panel", async () => {
    panes = sizedPanes(600, 900);
    const m = await mount(detail("HARNESS-1"), { world: withQuestions });
    await m.until("the inline boxes", () => inline(m).length === 2);
    expect(inline(m).map((q) => q.dataset.question ?? box(q).dataset.question)).toEqual(["Which database?", "Ship when?"]);
    expect(inline(m).map((q) => box(q).value)).toEqual(["Postgres", ""]);
    // The question under the plan step is inside that step's list, where the agent put it.
    expect(inline(m)[0]!.closest("ol")).not.toBeNull();
    // Checked items stay plain checked lines.
    expect((all(m.container, ".spec-doc [data-testid=md-task-box]") as HTMLInputElement[]).filter((b) => b.checked)).toHaveLength(1);
    expect(all(m.container, "[data-testid=needs-you]")).toHaveLength(0);
    // The drafted answer is ready to go.
    expect(text(bar(m))).toContain("1 answer ready · Send");
  });

  test("the bar focuses the first question's box; once answers are drafted it sends them all as one message, and they stay", async () => {
    panes = sizedPanes(600, 900);
    // A ticket with nothing drafted (each ticket's draft session outlives a mount, like the app's).
    const world = edited((w) => {
      const t = w.tickets.find((x) => x.key === "HARNESS-2")!;
      t.spec = SPEC;
      t.messageDraft = null;
      w.details["HARNESS-2"]!.ticket = t;
    });
    const m = await mount(detail("HARNESS-2"), { world });
    await m.until("the inline boxes", () => inline(m).length === 2);
    expect(bar(m)!.dataset.action).toBe("focus");
    expect(text(bar(m))).toContain("Needs you · 2");
    await click(m, bar(m)!);
    expect(document.activeElement).toBe(box(inline(m)[0]!));
    await type(m, box(inline(m)[0]!), "Postgres");
    await type(m, box(inline(m)[1]!), "Friday");
    await m.until("the bar sends", () => text(bar(m)).includes("2 answers ready · Send"));
    await click(m, bar(m)!);
    const posts = m.client.bodies.filter((b) => b.request === "POST /tickets/HARNESS-2/messages").map((b) => b.body);
    expect(posts).toEqual([{ text: "", questionReplies: [{ question: "Which database?", body: "Postgres" }, { question: "Ship when?", body: "Friday" }] }]);
    expect(inline(m).map((q) => box(q).value)).toEqual(["Postgres", "Friday"]);
  });

  test("resizing the pane across the threshold switches between the inline form and the panel, keeping the answers", async () => {
    panes = sizedPanes(1200, 800);
    const m = await mount(detail("HARNESS-1"), { world: withQuestions });
    await m.until("the panel", () => all(m.container, "[data-testid=needs-you-question]").length === 2);
    expect(inline(m)).toHaveLength(0);
    await m.settle(() => panes.resize(640, 800));
    await m.until("inline", () => inline(m).length === 2);
    expect(all(m.container, "[data-testid=needs-you]")).toHaveLength(0);
    await type(m, box(inline(m)[1]!), "Friday");
    await m.settle(() => panes.resize(1200, 800));
    await m.until("the panel again", () => all(m.container, "[data-testid=needs-you-question]").length === 2);
    expect(all(m.container, "[data-testid=needs-you-question] [data-testid=needs-you-reply]").map((t) => (t as HTMLTextAreaElement).value)).toEqual(["Postgres", "Friday"]);
  });

  test("a blocked ticket's question shows under the bar, by the composer, not in the spec", async () => {
    panes = sizedPanes(600, 900);
    const m = await mount(detail("HARNESS-4"));
    await m.until("the callout", () => all(m.container, "[data-testid=blocked-callout]").length === 1);
    expect(all(m.container, "[data-testid=blocked-callout]")[0]!.closest("[data-testid=composer]")).not.toBeNull();
    expect(text(bar(m))).toContain("Needs you · 1");
    // With no question in the spec to go to, the bar focuses the message box.
    await click(m, bar(m)!);
    expect((document.activeElement as HTMLElement).classList.contains("composer-input")).toBe(true);
  });
});
