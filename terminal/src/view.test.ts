import { afterAll, beforeAll, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import type { GhosttyModule } from "./view";
import { createTerminalView } from "./view";

// A stand-in for ghostty-web that does what its open() does to the DOM: the stage becomes the
// contenteditable focus target and a hidden textarea is added.
class FakeTerminal {
  element?: HTMLElement;
  textarea?: HTMLTextAreaElement;
  cols = 80;
  rows = 24;
  renderer = { getMetrics: () => ({ width: 8, height: 16 }) };
  open(stage: HTMLElement) {
    this.element = stage;
    stage.setAttribute("contenteditable", "true");
    this.textarea = document.createElement("textarea");
    stage.append(this.textarea);
  }
  attachCustomKeyEventHandler() {}
  onData() {}
  onTitleChange() {}
  onBell() {}
  resize() {}
  focus() {}
  dispose() {}
}
const ghostty = { Terminal: FakeTerminal } as unknown as GhosttyModule;

const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "getComputedStyle", "ResizeObserver", "requestAnimationFrame"];
beforeAll(() => {
  const win = new Window({ width: 400, height: 300 });
  const globals = globalThis as Record<string, unknown>;
  for (const k of GLOBALS) {
    saved[k] = globals[k];
    globals[k] = k === "window" ? win : k === "getComputedStyle" ? win.getComputedStyle.bind(win) : k === "requestAnimationFrame" ? () => 0 : k === "ResizeObserver" ? class { observe() {} disconnect() {} } : (win as never)[k];
  }
  jest.useFakeTimers();
});
afterAll(() => {
  jest.useRealTimers();
  for (const k of GLOBALS) (globalThis as Record<string, unknown>)[k] = saved[k];
});

const make = () => {
  const container = document.createElement("div");
  document.body.append(container);
  return createTerminalView(ghostty, { container, id: "t", theme: {}, fontFamily: "mono", fontSize: 13, onData() {}, onViewport() {}, onResync() {} });
};

test("the contenteditable stage and ghostty's textarea both get the hardened input attributes after open", () => {
  const view = make();
  for (const el of [view.term.element!, view.term.textarea!]) {
    expect(el.style.caretColor).toBe("transparent");
    expect(el.getAttribute("autocapitalize")).toBe("none");
    expect(el.getAttribute("autocorrect")).toBe("off");
    expect(el.getAttribute("spellcheck")).toBe("false");
  }
  expect(view.term.element!.getAttribute("contenteditable")).toBe("true");
});
