import { describe, expect, jest, test } from "bun:test";
import { CommandPalette } from "../../app/src/renderer/views/CommandPalette";
import { advance, all, mount, text, type } from "./render";

const SEARCH_LIMIT = 20; // CommandPalette's own page size: a change there should change this test
const open = () => mount(<CommandPalette origin={document.body} onClose={() => {}} onShortcuts={() => {}} />);
const rows = (m: { container: HTMLElement }) => all(m.container, '[role="option"]').map((r) => text(r));

describe("CommandPalette", () => {
  test("an empty query lists commands: boards for every project, then settings and the inbox", async () => {
    const m = await open();
    const list = rows(m);
    expect(list.some((r) => r.startsWith("Board: Harness"))).toBe(true);
    expect(list.some((r) => r.startsWith("Board: Scratch"))).toBe(true);
    expect(list.some((r) => r.startsWith("Inbox"))).toBe(true);
    expect(list.some((r) => r.startsWith("Settings: Drivers"))).toBe(true);
  });

  test("a query finds tickets by title across projects, with their status", async () => {
    const m = await open();
    await type(m, m.container.querySelector("input")!, "pricing");
    await m.until("the search answers", () => rows(m).length > 0);
    expect(rows(m)).toEqual(["WEB-1Refresh the pricing pagePlanning"]);
  });

  test("a query matches a ticket key exactly, whatever its title says", async () => {
    const m = await open();
    await type(m, m.container.querySelector("input")!, "HARNESS-6");
    await m.until("the search answers", () => rows(m).length > 0);
    expect(rows(m)[0]).toContain("HARNESS-6");
    expect(rows(m)[0]).toContain("Review");
  });

  test("a query nothing matches says so instead of listing everything", async () => {
    jest.useFakeTimers();
    try {
      const m = await open();
      await type(m, m.container.querySelector("input")!, "zzzzqq");
      expect(m.container.querySelector('[data-testid="palette-searching"]')).not.toBeNull();
      await advance(m, 1000);
      expect(m.client.requests.filter((r) => r.startsWith("GET /tickets/search"))).toEqual(["GET /tickets/search?q=zzzzqq&limit=" + SEARCH_LIMIT]);
      expect(m.container.querySelector('[data-testid="palette-searching"]')).toBeNull();
      expect(rows(m)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
});
