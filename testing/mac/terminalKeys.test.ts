// The keys a terminal view sends for Option chords, through the real ghostty-web encoder so a change in
// what it emits for the keys we don't remap is caught too.
import { afterEach, expect, test } from "bun:test";
import { createTerminalView, loadGhostty, type TerminalView } from "../../terminal/src/view";

const ctx: unknown = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }) : k === "canvas" ? undefined : () => ({})), set: () => true });
HTMLCanvasElement.prototype.getContext = (() => ctx) as never;

let view: TerminalView | null = null;
afterEach(() => view?.dispose());

async function setup(keyHandler?: (e: KeyboardEvent) => boolean) {
  const sent: string[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  view = createTerminalView(await loadGhostty(), {
    container, id: "t", theme: {}, fontFamily: "monospace", fontSize: 13,
    onData: (d) => sent.push(d), onViewport() {}, onResync() {}, keyHandler,
  });
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    view!.term.element!.dispatchEvent(e);
    return e;
  };
  return { sent, press };
}

test("Opt+← and Opt+→ move by word (ESC b / ESC f)", async () => {
  const { sent, press } = await setup();
  press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });
  press({ key: "ArrowRight", code: "ArrowRight", altKey: true });
  expect(sent).toEqual(["\x1bb", "\x1bf"]);
});

test("Opt+Backspace deletes a word (ESC DEL)", async () => {
  const { sent, press } = await setup();
  press({ key: "Backspace", code: "Backspace", altKey: true });
  expect(sent).toEqual(["\x1b\x7f"]);
});

test("Shift+Opt+← and Ctrl+Opt+← are not remapped", async () => {
  const { sent, press } = await setup();
  press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, shiftKey: true });
  press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, ctrlKey: true });
  expect(sent).toEqual(["\x1b[1;4D", "\x1b[1;7D"]);
});

test("Opt+← while composing is not remapped", async () => {
  const { sent, press } = await setup();
  press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true, isComposing: true });
  expect(sent).not.toContain("\x1bb");
});

test("plain ← is untouched and Opt+letter types the character it produced", async () => {
  const { sent, press } = await setup();
  press({ key: "ArrowLeft", code: "ArrowLeft" });
  press({ key: "@", code: "KeyL", altKey: true });
  expect(sent).toEqual(["\x1b[D", "@"]);
});

test("the app's own key handler still runs for other keys", async () => {
  const seen: string[] = [];
  const { sent, press } = await setup((e) => (seen.push(e.key), e.key === "k"));
  const e = press({ key: "k", code: "KeyK", metaKey: true });
  expect(seen).toEqual(["k"]);
  expect(sent).toEqual([]);
  expect(e.defaultPrevented).toBe(true);
});
