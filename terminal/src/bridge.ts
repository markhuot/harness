// A host-agnostic bridge for the iOS web view: `mount(window, post)` reports events to `post` as
// JSON-safe objects, and the host drives the terminal with `receive(command)` (also on
// `window.harnessTerminal`). The socket stays in Swift (HarnessSocket), so auth and reconnects live
// in one place: Swift forwards each terminal.* message in, and the bridge posts back what to send.

import type { ServerMessage } from "@harness/shared";
import type { ResolvedTheme } from "@harness/shared/state";
import type { ThemeTokens } from "@harness/shared/themes";
import { terminalColors } from "./colors";
import { createTerminalView, loadGhostty, type TerminalView } from "./view";
import { ctrlChar, keyboardPan } from "./layout";
import { isTerminalMessage } from "./session";

/** The app theme the host sends: the page turns it into the terminal's colors (colors.ts). */
export interface BridgeTheme {
  appearance: ResolvedTheme;
  tokens: ThemeTokens;
}

export type BridgeCommand =
  | { type: "open"; id: string; theme: BridgeTheme; fontFamily?: string; fontSize?: number }
  /** A terminal.* message from the service. */
  | { type: "message"; message: ServerMessage }
  /** The socket dropped: draw nothing until the next snapshot. */
  | { type: "reconnecting" }
  /** New colors: ghostty-web can't recolor an open terminal, so the view is rebuilt (and resyncs). */
  | { type: "theme"; theme: BridgeTheme }
  | { type: "fontSize"; fontSize: number }
  | { type: "focus" }
  | { type: "blur" }
  | { type: "paste"; text: string }
  /** The Ctrl accessory key: the next typed letter becomes its control character. */
  | { type: "ctrl"; on: boolean }
  /** The soft keyboard now covers this many points of the web view (0: hidden). */
  | { type: "inset"; bottom: number };

export type BridgeEvent =
  | { type: "ready" }
  /** Typed, pasted or answered input for the shell. */
  | { type: "input"; data: string }
  /** What the web view could show; the service sizes the shell by the smallest client. */
  | { type: "viewport"; cols: number; rows: number }
  | { type: "title"; title: string }
  | { type: "exit"; exitCode: number | null }
  /** Output was lost: detach and attach again. */
  | { type: "resync" }
  | { type: "truncated" }
  | { type: "ctrl"; on: boolean }
  | { type: "bell" }
  | { type: "error"; message: string };

/** What the debug state probe reads from the page (ios/HarnessKit DebugState.TerminalState). */
export interface BridgeProbe {
  cols: number;
  rows: number;
  synced: boolean;
  offset: number;
  /** The visible screen as text, one line per row. */
  screen: string[];
  ctrl: boolean;
  keyboardInset: number;
}

export interface Mounted {
  receive(command: BridgeCommand): void;
  probe(): BridgeProbe | null;
  destroy(): void;
}

const DEFAULT_FONT = "ui-monospace, Menlo, monospace";

export function mount(win: Window, post: (event: BridgeEvent) => void, parent?: HTMLElement): Mounted {
  const root = parent ?? win.document.body;
  let view: TerminalView | undefined;
  let open: { id: string; theme: BridgeTheme; fontFamily: string; fontSize: number } | undefined;
  let ctrl = false;
  let inset = 0;
  let lastViewport: { cols: number; rows: number } | null = null;

  const setCtrl = (on: boolean) => {
    if (ctrl === on) return;
    ctrl = on;
    post({ type: "ctrl", on });
  };

  const build = async () => {
    if (!open) return;
    view?.dispose();
    root.replaceChildren();
    const ghostty = await loadGhostty();
    const o = open;
    view = createTerminalView(ghostty, {
      container: root,
      id: o.id,
      theme: terminalColors(o.theme.tokens, o.theme.appearance),
      fontFamily: o.fontFamily,
      fontSize: o.fontSize,
      onData: (data) => {
        const mapped = ctrl ? ctrlChar(data) : null;
        if (ctrl) setCtrl(false);
        post({ type: "input", data: mapped ?? data });
      },
      onViewport: (v) => {
        lastViewport = v;
        post({ type: "viewport", ...v });
      },
      onTitle: (title) => post({ type: "title", title }),
      onBell: () => post({ type: "bell" }),
      onResync: () => post({ type: "resync" }),
      onExit: (exitCode) => post({ type: "exit", exitCode }),
      onTruncated: () => post({ type: "truncated" }),
    });
  };

  const pan = () => {
    if (!view) return;
    const rect = root.firstElementChild?.getBoundingClientRect();
    view.pan(keyboardPan(view.cursorBottom(), rect?.top ?? 0, win.innerHeight, inset));
  };

  const fail = (e: unknown) => post({ type: "error", message: e instanceof Error ? e.message : String(e) });

  return {
    receive(command) {
      switch (command.type) {
        case "open":
          open = { id: command.id, theme: command.theme, fontFamily: command.fontFamily ?? DEFAULT_FONT, fontSize: command.fontSize ?? 13 };
          build().then(() => post({ type: "ready" }), fail);
          return;
        case "message":
          if (isTerminalMessage(command.message)) view?.handle(command.message);
          if (command.message.type === "terminal.snapshot") pan();
          return;
        case "reconnecting":
          view?.feed.reconnecting();
          // The new socket attaches with this viewport again.
          if (lastViewport) post({ type: "viewport", ...lastViewport });
          return;
        case "theme":
          if (!open) return;
          open.theme = command.theme;
          build().then(() => post({ type: "resync" }), fail);
          return;
        case "fontSize":
          if (!open) return;
          open.fontSize = command.fontSize;
          build().then(() => post({ type: "resync" }), fail);
          return;
        case "focus":
          view?.focus();
          return;
        case "blur":
          (win.document.activeElement as HTMLElement | null)?.blur();
          return;
        case "paste":
          view?.term.paste(command.text);
          return;
        case "ctrl":
          setCtrl(command.on);
          return;
        case "inset":
          inset = command.bottom;
          pan();
          return;
      }
    },
    probe() {
      if (!view) return null;
      const buffer = view.term.buffer.active;
      const screen: string[] = [];
      for (let y = 0; y < view.term.rows; y++) screen.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "");
      return { cols: view.term.cols, rows: view.term.rows, synced: view.feed.isSynced, offset: view.feed.offset, screen, ctrl, keyboardInset: inset };
    },
    destroy() {
      view?.dispose();
      view = undefined;
      root.replaceChildren();
    },
  };
}
