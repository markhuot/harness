// Small presentational pieces shared across views.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ReviewState, Ticket, TicketStatus } from "@harness/shared";
import { driverIcon, driverLabel, STATUS_LABEL } from "@harness/shared/state";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { rovingIndex, type RovingMove } from "./useRovingList";

export { driverLabel, relativeTime, STATUS_LABEL } from "@harness/shared/state";

export function StatusDot({ status }: { status: TicketStatus }) {
  return <span className="status-dot" data-status={status} style={{ ["--dot" as string]: `var(--c-${status})` }} />;
}

export function StatusPill({ status }: { status: TicketStatus }) {
  return (
    <span className="status-pill">
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DriverBadge({ driver }: { driver: string }) {
  return (
    <span className="badge badge-outline driver-badge" data-driver={driver} title={`Driver: ${driver}`}>
      <Icon name={driverIcon(driver)} />
      {driverLabel(driver)}
    </span>
  );
}

export function ReviewMark({ who, state }: { who: "agent" | "human"; state: ReviewState }) {
  const cls = state === "approved" ? "badge-green" : state === "changes_requested" ? "badge-red" : "";
  const label = who === "agent" ? "Agent" : "Human";
  return (
    <span className={`badge ${cls}`} title={`${label} review: ${state.replace("_", " ")}`}>
      <Icon name={who === "agent" ? "bot" : "user"} />
      {state === "approved" ? <Icon name="check" strokeWidth={2.5} /> : state === "changes_requested" ? <Icon name="x" strokeWidth={2.5} /> : <span className="pending-dot" />}
    </span>
  );
}

export function KindBadge({ ticket, childCount }: { ticket: Ticket; childCount?: number }) {
  if (ticket.kind !== "conductor") return null;
  return (
    <span className="badge badge-violet" title="Conductor: orchestrates child tickets">
      <Icon name="conductor" />
      Conductor{childCount ? ` · ${childCount}` : ""}
    </span>
  );
}

/** Re-render periodically so relative timestamps stay fresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable=true]';

/** What Tab can reach inside `root`, in DOM order. */
const focusablesIn = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0 && !el.closest("[inert]"));

/** Each open menu's trigger, so a modal opened from a menu item returns the focus there (the item is gone by then). */
const menuTriggers = new WeakMap<Element, HTMLElement>();

/** Where focus goes back to when a modal opened now closes: the focus, or the trigger of the menu it's in. */
function modalOpener(): HTMLElement | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || a === document.body) return null;
  const menu = a.closest(".menu");
  return (menu && menuTriggers.get(menu)) ?? a;
}

/**
 * A dialog over the app. It keeps the focus: Tab and ⇧Tab cycle inside it, it focuses its first
 * control unless something in it autofocused, and it gives the focus back to what had it (read at
 * its first render, before it takes the focus) when it closes.
 */
export function Modal({ onClose, children, width, className }: { onClose: () => void; children: ReactNode; width?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [opener] = useState(modalOpener);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const m = ref.current;
      // Only the topmost modal traps.
      const modals = document.querySelectorAll(".modal");
      if (!m || modals[modals.length - 1] !== m) return;
      const f = focusablesIn(m);
      const a = document.activeElement as HTMLElement | null;
      const i = a ? f.indexOf(a) : -1;
      // Somewhere inside that Tab doesn't stop (a focused region): Tab carries on from there.
      if (i < 0 && a && m.contains(a)) return;
      const to = e.shiftKey ? (i <= 0 ? f[f.length - 1] : null) : i < 0 || i === f.length - 1 ? f[0] : null;
      if (!f.length || to) e.preventDefault();
      to?.focus();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [onClose]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    // Children's autoFocus has run by now (it's applied as they mount).
    if (!m.contains(document.activeElement)) focusablesIn(m)[0]?.focus();
    return () => {
      // Runs before the modal leaves the DOM. Focus that already moved elsewhere stays there.
      const a = document.activeElement;
      if (opener?.isConnected && (!a || a === document.body || m.contains(a))) opener.focus();
    };
  }, [opener]);
  return (
    <div className={className ? `overlay ${className}` : "overlay"} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined} role="dialog">
        {children}
      </div>
    </div>
  );
}

/** On/off switch. Pass ariaLabel when there's no visible label (e.g. the title sits in a settings Row). */
export function Switch({ checked, onChange, label, ariaLabel, title }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; ariaLabel?: string; title?: string }) {
  return (
    <label className="switch" title={title}>
      <input type="checkbox" role="switch" aria-label={ariaLabel} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {label}
    </label>
  );
}

