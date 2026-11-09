import { describe, expect, test } from "bun:test";
import { TICKET_STATUSES } from "@harness/shared";
import { BoardPane } from "../../app/src/renderer/views/Board";
import { world } from "../world";
import { all, click, mount, text, type Mounted } from "./render";

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

  const openOptions = (m: Mounted) => click(m, m.container.querySelector('[data-testid="search-options"]')!);
  const option = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  test("columns sort by recent activity by default; the options menu switches to created or title order", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "in_progress") > 0);
    expect(cards(m, "in_progress")).toEqual(["WEB-2", "HARNESS-2", "HARNESS-8", "HARNESS-3"]);
    await openOptions(m);
    expect(option("sort-recent")!.getAttribute("aria-checked")).toBe("true");
    await click(m, option("sort-created")!);
    expect(cards(m, "in_progress")).toEqual(["HARNESS-2", "WEB-2", "HARNESS-3", "HARNESS-8"]);
    await click(m, option("sort-title")!);
    expect(cards(m, "in_progress")).toEqual(["HARNESS-3", "WEB-2", "HARNESS-2", "HARNESS-8"]);
    expect(localStorage.getItem("harness.board.sort")).toBe("title");
  });

  test("a transcript entry brings its ticket to the top and resets its age", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "in_progress") > 0);
    const age = (key: string) => text(m.container.querySelector(`article.card[data-key="${key}"] [data-testid="card-age"]`));
    expect(age("HARNESS-3")).toBe("40m ago");
    const t = world.tickets.find((x) => x.key === "HARNESS-3")!;
    await m.settle(() =>
      m.client.push({
        kind: "transcript.appended",
        entry: { id: "e-new", sessionId: t.sessionId, runId: null, subagentId: null, seq: 999, role: "user", content: { type: "text", text: "Any news?" }, createdAt: Date.now() },
      }),
    );
    expect(cards(m, "in_progress")[0]).toBe("HARNESS-3");
    expect(age("HARNESS-3")).toBe("just now");
  });

  test("group by project splits each column into projects by name, sorted within; a project's board doesn't offer it", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => count(m, "in_progress") > 0);
    await openOptions(m);
    await click(m, option("group-by-project")!);
    const column = m.container.querySelector<HTMLElement>('.column:has([data-testid="count-in_progress"])')!;
    expect(all(column, '[data-testid="column-group"]').map((g) => g.dataset.project)).toEqual(["HARNESS", "WEB"]);
    expect(cards(m, "in_progress")).toEqual(["HARNESS-2", "HARNESS-8", "HARNESS-3", "WEB-2"]);
    // The section header names the project, so the cards drop their project badge.
    expect(column.querySelector("article.card .project-key, article.card [data-project-key]")).toBeNull();
    await click(m, option("sort-created")!);
    expect(cards(m, "in_progress")).toEqual(["HARNESS-2", "HARNESS-3", "HARNESS-8", "WEB-2"]);

    const p = await mount(<BoardPane />, { hash: "#/board/project-HARNESS" });
    await p.until("the board loads", () => count(p, "in_progress") > 0);
    await openOptions(p);
    expect(option("group-by-project")).toBeNull();
    expect(p.container.querySelector('[data-testid="column-group"]')).toBeNull();
  });
});

