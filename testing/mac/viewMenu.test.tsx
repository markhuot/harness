import { afterEach, describe, expect, test } from "bun:test";
import { FilePane } from "../../app/src/renderer/views/FilePane";
import { SpecTab } from "../../app/src/renderer/views/SpecTab";
import { resetWrapPrefs, WRAP_KEY } from "../../app/src/renderer/state/viewPrefs";
import { world } from "../world";
import { all, click, mount, text, type Mounted } from "./render";

const pane = (path: string) => <FilePane paneId="p1" content={{ kind: "file", root: { ticketKey: "HARNESS-5" }, path, tab: "file" }} zoomed={false} />;
const item = (id: string) => [...document.body.querySelectorAll<HTMLButtonElement>(`[data-testid="${id}"]`)].pop() ?? null;
const openMenu = async (m: Mounted, button: string) => {
  await click(m, m.container.querySelector(button)!);
  await m.until("the menu", () => !!item("view-wrap"));
};
const items = () => all([...document.body.querySelectorAll('[role="menu"]')].pop()!, "button").map((b) => text(b));

// The wrap settings are read once and cached; the harness empties localStorage between tests.
afterEach(resetWrapPrefs);

describe("file pane view menu", () => {
  test("a markdown file offers Source and Rendered, other files only Wrap lines", async () => {
    const md = await mount(pane("README.md"));
    await md.until("the file loads", () => !!md.container.querySelector("[data-testid=file-editor]"));
    await openMenu(md, 'button[title="More"]');
    expect(items().slice(0, 3)).toEqual(["Source", "Rendered", "Wrap lines"]);
    md.unmount();

    const ts = await mount(pane("src/util.ts"));
    await ts.until("the file loads", () => !!ts.container.querySelector("[data-testid=file-editor]"));
    await openMenu(ts, 'button[title="More"]');
    expect(items()[0]).toBe("Wrap lines");
    expect(item("view-rendered")).toBeNull();
  });

  test("Rendered replaces the editor with the markdown, wrap is unavailable there, and Source brings it back", async () => {
    const m = await mount(pane("README.md"));
    await m.until("the file loads", () => !!m.container.querySelector("[data-testid=file-editor]"));
    await openMenu(m, 'button[title="More"]');
    await click(m, item("view-rendered")!);
    expect(text(m.container.querySelector("[data-testid=file-rendered]"))).toContain("A board for agents.");
    expect(m.container.querySelector(".file-editor-slot")!.hasAttribute("hidden")).toBe(true);
    await openMenu(m, 'button[title="More"]');
    expect(item("view-wrap")!.disabled).toBe(true);
    await click(m, item("view-source")!);
    expect(m.container.querySelector("[data-testid=file-rendered]")).toBeNull();
    expect(m.container.querySelector(".file-editor-slot")!.hasAttribute("hidden")).toBe(false);
  });

  test("wrapping a file type is remembered for that type only, and read back after a reload", async () => {
    const m = await mount(pane("src/util.ts"));
    await m.until("the file loads", () => !!m.container.querySelector("[data-testid=file-editor]"));
    await openMenu(m, 'button[title="More"]');
    expect(item("view-wrap")!.getAttribute("aria-checked")).toBe("false");
    await click(m, item("view-wrap")!);
    expect(JSON.parse(localStorage.getItem(WRAP_KEY)!)).toEqual({ ".ts": true });
    m.unmount();

    resetWrapPrefs(); // as after a restart: read from storage again
    const again = await mount(pane("src/board.ts"));
    await again.until("the file loads", () => !!again.container.querySelector("[data-testid=file-editor]"));
    await openMenu(again, 'button[title="More"]');
    expect(item("view-wrap")!.getAttribute("aria-checked")).toBe("true");
    again.unmount();

    const md = await mount(pane("README.md"));
    await md.until("the file loads", () => !!md.container.querySelector("[data-testid=file-editor]"));
    await openMenu(md, 'button[title="More"]');
    expect(item("view-wrap")!.getAttribute("aria-checked")).toBe("false");
  });
});

describe("spec tab view menu", () => {
  const spec = (key: string) => {
    const ticket = world.tickets.find((t) => t.key === key)!;
    return <SpecTab ticket={ticket} />;
  };

  test("the menu holds Source, Rendered and Wrap lines, and the old Show changes switch is gone", async () => {
    const m = await mount(spec("HARNESS-5"));
    await m.until("the spec", () => !!m.container.querySelector("[data-testid=spec-doc]"));
    expect(m.container.querySelector(".switch")).toBeNull();
    await openMenu(m, '[data-testid="spec-more"]');
    expect(items()).toEqual(expect.arrayContaining(["Source", "Rendered", "Wrap lines"]));
    expect(item("view-source")!.getAttribute("aria-checked")).toBe("false");
    expect(item("view-rendered")!.getAttribute("aria-checked")).toBe("true");
  });

  test("a spec with one revision has no Show changes item", async () => {
    const one = { ...world.tickets.find((t) => t.key === "HARNESS-5")!, specRevision: 1 };
    const m = await mount(<SpecTab ticket={one} />);
    await m.until("the spec", () => !!m.container.querySelector("[data-testid=spec-doc]"));
    await openMenu(m, '[data-testid="spec-more"]');
    expect(item("view-changes")).toBeNull();
  });

  test("Show changes lives in the menu; while it's on the spec is rendered and Source is unavailable", async () => {
    const two = { ...world.tickets.find((t) => t.key === "HARNESS-5")!, specRevision: 2 };
    const m = await mount(<SpecTab ticket={two} />); // the fake service has no earlier revision to load; the menu doesn't need it
    await m.until("the history bar", () => !!m.container.querySelector("[data-testid=spec-more]"));
    await openMenu(m, '[data-testid="spec-more"]');
    expect(item("view-changes")!.getAttribute("aria-checked")).toBe("false");
    expect(item("view-source")!.disabled).toBe(false);
    await click(m, item("view-changes")!);
    await openMenu(m, '[data-testid="spec-more"]');
    expect(item("view-changes")!.getAttribute("aria-checked")).toBe("true");
    expect(item("view-source")!.disabled).toBe(true);
    expect(item("view-wrap")!.disabled).toBe(true);
  });
});
