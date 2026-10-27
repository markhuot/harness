import { describe, expect, test } from "bun:test";
import { act } from "react";
import { PaneWorkspace } from "../../app/src/renderer/components/PaneWorkspace";
import { dragProps } from "../../app/src/renderer/components/paneDrag";
import { registerLeaveGuard } from "../../app/src/renderer/components/draftClose";
import { getPanes, updatePanes } from "../../app/src/renderer/state/panes";
import { findLeaf } from "../../app/src/renderer/state/paneModel";
import { mount, type Mounted } from "./render";
import { board, row, st, ticket } from "../l0/renderer/paneBuild";

const WIDTH = 1000;
const HEIGHT = 600;

/** The workspace with a board and two ticket panes (A-1 at 50-75% across, A-2 at 75-100%), and a card to drag. */
async function setup(scope: string) {
  const m = await mount(
    <>
      <div data-testid="card" {...dragProps({ kind: "ticket", ticketKey: "HARNESS-9" }, { chip: "HARNESS-9", title: "Card" }, scope)} />
      <PaneWorkspace scope={scope} />
    </>,
  );
  await m.settle(() => updatePanes(scope, () => st(row("r", [board("B"), ticket("a", "HARNESS-1"), ticket("b", "HARNESS-2")], [0.5, 0.25, 0.25]), "B")));
  const ws = m.container.querySelector<HTMLElement>("[data-testid=pane-workspace]")!;
  ws.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, toJSON: () => ({}) });
  return m;
}

const dataTransfer = (types: string[]) => ({ types, setData() {}, getData: () => "", setDragImage() {}, effectAllowed: "", dropEffect: "" });

/** Start dragging the card, then move over the layer at (x, y) in workspace pixels. */
async function dragTo(m: Mounted, x: number, y: number, kind: "dragover" | "drop" = "dragover") {
  const send = (el: Element, type: string) =>
    el.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: dataTransfer(["application/x-harness-ticket"]), clientX: x, clientY: y }));
  const q = (id: string) => m.container.querySelector<HTMLElement>(`[data-testid=${id}]`);
  if (!q("pane-drop-layer")) {
    await act(async () => {
      send(q("card")!, "dragstart");
      await new Promise((r) => setTimeout(r, 5)); // the drag becomes active a tick after dragstart
    });
    await m.until("the drop layer", () => !!q("pane-drop-layer"));
  }
  await act(async () => void send(q("pane-drop-layer")!, kind));
}
const preview = (m: Mounted) => m.container.querySelector<HTMLElement>("[data-testid=pane-drop-preview]");

describe("DropLayer: replace in the middle third", () => {
  test("dragging over the middle of a pane previews replacing the whole pane", async () => {
    const m = await setup("drop-mid");
    await dragTo(m, 625, 300); // the centre of pane a (x 500-750)
    expect(preview(m)).toMatchObject({ dataset: { zone: "replace", target: "a" } });
    expect(preview(m)!.style.width).toBe("25%"); // the whole pane, not half of it
  });
  test("an edge of the same pane still previews a split of it", async () => {
    const m = await setup("drop-edge");
    await dragTo(m, 735, 300);
    expect(preview(m)).toMatchObject({ dataset: { zone: "right", target: "a" } });
    expect(preview(m)!.style.width).toBe("12.5%");
  });
  test("dropping in the middle replaces the pane's content, keeping its slot", async () => {
    const m = await setup("drop-apply");
    await dragTo(m, 625, 300, "drop");
    expect(findLeaf(getPanes("drop-apply").root, "a")?.content).toMatchObject({ kind: "ticket", ticketKey: "HARNESS-9" });
    expect(getPanes("drop-apply").root).toMatchObject({ children: [{ id: "B" }, { id: "a" }, { id: "b" }] });
  });
  test("over the board's middle there's nothing to replace", async () => {
    const m = await setup("drop-board");
    await dragTo(m, 250, 300);
    expect(preview(m)).toBeNull();
  });
  test("a pane with unsaved edits that won't go is not replaced", async () => {
    const m = await setup("drop-guard");
    let asked = 0;
    registerLeaveGuard("a", () => (asked++, false));
    await dragTo(m, 625, 300, "drop");
    expect(asked).toBe(1);
    expect(findLeaf(getPanes("drop-guard").root, "a")?.content).toMatchObject({ ticketKey: "HARNESS-1" });
  });
});
