// ghostty-web's render loop only paints rows that changed, and it has no public full redraw. After the
// keyboard pans the stage the canvas can be left stale, so the view forces one once the pan settles.

/** The slice of ghostty-web's Terminal (private renderer fields included) that a full redraw reads. */
export interface RedrawTerm {
  renderer?: { render(buffer: unknown, forceAll: boolean, viewportY: number, scrollbar: unknown, opacity: number): void };
  wasmTerm?: unknown;
  viewportY: number;
  scrollbarOpacity: number;
}

/**
 * Draw every row through ghostty-web's renderer (`render(..., forceAll = true, ...)`). Those fields are
 * private, so when a ghostty-web upgrade moves them this warns instead of silently drawing nothing.
 */
export function forceRedraw(term: RedrawTerm, warn: (message: string) => void = console.warn): void {
  if (typeof term.renderer?.render !== "function") return warn("terminal: ghostty-web's renderer is gone, so the full repaint after the keyboard moves nothing");
  term.renderer.render(term.wasmTerm, true, term.viewportY, term, term.scrollbarOpacity);
}

/** One pending call at a time: scheduling again replaces the pending one, and cancel drops it. */
export function createRepaintTimer(run: () => void, delayMs: number) {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (pending) clearTimeout(pending);
    pending = null;
  };
  return {
    schedule() {
      cancel();
      pending = setTimeout(() => {
        pending = null;
        run();
      }, delayMs);
    },
    cancel,
  };
}
