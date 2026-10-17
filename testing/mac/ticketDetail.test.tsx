import { describe, expect, test } from "bun:test";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { all, mount, text } from "./render";

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
