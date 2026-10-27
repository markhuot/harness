import { describe, expect, jest, test } from "bun:test";
import { useEffect, useRef, useState } from "react";
import { BoardPane } from "../../app/src/renderer/views/Board";
import { CommandPalette } from "../../app/src/renderer/views/CommandPalette";
import { Sidebar } from "../../app/src/renderer/views/Sidebar";
import { TicketDetail } from "../../app/src/renderer/views/TicketDetail";
import { world } from "../world";
import { advance, all, click, edited, mount, text, type, type Mounted } from "./render";

type M = Mounted;
const cardKeys = (m: M) => all(m.container, ".card").map((c) => c.dataset.key);
const chips = (m: M, key: string) => all(m.container, `.card[data-key="${key}"] .label-chip`).map((c) => c.dataset.label);
const sidebarRows = (m: M) => all(m.container, '[data-testid="nav-label"]');
const input = (m: M, testId: string) => m.container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
const options = (m: M) => all(m.container, '[data-testid="qualifier-option"]').map((o) => o.dataset.value);
const board = () => (
  <>
    <Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />
    <BoardPane />
  </>
);

describe("label chips on the board", () => {
  test("a card shows its labels in the order added, and a card without any shows none", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => cardKeys(m).includes("HARNESS-3"));
    expect(chips(m, "HARNESS-3")).toEqual(["Design", "Settings"]);
    expect(chips(m, "HARNESS-5")).toEqual(["Performance", "Release 1.2.3"]);
    expect(all(m.container, `.card[data-key="HARNESS-6"] [data-testid="card-labels"]`)).toHaveLength(0);
  });

  test("a chip carries the full name as its tooltip and the label's own color", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => cardKeys(m).includes("HARNESS-4"));
    const release = all(m.container, '.card[data-key="HARNESS-4"] .label-chip')[0]!;
    expect(release.title).toBe("Release 1.2.3");
    const bugfix = all(m.container, '.card[data-key="HARNESS-2"] .label-chip')[0]!;
    expect(release.style.background).not.toBe("");
    expect(release.style.background).not.toBe(bugfix.style.background);
  });

  test("a recolor from the service repaints the chips, and a label change on a ticket shows up", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => cardKeys(m).includes("HARNESS-2"));
    const before = all(m.container, '.card[data-key="HARNESS-2"] .label-chip')[0]!.style.background;
    await m.settle(() => m.client.push({ kind: "labels.changed", labels: world.labels.map((l) => (l.name === "Bugfix" ? { ...l, color: "teal" } : l)) }));
    expect(all(m.container, '.card[data-key="HARNESS-2"] .label-chip')[0]!.style.background).not.toBe(before);
    const t = world.tickets.find((x) => x.key === "HARNESS-2")!;
    await m.settle(() => m.client.push({ kind: "ticket.upserted", ticket: { ...t, labels: ["Bugfix", "Docs"] } }));
    expect(chips(m, "HARNESS-2")).toEqual(["Bugfix", "Docs"]);
  });
});

describe("the sidebar's Labels section", () => {
  test("lists labels most recently used first with their counts, hiding the ones with count 0", async () => {
    const m = await mount(<Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />);
    await m.until("labels load", () => sidebarRows(m).length > 0);
    const active = world.labels.filter((l) => l.count > 0);
    expect(sidebarRows(m).map((r) => text(r))).toEqual(active.map((l) => `${l.name}${l.count}`));
    expect(world.labels.some((l) => l.count === 0)).toBe(true);
    expect(text(m.container)).not.toContain("Docs");
  });

  test("shows ten, and More reveals ten at a time until it's gone", async () => {
    const many = edited((w) => {
      w.labels = Array.from({ length: 25 }, (_, i) => ({ name: `Label ${i}`, color: "blue", createdAt: 0, lastUsedAt: 0, count: 1 }));
    });
    const m = await mount(<Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />, { world: many });
    await m.until("labels load", () => sidebarRows(m).length > 0);
    expect(sidebarRows(m)).toHaveLength(10);
    await click(m, m.container.querySelector('[data-testid="labels-more"]')!);
    expect(sidebarRows(m)).toHaveLength(20);
    await click(m, m.container.querySelector('[data-testid="labels-more"]')!);
    expect(sidebarRows(m)).toHaveLength(25);
    expect(m.container.querySelector('[data-testid="labels-more"]')).toBeNull();
  });

  test("a label whose count drops to 0 leaves, and returns when a ticket makes it active", async () => {
    const m = await mount(<Sidebar onNewSession={() => {}} onNewTerminal={() => {}} />);
    await m.until("labels load", () => sidebarRows(m).length > 0);
    const set = (docs: number) => world.labels.map((l) => (l.name === "Docs" ? { ...l, count: docs } : l.name === "Bugfix" ? { ...l, count: 0 } : l));
    await m.settle(() => m.client.push({ kind: "labels.changed", labels: set(1) }));
    const names = sidebarRows(m).map((r) => text(r));
    expect(names).toContain("Docs1");
    expect(names.some((n) => n.startsWith("Bugfix"))).toBe(false);
  });

  test("clicking a label searches the board for it, and clicking it again clears the search", async () => {
    const m = await mount(board());
    await m.until("the board and labels load", () => cardKeys(m).includes("HARNESS-3") && sidebarRows(m).length > 0);
    const bugfix = () => sidebarRows(m).find((r) => text(r).startsWith("Bugfix"))!;
    await click(m, bugfix());
    expect(input(m, "board-search").value).toBe("label:Bugfix");
    await m.until("only Bugfix tickets", () => cardKeys(m).every((k) => ["HARNESS-2", "HARNESS-7", "WEB-2"].includes(k!)) && cardKeys(m).length > 0);
    expect(bugfix().getAttribute("aria-current")).toBe("page");
    await click(m, bugfix());
    expect(input(m, "board-search").value).toBe("");
    await m.until("the whole board", () => cardKeys(m).includes("HARNESS-3"));
  });

  test("a name with spaces is quoted in the search", async () => {
    const m = await mount(board());
    await m.until("labels load", () => sidebarRows(m).length > 0);
    await click(m, sidebarRows(m).find((r) => text(r).startsWith("Release 1.2.3"))!);
    expect(input(m, "board-search").value).toBe('label:"Release 1.2.3"');
  });
});

