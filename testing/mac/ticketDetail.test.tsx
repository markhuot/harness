import { describe, expect, test } from "bun:test";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { all, click, edited, mount, text } from "./render";

const detail = (key: string, tab: "spec" | "activity" | "transcript" | "details" = "spec") => <TicketDetail paneId="p1" ticketKey={key} tab={tab} zoomed={false} />;
const buttons = (m: { container: HTMLElement }) => all(m.container, "button").map((b) => text(b));

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
