import { describe, expect, test } from "bun:test";
import { InboxView } from "../../app/src/renderer/views/Inbox";
import { world } from "../world";
import { all, click, edited, mount, text } from "./render";

const items = (m: { container: HTMLElement }) => all(m.container, "button.inbox-item");
const watcherRows = (m: { container: HTMLElement }) => all(m.container, ".watcher-row");

describe("Inbox", () => {
  test("lists each triage session with its outcome, newest first, and counts them", async () => {
    const m = await mount(<InboxView />, { hash: "#/inbox" });
    const rows = items(m).map((r) => text(r));
    expect(rows).toHaveLength(4);
    expect(text(m.container.querySelector(".view-header .muted"))).toBe("4");
    expect(rows[0]).toContain("TRIAGE-1");
    expect(rows[1]).toContain("Dispatched to WEB as WEB-1");
    expect(rows[3]).toContain("TRIAGE-4");
    expect(m.client.unrouted).toEqual([]);
  });

  test("each triage state has its own badge", async () => {
    const m = await mount(<InboxView />, { hash: "#/inbox" });
    const badges = items(m).map((r) => text(r.querySelector(".badge")));
    expect(badges).toEqual(["Triaging", "Dispatched", "Declined", "Failed"]);
    // A session still being triaged shows a spinner; the finished ones don't.
    expect(items(m).map((r) => r.querySelector(".spinner") !== null)).toEqual([true, false, false, false]);
  });

  test("the first item is open until another is picked", async () => {
    const m = await mount(<InboxView />, { hash: "#/inbox" });
    expect(items(m)[0]!.getAttribute("aria-current")).toBe("true");
    await click(m, items(m)[1]!);
    expect(location.hash).toBe(`#/inbox/${world.sessions.find((s) => s.key === "TRIAGE-2")!.id}`);
  });

  test("watchers show their state: waiting with a countdown, stopped with its error, paused muted", async () => {
    const m = await mount(<InboxView />, { hash: "#/inbox" });
    const rows = watcherRows(m);
    // Enabled watchers come first, by name; the paused one last.
    expect(rows.map((r) => text(r.querySelector(".watcher-name")))).toEqual(["jira", "sentry", "github"]);
    expect(text(rows[0])).toContain("Waiting");
    expect(text(rows[0])).toContain("next run in 1m");
    expect(text(rows[1])).toContain("Stopped");
    expect(text(rows[1])).toContain("401 from the Sentry API");
    expect(text(rows[1])).toContain("Retry now");
    expect(rows[2]!.className).toContain("muted-row");
    expect(text(rows[2])).toContain("Paused");
    expect(text(rows[2])).not.toContain("Retry now");
  });

  test("a new triage session pushed by the service appears at the top", async () => {
    const m = await mount(<InboxView />, { hash: "#/inbox" });
    const next = { ...world.sessions.find((s) => s.key === "TRIAGE-1")!, id: "session-TRIAGE-5", key: "TRIAGE-5", title: "FOO-300 New thing", createdAt: world.now };
    await m.settle(() => m.client.push({ kind: "session.upserted", session: next }));
    expect(items(m)).toHaveLength(5);
    expect(text(items(m)[0])).toContain("FOO-300 New thing");
  });

  test("with no triage sessions the inbox says it is empty", async () => {
    const m = await mount(<InboxView />, { hash: "#/inbox", world: edited((w) => void (w.sessions = w.sessions.filter((s) => s.kind !== "triage"))) });
    expect(items(m)).toHaveLength(0);
    expect(text(m.container)).toContain("Inbox zero");
    expect(text(m.container)).toContain("Select an item");
  });
});
