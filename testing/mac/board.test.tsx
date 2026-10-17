import { describe, expect, test } from "bun:test";
import { TICKET_STATUSES } from "@harness/shared";
import { BoardPane } from "../../app/src/renderer/views/Board";
import { world } from "../world";
import { all, mount, text } from "./render";

const count = (m: { container: HTMLElement }, status: string) => Number(text(m.container.querySelector(`[data-testid="count-${status}"]`)));
const cards = (m: { container: HTMLElement }, status: string) =>
  all(m.container, `.column:has([data-testid="count-${status}"]) article.card`).map((c) => c.dataset.key);

describe("Board", () => {
  test("groups every ticket into the column of its status", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "planning") > 0);
    for (const status of TICKET_STATUSES) {
      // Children of a conductor sit under it, not on the board.
      const keys = world.tickets.filter((t) => t.status === status && !t.parentId).map((t) => t.key);
      expect(count(m, status), status).toBe(keys.length);
      // Done is paged and newest first; the rest keep their column order. Compare as sets.
      expect(new Set(cards(m, status)), status).toEqual(new Set(keys));
    }
    expect(m.client.unrouted).toEqual([]);
  });

  test("a project's board shows only that project's tickets", async () => {
    const m = await mount(<BoardPane />, { hash: "#/board/project-NOTES" });
    await m.until("the board loads", () => cards(m, "blocked").length > 0);
    const keys = TICKET_STATUSES.flatMap((s) => cards(m, s));
    expect(keys.sort()).toEqual(["NOTES-1", "NOTES-2"]);
  });

  test("an event that moves a ticket moves its card and both counts", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "planning") > 0);
    const before = { planning: count(m, "planning"), working: count(m, "in_progress") };
    const moved = world.tickets.find((t) => t.key === "HARNESS-1")!;
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...moved, status: "in_progress" } }));
    expect(count(m, "planning")).toBe(before.planning - 1);
    expect(count(m, "in_progress")).toBe(before.working + 1);
    expect(cards(m, "in_progress")).toContain("HARNESS-1");
    expect(cards(m, "planning")).not.toContain("HARNESS-1");
  });

  test("a deleted ticket leaves the board", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "review") > 0);
    const gone = world.tickets.find((t) => t.key === "HARNESS-6")!;
    await m.settle(() => m.client.push({ kind: "ticket.deleted", id: gone.id }));
    expect(cards(m, "review")).not.toContain("HARNESS-6");
  });

  test("a service that can't be reached shows an error toast and no cards", async () => {
    const { FakeClient } = await import("./fakeClient");
    const client = new FakeClient();
    client.overrides.set("GET /projects", () => {
      throw new Error("connection refused");
    });
    const m = await mount(<BoardPane />, { client });
    await m.until("the error", () => m.toasts.length > 0);
    expect(m.toasts[0]).toEqual({ message: "Couldn't load from the service: connection refused", kind: "error" });
    expect(all(m.container, "article.card")).toHaveLength(0);
  });

  test("only a draft is marked as one", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "planning") > 0);
    const card = (key: string) => m.container.querySelector<HTMLElement>(`article.card[data-key="${key}"]`)!;
    expect(card("WEB-1").querySelector('[data-testid="card-draft"]')).not.toBeNull();
    expect(card("HARNESS-1").querySelector('[data-testid="card-draft"]')).toBeNull();
  });
});
