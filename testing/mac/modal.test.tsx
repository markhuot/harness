import { describe, expect, jest, test } from "bun:test";
import { Modal } from "../../app/src/renderer/components/bits";
import { mount } from "./render";

// A question dialog sits inside a pane that has its own ⌘↩ (the draft pane's Start session).
const open = (onSubmit?: () => void) => {
  const pane = jest.fn();
  const onClose = jest.fn();
  const view = (
    <div onKeyDown={pane}>
      <Modal onClose={onClose} onSubmit={onSubmit}>
        <button>Save</button>
      </Modal>
    </div>
  );
  return { pane, onClose, view };
};
const press = (m: { container: HTMLElement; settle: (fn: () => void) => Promise<void> }, init: KeyboardEventInit) =>
  m.settle(() => {
    m.container.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });

describe("Modal with onSubmit", () => {
  test("⌘↩ answers the dialog and never reaches the pane under it", async () => {
    const onSubmit = jest.fn();
    const { pane, view } = open(onSubmit);
    const m = await mount(view);
    await press(m, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(pane).not.toHaveBeenCalled();
  });

  test("other ⌘ shortcuts are swallowed too, without answering", async () => {
    const onSubmit = jest.fn();
    const { pane, view } = open(onSubmit);
    const m = await mount(view);
    await press(m, { key: "w", metaKey: true });
    await press(m, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(pane).not.toHaveBeenCalled();
  });

  test("plain keys still reach the pane, and Escape still closes", async () => {
    const { pane, onClose, view } = open(() => {});
    const m = await mount(view);
    await press(m, { key: "Enter" });
    expect(pane).toHaveBeenCalledTimes(1);
    await press(m, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("without onSubmit a modal leaves ⌘ shortcuts alone", async () => {
    const { pane, view } = open();
    const m = await mount(view);
    await press(m, { key: "Enter", metaKey: true });
    expect(pane).toHaveBeenCalledTimes(1);
  });
});
