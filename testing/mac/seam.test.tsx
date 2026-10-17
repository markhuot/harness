// The world is the one source for every client: change a field in it and what's on screen changes.
// Run in both hosts the renderer has: a plain browser (no window.harness) and Electron (a bridge).
import { afterEach, describe, expect, test } from "bun:test";
import type { HarnessBridge } from "../../app/src/main/types";
import { BoardPane } from "../../app/src/renderer/views/Board";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { edited, mount, text } from "./render";

const bridge = { deviceId: async () => "device-1" } as unknown as HarnessBridge;

afterEach(() => {
  window.harness = undefined;
});

describe.each([
  ["in a browser (no window.harness)", undefined],
  ["in Electron (a bridge)", bridge],
] as const)("%s", (_host, host) => {
  const retitled = (key: string, title: string) => edited((w) => {
    w.tickets.find((t) => t.key === key)!.title = title;
    w.details[key]!.ticket.title = title;
  });

  test("a ticket's title in the world is its card's title", async () => {
    window.harness = host;
    const before = await mount(<BoardPane />);
    await before.until("cards", () => before.container.querySelector('article.card[data-key="HARNESS-1"]') !== null);
    expect(text(before.container.querySelector('article.card[data-key="HARNESS-1"] .card-title'))).toBe(world.tickets.find((t) => t.key === "HARNESS-1")!.title);
    before.unmount();

    const after = await mount(<BoardPane />, { world: retitled("HARNESS-1", "Renamed in the world") });
    await after.until("cards", () => after.container.querySelector('article.card[data-key="HARNESS-1"]') !== null);
    expect(text(after.container.querySelector('article.card[data-key="HARNESS-1"] .card-title'))).toBe("Renamed in the world");
  });

  test("and the title of its detail pane", async () => {
    window.harness = host;
    const m = await mount(<TicketDetail paneId="p1" ticketKey="HARNESS-1" tab="spec" zoomed={false} />, { world: retitled("HARNESS-1", "Renamed in the world") });
    await m.until("loads", () => text(m.container).includes("Renamed in the world"));
  });
});
