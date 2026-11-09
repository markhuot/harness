import { afterEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import type { ActivityEntry } from "@harness/shared";
import { BoardPane } from "../../app/src/renderer/views/Board";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { all, click, edited, mount, text, type Mounted } from "./render";

// Seen and unseen (DESIGN.md "Seen and unseen"). The shared world has HARNESS-5 (two labels) and
// HARNESS-6 (none) unseen in Review.

const card = (m: Mounted, key: string) => m.container.querySelector<HTMLElement>(`article.card[data-key="${key}"]`);
const pill = (m: Mounted, key: string) => card(m, key)?.querySelector('[data-testid="card-unseen"]') ?? null;
const seenBodies = (m: Mounted, key: string) => m.client.bodies.filter((b) => b.request === `PUT /tickets/${key}/seen`).map((b) => b.body);
const ticketOf = (key: string) => world.tickets.find((t) => t.key === key)!;

describe("the board card", () => {
  test("an unseen Review card leads its label row with New and is tinted; a label-less one shows the row only while unseen", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => !!card(m, "HARNESS-5"));
    const row = card(m, "HARNESS-5")!.querySelector('[data-testid="card-labels"]')!;
    expect(row.firstElementChild?.getAttribute("data-testid")).toBe("card-unseen");
    expect(all(row, ".label-chip").map((c) => text(c))).toEqual(["New", "Performance", "Release 1.2.3"]);
    expect(card(m, "HARNESS-5")!.classList.contains("unseen")).toBe(true);

    expect(all(card(m, "HARNESS-6")!, '[data-testid="card-labels"] .label-chip').map((c) => text(c))).toEqual(["New"]);
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...ticketOf("HARNESS-6"), unseen: false } }));
    expect(card(m, "HARNESS-6")!.querySelector('[data-testid="card-labels"]')).toBeNull();
    expect(card(m, "HARNESS-6")!.classList.contains("unseen")).toBe(false);
  });

  test("cards outside Blocked and Review never show New, even when the flag is set", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => !!card(m, "HARNESS-1"));
    for (const status of ["planning", "in_progress", "done"] as const) {
      await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...ticketOf("HARNESS-1"), status, unseen: true } }));
      expect([status, !!pill(m, "HARNESS-1"), card(m, "HARNESS-1")?.classList.contains("unseen")]).toEqual([status, false, false]);
    }
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...ticketOf("HARNESS-1"), status: "blocked", unseen: true } }));
    expect(!!pill(m, "HARNESS-1")).toBe(true);
  });

  test("the right-click menu offers Mark ticket unseen on a seen Review card only, and picking it sends seen: false", async () => {
    const offered: string[][] = [];
    window.harness = {
      showContextMenu: async (items: { id?: string; label?: string }[]) => {
        offered.push(items.flatMap((i) => (i.label ? [i.label] : [])));
        return "action:markUnseen";
      },
    } as unknown as typeof window.harness;
    try {
      const m = await mount(<BoardPane />, { world: edited((w) => void Object.assign(w.tickets.find((t) => t.key === "HARNESS-6")!, { unseen: false })) });
      await m.until("the board loads", () => !!card(m, "HARNESS-6"));
      // HARNESS-5 is already unseen: nothing to offer, and nothing is sent.
      await m.settle(() => void card(m, "HARNESS-5")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      expect(offered[0]).not.toContain("Mark ticket unseen");
      expect(seenBodies(m, "HARNESS-5")).toEqual([]);

      await m.settle(() => void card(m, "HARNESS-6")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      expect(offered[1]).toContain("Mark ticket unseen");
      expect(seenBodies(m, "HARNESS-6")).toEqual([{ seen: false }]);
      await m.until("the New pill", () => !!pill(m, "HARNESS-6"));
    } finally {
      window.harness = undefined;
    }
  });
});

describe("the ticket detail", () => {
  let setFocus: (f: boolean) => void = () => {};
  function Detail({ ticketKey, initial }: { ticketKey: string; initial: boolean }) {
    const [focused, set] = useState(initial);
    setFocus = set;
    return <TicketDetail paneId="p1" ticketKey={ticketKey} tab="spec" zoomed={false} focused={focused} />;
  }
  const activity = (author: ActivityEntry["author"]): ActivityEntry => ({
    id: `act-${author}-${Math.random()}`,
    sessionId: ticketOf("HARNESS-5").sessionId,
    ticketId: ticketOf("HARNESS-5").id,
    kind: "note",
    author,
    body: "Something new",
    meta: {},
    createdAt: Date.now(),
  } as ActivityEntry);
  afterEach(() => (setFocus = () => {}));

  test("a focused detail marks its unseen ticket seen; an unfocused one waits until it gains focus", async () => {
    const m = await mount(<Detail ticketKey="HARNESS-5" initial={false} />);
    await m.until("loads", () => text(m.container).includes("Speed up the board"));
    await m.settle();
    expect(seenBodies(m, "HARNESS-5")).toEqual([]);
    await m.settle(() => setFocus(true));
    expect(seenBodies(m, "HARNESS-5")).toEqual([{ seen: true }]);
  });

  test("agent activity arriving while focused marks it seen again; the human's own doesn't", async () => {
    const m = await mount(<Detail ticketKey="HARNESS-5" initial />);
    await m.until("marked seen", () => seenBodies(m, "HARNESS-5").length === 1);
    await m.settle(() => m.client.push({ kind: "activity.added", entry: activity("human") }));
    expect(seenBodies(m, "HARNESS-5")).toHaveLength(1);
    await m.settle(() => m.client.push({ kind: "activity.added", entry: activity("agent") }));
    expect(seenBodies(m, "HARNESS-5")).toEqual([{ seen: true }, { seen: true }]);
    // Not while unfocused.
    await m.settle(() => setFocus(false));
    await m.settle(() => m.client.push({ kind: "activity.added", entry: activity("system") }));
    expect(seenBodies(m, "HARNESS-5")).toHaveLength(2);
  });

  test("Mark ticket unseen from a focused detail sends seen: false and isn't undone by the focus rule", async () => {
    const m = await mount(<Detail ticketKey="HARNESS-6" initial />, { world: edited((w) => void Object.assign(w.tickets.find((t) => t.key === "HARNESS-6")!, { unseen: false })) });
    await m.until("loads", () => text(m.container).includes("Keep the palette open"));
    await click(m, m.container.querySelector("[data-testid=ticket-more]")!);
    const item = all(document.body, "[role=menuitem]").find((i) => text(i) === "Mark ticket unseen");
    expect(item).toBeDefined();
    await click(m, item!);
    await m.settle();
    expect(seenBodies(m, "HARNESS-6")).toEqual([{ seen: false }]);
    // Now unseen: the item is gone from the menu.
    await click(m, m.container.querySelector("[data-testid=ticket-more]")!);
    expect(all(document.body, "[role=menuitem]").map((i) => text(i))).not.toContain("Mark ticket unseen");
  });
});
