// A roving tabindex for a list (the sidebar, the inbox, a conductor's Tickets tab): the list is one
// Tab stop, and the "list" commands (j/k, ↑/↓, g/G, Home/End; state/keys.ts) move the focus
// between its items. The component marks its items with data-roving-item and spreads
// keysArea("list", owner) on the container itself, so the keys reach this owner while the focus is
// inside the list and the area's commands can be looked up from there.
//
// Movement stops at the ends rather than wrapping: a list is read top to bottom, and hitting the end
// (g/G jump there anyway) tells you where you are. Menus wrap instead (bits.tsx MenuButton).

import { useLayoutEffect, useRef, type RefObject } from "react";
import { useCommands } from "./commands";

export type RovingMove = "next" | "prev" | "first" | "last";

/**
 * The index a move lands on in a list of `count` items, from `current` (-1 when no item has the
 * focus: next/prev then start at the first/last). Without `wrap` it stops at the ends. -1 for an
 * empty list.
 */
export function rovingIndex(count: number, current: number, move: RovingMove, wrap = false): number {
  if (count <= 0) return -1;
  if (move === "first") return 0;
  if (move === "last") return count - 1;
  if (current < 0 || current >= count) return move === "next" ? 0 : count - 1;
  const to = current + (move === "next" ? 1 : -1);
  if (wrap) return (to + count) % count;
  return Math.max(0, Math.min(count - 1, to));
}

/**
 * Which item is the Tab stop: the remembered one while it's still in the list, except that a marked
 * item (the current route's, aria-current or .active) takes over while the focus is elsewhere, so
 * coming back to the list lands on what's on screen. Otherwise the marked item, else the first.
 */
export function tabStopIndex(items: { remembered: boolean; marked: boolean }[], focusInside: boolean): number {
  const remembered = items.findIndex((i) => i.remembered);
  const marked = items.findIndex((i) => i.marked);
  if (remembered >= 0 && (focusInside || marked < 0)) return remembered;
  if (marked >= 0) return marked;
  return items.length ? 0 : -1;
}

const isMarked = (el: HTMLElement) => el.classList.contains("active") || (el.hasAttribute("aria-current") && el.getAttribute("aria-current") !== "false");

/** Items that can take the focus now (not disabled, not hidden). */
function itemsIn(root: HTMLElement, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
}

export function useRovingList(ref: RefObject<HTMLElement | null>, { owner, itemSelector = "[data-roving-item]" }: { owner: string; itemSelector?: string }) {
  const current = useRef<HTMLElement | null>(null);

  // Give exactly one item tabIndex 0. Re-applied whenever the list's items or their marks change
  // (a MutationObserver; tabindex itself isn't watched, so applying doesn't retrigger it), and when
  // focus lands on an item by click or Tab.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const apply = () => {
      const all = [...root.querySelectorAll<HTMLElement>(itemSelector)];
      const items = itemsIn(root, itemSelector);
      const focusInside = root.contains(document.activeElement);
      const stop = items[tabStopIndex(items.map((el) => ({ remembered: el === current.current, marked: isMarked(el) })), focusInside)] ?? null;
      if (!focusInside) current.current = stop;
      for (const el of all) {
        const t = el === stop ? 0 : -1;
        if (el.tabIndex !== t) el.tabIndex = t;
      }
    };
    const onFocus = (e: FocusEvent) => {
      const item = (e.target as Element).closest<HTMLElement>(itemSelector);
      if (!item || !root.contains(item) || item === current.current) return;
      current.current = item;
      apply();
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-current", "disabled", "hidden"] });
    root.addEventListener("focusin", onFocus);
    return () => {
      mo.disconnect();
      root.removeEventListener("focusin", onFocus);
    };
  }, [ref, itemSelector]);

  const move = (to: RovingMove) => () => {
    const root = ref.current;
    if (!root) return;
    const items = itemsIn(root, itemSelector);
    const from = (document.activeElement?.closest<HTMLElement>(itemSelector) ?? null) || current.current;
    const el = items[rovingIndex(items.length, from ? items.indexOf(from) : -1, to)];
    if (!el) return;
    current.current = el;
    el.focus();
    el.scrollIntoView({ block: "nearest" });
  };

  useCommands(owner, {
    "list.next": move("next"),
    "list.prev": move("prev"),
    "list.first": move("first"),
    "list.last": move("last"),
  });
}
