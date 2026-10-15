// A terminal drawn by ghostty-web (Ghostty's VT core as WASM, on a canvas), used by the Mac pane
// and by the iOS web view. It draws the shell at the size the service says (the smallest attached
// client's), centered in its container, and reports how many columns and rows its container could
// show, which is what the service sizes by. When the shell is smaller than the container the rest
// stays empty; for the instant before a change is confirmed the container clips what overflows.

import type { Terminal } from "ghostty-web";
import { viewportFor, type CellSize } from "./layout";
import { TerminalFeed, type TerminalMessage, type TerminalSink } from "./session";

export type GhosttyModule = typeof import("ghostty-web");

/** ghostty-web's WASM core is inlined into the module; init() once per page. */
let loaded: Promise<GhosttyModule> | null = null;
export const loadGhostty = (): Promise<GhosttyModule> => (loaded ??= import("ghostty-web").then(async (m) => (await m.init(), m)));

/** ghostty-web's ITheme subset we set, all #rrggbb. */
export type TerminalTheme = Record<string, string>;

export interface ViewOptions {
  /** The viewport the terminal is centered in; the view makes it a flex box and clips it. */
  container: HTMLElement;
  /** The terminal's id: the messages it draws are the ones for this id. */
  id: string;
  theme: TerminalTheme;
  fontFamily: string;
  fontSize: number;
  /** Typed (or pasted, or answered) input for the shell. */
  onData(data: string): void;
  /** How many columns and rows the container could show; reported once measured and whenever it changes. */
  onViewport(size: { cols: number; rows: number }): void;
  onTitle?(title: string): void;
  onBell?(): void;
  /** The service says it needs a fresh snapshot (output was lost). */
  onResync(): void;
  onExit?(exitCode: number | null): void;
  onTruncated?(): void;
  /** ghostty-web's inverted contract: true means "handled, don't process". */
  keyHandler?(e: KeyboardEvent): boolean;
  /** Reports are debounced; default 100 ms. */
  debounceMs?: number;
}

export interface TerminalView {
  readonly term: Terminal;
  readonly feed: TerminalFeed;
  /** The container's capacity now, or null before it can be measured. */
  viewport(): { cols: number; rows: number } | null;
  handle(msg: TerminalMessage): void;
  /** Shift the stage up by this many pixels (the soft keyboard is covering the lower part). */
  pan(px: number): void;
  /** The cursor row's bottom edge in the stage, in pixels. */
  cursorBottom(): number;
  focus(): void;
  dispose(): void;
}

export function createTerminalView(ghostty: GhosttyModule, o: ViewOptions): TerminalView {
  const { container } = o;
  Object.assign(container.style, { display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" });
  const stage = document.createElement("div");
  stage.className = "terminal-stage";
  stage.style.flex = "none";
  stage.style.transition = "transform 0.15s";
  container.append(stage);

  const term = new ghostty.Terminal({ fontFamily: o.fontFamily, fontSize: o.fontSize, cursorBlink: true, theme: o.theme });
  term.open(stage);
  if (o.keyHandler) term.attachCustomKeyEventHandler(o.keyHandler);
  term.onData((d) => o.onData(d));
  term.onTitleChange((t) => o.onTitle?.(t));
  term.onBell(() => o.onBell?.());

  const cell = (): CellSize | null => {
    const m = term.renderer?.getMetrics();
    return m && m.width > 0 && m.height > 0 ? { width: m.width, height: m.height } : null;
  };
  const viewport = () => {
    const c = cell();
    return c ? viewportFor(container.clientWidth, container.clientHeight, c) : null;
  };

  let last = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = () => {
    timer = null;
    const v = viewport();
    if (!v) return;
    const key = `${v.cols}x${v.rows}`;
    if (key === last) return;
    last = key;
    o.onViewport(v);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(report, o.debounceMs ?? 100);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(container);
  // Before the first snapshot, draw at what the container holds; the first report goes out at once.
  const first = viewport();
  if (first) {
    term.resize(first.cols, first.rows);
    report();
  } else requestAnimationFrame(() => (viewport() ? report() : schedule()));

  const sink: TerminalSink = {
    reset(cols, rows) {
      term.reset();
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    },
    write: (data) => term.write(data),
    resize(cols, rows) {
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    },
    exited: (code) => o.onExit?.(code),
    truncated: () => o.onTruncated?.(),
  };
  const feed = new TerminalFeed(o.id, sink, o.onResync);

  return {
    term,
    feed,
    viewport,
    handle: (msg) => feed.handle(msg),
    pan(px) {
      stage.style.transform = px > 0 ? `translateY(${-px}px)` : "";
    },
    cursorBottom() {
      const c = cell();
      const buffer = term.buffer.active;
      return c ? (buffer.cursorY + 1) * c.height : 0;
    },
    focus: () => term.focus(),
    dispose() {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      term.dispose();
      stage.remove();
    },
  };
}
