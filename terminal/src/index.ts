// The terminal bundle's entry: the IIFE exposes `HarnessTerminal` on window (scripts/build.ts).
// The Mac pane imports `createTerminalView` and the feed directly; iOS drives `mount` from Swift.

export { createTerminalView, loadGhostty, type GhosttyModule, type TerminalTheme, type TerminalView, type ViewOptions } from "./view";
export { TerminalFeed, dropBytes, isTerminalMessage, type TerminalMessage, type TerminalSink } from "./session";
export { ctrlChar, keyboardPan, viewportFor, SCROLLBAR_WIDTH, type CellSize } from "./layout";
export { mount, type BridgeCommand, type BridgeEvent, type BridgeProbe, type Mounted } from "./bridge";

import { mount } from "./bridge";

declare global {
  interface Window {
    /** Set by the iOS web view: `webkit.messageHandlers.terminal.postMessage` and the page's commands. */
    harnessTerminal?: ReturnType<typeof mount>;
  }
}