describe("board search qualifiers", () => {
  test("typing label: offers the labels, filtered by what follows the colon", async () => {
    const m = await mount(<BoardPane />);
    await m.until("labels load", () => cardKeys(m).length > 0);
    await type(m, input(m, "board-search"), "label:");
    expect(options(m)).toEqual(world.labels.map((l) => l.name));
    await type(m, input(m, "board-search"), "label:rel");
    expect(options(m)).toEqual(["Release 1.2.3"]);
    await type(m, input(m, "board-search"), "plain words");
    expect(options(m)).toEqual([]);
  });

  test("choosing a label finishes the qualifier and keeps the focus in the field", async () => {
    const m = await mount(<BoardPane />);
    await m.until("labels load", () => cardKeys(m).length > 0);
    const box = input(m, "board-search");
    box.focus();
    await type(m, box, "fix label:rel");
    await click(m, all(m.container, '[data-testid="qualifier-option"]')[0]!);
    expect(box.value).toBe('fix label:"Release 1.2.3" ');
    expect(document.activeElement).toBe(box);
    expect(options(m)).toEqual([]);
  });

  test("project: offers projects by key and name", async () => {
    const m = await mount(<BoardPane />);
    await m.until("the board loads", () => cardKeys(m).length > 0);
    await type(m, input(m, "board-search"), "project:har");
    expect(options(m)).toEqual(["HARNESS"]);
  });

  test("two label qualifiers narrow to the tickets that carry both", async () => {
    jest.useFakeTimers();
    try {
      const m = await mount(<BoardPane />);
      await m.until("the board loads", () => cardKeys(m).length > 0);
      await type(m, input(m, "board-search"), 'label:"Release 1.2.3" label:Performance ');
      // Before the service answers, the loaded tickets are filtered locally.
      expect(cardKeys(m)).toEqual(["HARNESS-5"]);
      await advance(m, 1000);
      expect(m.client.requests.filter((r) => r.startsWith("GET /tickets/search"))).toHaveLength(1);
      expect(decodeURIComponent(m.client.requests.find((r) => r.startsWith("GET /tickets/search"))!.replace(/\+/g, " "))).toContain('q=label:"Release 1.2.3" label:Performance');
      expect(cardKeys(m)).toEqual(["HARNESS-5"]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("command palette qualifiers", () => {
  const open = () => mount(<CommandPalette origin={document.body} onClose={() => (closed.n += 1)} onShortcuts={() => {}} />);
  const closed = { n: 0 };
  const rows = (m: M) => all(m.container, '[role="option"]').map((r) => text(r));
  const box = (m: M) => input(m, "palette-input");

  test("label: lists labels, and choosing one fills in the input without closing the palette", async () => {
    closed.n = 0;
    const m = await open();
    await type(m, box(m), "label:perf");
    expect(rows(m)).toEqual(["PerformanceLabel"]);
    await click(m, all(m.container, '[role="option"]')[0]!);
    expect(box(m).value).toBe("label:Performance ");
    expect(closed.n).toBe(0);
  });

  test("a prefix like # is kept when a choice is made", async () => {
    const m = await open();
    await type(m, box(m), "#label:bug");
    await click(m, all(m.container, '[role="option"]')[0]!);
    expect(box(m).value).toBe("#label:Bugfix ");
  });

  test("a finished qualifier lists the tickets that carry the label, not commands", async () => {
    jest.useFakeTimers();
    try {
      const m = await open();
      await type(m, box(m), "label:Bugfix ");
      const keys = () => rows(m).map((r) => r.replace(/^(\D+-\d+).*/, "$1")).sort();
      expect(keys()).toEqual(["HARNESS-2", "HARNESS-7", "WEB-2"]);
      await advance(m, 1000);
      expect(m.client.requests.some((r) => r.startsWith("GET /tickets/search?q=label%3ABugfix"))).toBe(true);
      expect(keys()).toEqual(["HARNESS-2", "HARNESS-7", "WEB-2"]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("Enter on a label choice completes it with the keyboard", async () => {
    const m = await open();
    await type(m, box(m), 'label:"release');
    await m.settle(() => void box(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(box(m).value).toBe('label:"Release 1.2.3" ');
  });
});

describe("editing a ticket's labels", () => {
  const detail = (key: string) => <TicketDetail paneId="p1" ticketKey={key} tab="details" zoomed={false} />;
  const editor = (m: M) => m.container.querySelector<HTMLElement>('[data-testid="labels-editor"]')!;
  const editorChips = (m: M) => all(editor(m), ".label-chip").map((c) => c.dataset.label);
  const patches = (m: M) => m.client.bodies.filter((b) => b.request.startsWith("PATCH /tickets/")).map((b) => b.body);
  const load = async (key = "HARNESS-1") => {
    const m = await mount(detail(key));
    await m.until("the editor", () => !!editor(m));
    return m;
  };
  const enter = (m: M) => m.settle(() => void input(m, "label-add").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

  test("shows the ticket's labels", async () => {
    const m = await load("HARNESS-3");
    expect(editorChips(m)).toEqual(["Design", "Settings"]);
  });

  test("the add field suggests existing labels case-insensitively, leaving out the ones it has", async () => {
    const m = await load("HARNESS-1");
    const add = input(m, "label-add");
    await m.settle(() => add.focus());
    await type(m, add, "DO");
    // Docs is already on it, so only the new name is offered.
    expect(all(m.container, '[data-testid="label-suggestions"] li').map((l) => text(l))).toEqual(["Create “DO”"]);
    await type(m, add, "bug");
    expect(all(m.container, '[data-testid="label-suggestions"] li').map((l) => l.dataset.label)).toEqual(["Bugfix", "bug"]);
  });

  test("Enter adds an existing label under its own spelling, sending the whole list", async () => {
    const m = await load("HARNESS-1");
    await type(m, input(m, "label-add"), "bugFIX");
    await enter(m);
    expect(patches(m)).toEqual([{ labels: ["Docs", "Bugfix"] }]);
    await m.until("the chip", () => editorChips(m).includes("Bugfix"));
    expect(input(m, "label-add").value).toBe("");
  });

  test("Enter creates a label the service hasn't seen", async () => {
    const m = await load("HARNESS-1");
    await type(m, input(m, "label-add"), "Needs   Copy");
    await enter(m);
    expect(patches(m)).toEqual([{ labels: ["Docs", "Needs Copy"] }]);
    await m.until("the chip", () => editorChips(m).includes("Needs Copy"));
  });

  test("a name the service would refuse shows a message and sends nothing", async () => {
    const m = await load("HARNESS-1");
    await type(m, input(m, "label-add"), 'say "hi"');
    await enter(m);
    expect(text(m.container.querySelector('[data-testid="label-error"]'))).toContain("double quote");
    expect(patches(m)).toEqual([]);
    await type(m, input(m, "label-add"), "ok");
    expect(m.container.querySelector('[data-testid="label-error"]')).toBeNull();
  });

  test("the × removes a label, sending the rest", async () => {
    const m = await load("HARNESS-3");
    await click(m, all(editor(m), 'button[aria-label="Remove Design"]')[0]!);
    expect(patches(m)).toEqual([{ labels: ["Settings"] }]);
    await m.until("the chip goes", () => !editorChips(m).includes("Design"));
  });

  test("a color from the chip's picker recolors the label for every ticket", async () => {
    const m = await load("HARNESS-3");
    await click(m, all(editor(m), '[data-testid="label-color"]')[0]!);
    expect(all(editor(m), '[role="radio"]')).toHaveLength(11);
    await click(m, all(editor(m), '[role="radio"][data-color="lime"]')[0]!);
    expect(m.client.requests).toContain("PATCH /labels/Design");
    expect(m.client.bodies.find((b) => b.request === "PATCH /labels/Design")!.body).toEqual({ color: "lime" });
    await m.until("the picker closes", () => all(editor(m), '[role="radio"]').length === 0);
  });
});

describe("the Details field offers every label and a create row", () => {
  const detail = (key: string) => <TicketDetail paneId="p1" ticketKey={key} tab="details" zoomed={false} />;
  const rows = (m: M) => all(m.container, '[data-testid="label-suggestions"] li').map((l) => text(l));

  test("focusing the empty field lists the labels the ticket lacks, and a new name offers Create", async () => {
    const m = await mount(detail("HARNESS-1"));
    await m.until("the editor", () => !!m.container.querySelector('[data-testid="labels-editor"]'));
    const add = input(m, "label-add");
    await m.settle(() => add.focus());
    expect(rows(m).length).toBeGreaterThan(0);
    expect(rows(m).some((r) => r.includes("Docs"))).toBe(false);
    await type(m, add, "Brand new");
    expect(rows(m)).toEqual(["Create “Brand new”"]);
  });

  test("the arrow keys move the highlight and Enter adds the highlighted label", async () => {
    const m = await mount(detail("HARNESS-1"));
    await m.until("the editor", () => !!m.container.querySelector('[data-testid="labels-editor"]'));
    const add = input(m, "label-add");
    await m.settle(() => add.focus());
    await type(m, add, "e");
    const names = all(m.container, '[data-testid="label-suggestions"] li').map((l) => l.dataset.label);
    expect(names.length).toBeGreaterThan(1);
    await m.settle(() => void add.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    await m.settle(() => void add.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(m.client.bodies.filter((b) => b.request.startsWith("PATCH /tickets/")).map((b) => b.body)).toEqual([{ labels: ["Docs", names[1]] }]);
  });
});

describe("the palette's Add label… and Remove label…", () => {
  // The palette's origin is the ticket pane, as when it opens from the focused pane.
  // Each test gets its own pane id: a mounted pane keeps its command area for the whole file.
  let panes = 0;
  function Scene({ pane }: { pane: string }) {
    const [origin, setOrigin] = useState<Element | null>(null);
    const wrap = useRef<HTMLDivElement>(null);
    useEffect(() => void (!origin && setOrigin(wrap.current!.querySelector(".detail"))));
    return (
      <>
        <div ref={wrap}>
          <TicketDetail paneId={pane} ticketKey="HARNESS-3" tab="details" zoomed={false} />
        </div>
        {origin && <CommandPalette origin={origin} onClose={() => {}} onShortcuts={() => {}} />}
      </>
    );
  }
  const scene = () => <Scene pane={`label-palette-${(panes += 1)}`} />;
  const patches = (m: M) => m.client.bodies.filter((b) => b.request.startsWith("PATCH /tickets/")).map((b) => b.body);
  const run = async (m: M, query: string) => {
    await m.until("the palette", () => !!m.container.querySelector('[data-testid="palette-input"]'));
    await type(m, input(m, "palette-input"), `>${query}`);
    await m.settle(() => void input(m, "palette-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  };
  const pickerInput = (m: M) => input(m, "label-picker-input");

  test("Add label… opens a picker of the labels the ticket lacks and adds the chosen one", async () => {
    const m = await mount(scene());
    await run(m, "Add label");
    await m.until("the picker", () => !!m.container.querySelector('[data-testid="label-picker"]'));
    const names = all(m.container, '[data-testid="label-picker"] li').map((l) => l.dataset.label);
    expect(names).not.toContain("Design");
    expect(names).not.toContain("Settings");
    await type(m, pickerInput(m), "bugf");
    await m.settle(() => void pickerInput(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(patches(m)).toEqual([{ labels: ["Design", "Settings", "Bugfix"] }]);
  });

  test("Add label… creates the typed name when no label has it", async () => {
    const m = await mount(scene());
    await run(m, "Add label");
    await m.until("the picker", () => !!m.container.querySelector('[data-testid="label-picker"]'));
    await type(m, pickerInput(m), "Fresh one");
    expect(all(m.container, '[data-testid="label-picker"] li').map((l) => text(l))).toEqual(["Create “Fresh one”"]);
    await m.settle(() => void pickerInput(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(patches(m)).toEqual([{ labels: ["Design", "Settings", "Fresh one"] }]);
  });

  test("Remove label… lists only the ticket's own labels and removes the chosen one", async () => {
    const m = await mount(scene());
    await run(m, "Remove label");
    await m.until("the picker", () => !!m.container.querySelector('[data-testid="label-picker"]'));
    expect(all(m.container, '[data-testid="label-picker"] li').map((l) => l.dataset.label)).toEqual(["Design", "Settings"]);
    await type(m, pickerInput(m), "sett");
    await m.settle(() => void pickerInput(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(patches(m)).toEqual([{ labels: ["Design"] }]);
  });
});
