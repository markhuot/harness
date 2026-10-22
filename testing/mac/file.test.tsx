import { describe, expect, test } from "bun:test";
import { HarnessApiError } from "@harness/shared";
import type { EditorHandle } from "../../editor/src/editor";
import { FilePane } from "../../app/src/renderer/views/FilePane";
import type { FileTab } from "../../app/src/renderer/state/paneModel";
import { click, mount, text, type Mounted } from "./render";

const pane = (path: string, tab: FileTab = "file") => <FilePane paneId="p1" content={{ kind: "file", root: { ticketKey: "HARNESS-5" }, path, tab }} zoomed={false} />;

/**
 * The pane's editor, once it has loaded the file. Typing is the editor component's own (and it draws no
 * lines under happy-dom): these tests edit through its handle, replacing the buffer and saying the disk
 * still has what was loaded, which is the state a typed edit leaves.
 */
async function editor(m: Mounted): Promise<EditorHandle> {
  const host = () => m.container.querySelector<HTMLElement & { harnessEditor?: EditorHandle }>("[data-testid=file-editor]");
  await m.until("the editor", () => !!host()?.harnessEditor);
  return host()!.harnessEditor!;
}
function edit(ed: EditorHandle, contents: string, onDisk: string) {
  ed.setContents(contents);
  ed.markSaved(onDisk);
}
const dirty = (m: Mounted) => !!m.container.querySelector("[data-testid=file-dirty]");
const save = (m: Mounted) => m.container.querySelector<HTMLButtonElement>("[data-testid=file-save]")!;

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

  test("an edit marks the file unsaved, and Save writes it to the ticket's worktree and clears the mark", async () => {
    const m = await mount(pane("src/util.ts"));
    const ed = await editor(m);
    expect(save(m).disabled).toBe(true);
    const loaded = ed.getContents();
    const edited = `// edited\n${loaded}`;
    await m.settle(() => edit(ed, edited, loaded));
    await m.until("the dirty marker", () => dirty(m));
    await click(m, save(m));
    await m.until("the mark to clear", () => !dirty(m));
    expect(m.client.bodies.filter((b) => b.request === "PUT /tickets/HARNESS-5/file").map((b) => b.body)).toEqual([{ path: "src/util.ts", contents: edited }]);
    expect(save(m).disabled).toBe(true);
  });

  test("a save the service refuses keeps the unsaved mark and says why", async () => {
    const m = await mount(pane("src/util.ts"));
    m.client.overrides.set("PUT /tickets/HARNESS-5/file", () => {
      throw new HarnessApiError(500, "disk full");
    });
    const ed = await editor(m);
    const loaded = ed.getContents();
    await m.settle(() => edit(ed, `// edited\n${loaded}`, loaded));
    await m.until("the dirty marker", () => dirty(m));
    await click(m, save(m));
    await m.until("the error", () => m.toasts.length > 0);
    expect(m.toasts).toEqual([{ message: "Couldn't save src/util.ts: disk full", kind: "error" }]);
    expect(dirty(m)).toBe(true);
    expect(save(m).disabled).toBe(false);
    // Unsaved changes would ask to be saved when the pane closes after the test.
    await m.settle(() => ed.markSaved(ed.getContents()));
  });
});
