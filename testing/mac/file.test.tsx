import { describe, expect, test } from "bun:test";
import { FilePane } from "../../app/src/renderer/views/FilePane";
import type { FileTab } from "../../app/src/renderer/state/paneModel";
import { mount, text } from "./render";

const pane = (path: string, tab: FileTab = "file") => <FilePane paneId="p1" content={{ kind: "file", root: { ticketKey: "HARNESS-5" }, path, tab }} zoomed={false} />;

describe("File pane", () => {
  test("a binary file says it can't be shown, with its size, instead of dumping bytes", async () => {
    const m = await mount(pane("assets/logo.png"));
    await m.until("the notice", () => text(m.container).includes("Binary file"));
    expect(text(m.container)).toContain("2.0 KB");
  });

  test("a file over the viewer's limit says how big it is", async () => {
    const m = await mount(pane("dist/bundle.js"));
    await m.until("the notice", () => text(m.container).includes("too large"));
    expect(text(m.container)).toContain("85.8 MB");
    expect(text(m.container)).toContain("ignored");
  });

  test("a file with uncommitted changes is badged and its diff opens", async () => {
    const m = await mount(pane("src/board.ts", "diff"));
    await m.until("the badge", () => text(m.container).includes("modified"));
    expect(m.client.requests).toContain("GET /tickets/HARNESS-5/file/diff?path=src%2Fboard.ts");
  });

  test("a clean file doesn't fetch a diff, even when its pane asks for the Diff tab", async () => {
    const m = await mount(pane("src/util.ts", "diff"));
    await m.until("the file loads", () => m.client.requests.some((r) => r.includes("/file?path=src%2Futil.ts")));
    await m.settle();
    expect(m.client.requests.some((r) => r.includes("/file/diff"))).toBe(false);
    expect(text(m.container)).not.toContain("modified");
  });

  test("a file the service can't find shows the failure", async () => {
    const m = await mount(pane("src/gone.ts"));
    await m.until("the error", () => /not found|couldn't|failed/i.test(text(m.container)));
    expect(m.client.unrouted).toContain("GET /tickets/HARNESS-5/file?path=src%2Fgone.ts");
  });
});