/**
 * Dropdown menu anchored to its trigger. The menu renders in a portal with fixed positioning, so a
 * pane's `overflow: hidden` can't clip it, and placeMenu keeps it inside the window: shifted left or
 * right at the sides, flipped above the trigger near the bottom, scrolling when it's taller than the
 * room. It's measured hidden, then placed, and follows the trigger on resize and scroll.
 *
 * From the keyboard it's a menu: opening focuses the first item (plain buttons in it get
 * role="menuitem"), ↑/↓ move and wrap, Home/End go to the ends, Enter/Space activate, and Escape or
 * Tab close it. Closing gives the focus back to the trigger when it was in the menu.
 */
export function MenuButton({
  trigger,
  children,
  align = "right",
  className,
  menuClassName,
  gap,
  offsetX,
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  /** Styles for the menu itself (it's portaled out of the trigger's subtree). */
  menuClassName?: string;
  /** px between the trigger and the menu (default 4). */
  gap?: number;
  /** px to shift the menu from the aligned edge before it's clamped to the window. */
  offsetX?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  // The trigger (found when the menu opens), where the focus goes when the menu closes (null: leave
  // it), and whether this opening has focused its first item.
  const triggerRef = useRef<HTMLElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const focusedOnOpen = useRef(false);
  const triggerEl = () => {
    const a = document.activeElement;
    const w = ref.current;
    if (a instanceof HTMLElement && w?.contains(a)) return a;
    return w?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
  };
  // Close, and give the focus back to the trigger if it was in the menu (it leaves with the menu).
  const close = () => {
    restoreTo.current = menuRef.current?.contains(document.activeElement) ? triggerRef.current : null;
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    // A click outside closes it without taking the focus back: the click put it where it wanted.
    const on = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    // Capture phase, swallowed: Escape closes the menu, not the panel behind it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    addEventListener("mousedown", on);
    addEventListener("keydown", key, true);
    return () => {
      removeEventListener("mousedown", on);
      removeEventListener("keydown", key, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const measure = () => {
      const anchor = ref.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      // Its natural size, not the capped one from a previous placement.
      const cap = menu.style.maxHeight;
      menu.style.maxHeight = "";
      const { width, height } = menu.getBoundingClientRect();
      menu.style.maxHeight = cap;
      setPlace(placeMenu({ anchor, width, height, vw: innerWidth, vh: innerHeight, align, gap, offsetX }));
    };
    measure();
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [open, align, gap, offsetX]);
  // Once it's placed (it's invisible, and can't take the focus, until then), focus the first item.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open) {
      focusedOnOpen.current = false;
      const to = restoreTo.current;
      restoreTo.current = null;
      // Only when the focus left with the menu: an item that opened a modal has handed it on.
      const a = document.activeElement;
      if (to?.isConnected && (!a || a === document.body)) to.focus();
      return;
    }
    if (!menu || !place || focusedOnOpen.current) return;
    focusedOnOpen.current = true;
    const t = (triggerRef.current = triggerEl());
    if (t) menuTriggers.set(menu, t);
    if (!menu.contains(document.activeElement)) menuItems(menu)[0]?.focus();
  }, [open, place]);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const menu = menuRef.current;
    if (!menu) return;
    // The keys the menu uses stay in it (it's portaled, so React would bubble them to the trigger's
    // ancestors: a card's Enter, a form's submit).
    if (!["Tab", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(e.key)) return;
    e.stopPropagation();
    if (e.key === "Tab") {
      e.preventDefault();
      close();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("textarea, select, [contenteditable]")) return;
    const move: RovingMove | null = e.key === "ArrowDown" ? "next" : e.key === "ArrowUp" ? "prev" : e.key === "Home" ? "first" : e.key === "End" ? "last" : null;
    // Home/End in a text field move its caret.
    if (!move || (target instanceof HTMLInputElement && (move === "first" || move === "last"))) return;
    e.preventDefault();
    const items = menuItems(menu);
    const at = items.findIndex((el) => el.contains(document.activeElement));
    items[rovingIndex(items.length, at, move, true)]?.focus();
  };
  return (
    <div ref={ref} style={{ position: "relative" }} className={`no-drag ${className ?? ""}`}>
      {trigger(() => (open ? close() : setOpen(true)), open)}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`menu ${menuClassName ?? ""}`}
            role="menu"
            onKeyDown={onMenuKey}
            data-above={place?.above || undefined}
            style={{
              position: "fixed",
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              maxHeight: place?.maxHeight ?? undefined,
              overflowY: place?.maxHeight != null ? "auto" : undefined,
              visibility: place ? undefined : "hidden",
            }}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </div>
  );
}

const MENU_ITEM = "button, [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]";

/** A menu's enabled items, in order. Plain buttons are given role="menuitem" on the way. */
function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(MENU_ITEM)].filter((el) => {
    if (el instanceof HTMLButtonElement && !el.hasAttribute("role")) el.setAttribute("role", "menuitem");
    return !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true" && el.getClientRects().length > 0;
  });
}

export const isMac = navigator.platform.toLowerCase().includes("mac");
export const MOD = isMac ? "⌘" : "Ctrl";
