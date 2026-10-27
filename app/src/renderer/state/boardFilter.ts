// The board's search box is local to each board pane; the sidebar's Labels section needs to read
// and set it. This is the small seam between them: boards report what they show, and a request
// from the sidebar is handed to every mounted board.

import { useEffect } from "react";

let current = "";
const requests = new Set<(q: string) => void>();
const watchers = new Set<() => void>();

/** What the most recently edited board's search box holds. */
export const boardFilter = () => current;

/** A board reports its search box. */
export function reportBoardFilter(q: string) {
  if (q === current) return;
  current = q;
  watchers.forEach((w) => w());
}

/** Ask the mounted boards to search for `q`. */
export function requestBoardFilter(q: string) {
  current = q;
  requests.forEach((r) => r(q));
  watchers.forEach((w) => w());
}

export function subscribeBoardFilter(fn: () => void) {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

/** A board applies the sidebar's requests to its own search box. */
export function useBoardFilterRequests(apply: (q: string) => void) {
  useEffect(() => {
    requests.add(apply);
    return () => void requests.delete(apply);
  }, [apply]);
}
