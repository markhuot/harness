// Small presentational pieces shared across views.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ReviewState, Ticket, TicketStatus } from "@harness/shared";
import { driverIcon, driverLabel, STATUS_LABEL } from "@harness/shared/state";
import { Icon } from "./Icon";

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

export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, calc(100vw - 40px))` } : undefined} role="dialog">
        {children}
      </div>
    </div>
  );
}

/** On/off switch. Pass ariaLabel when there's no visible label (e.g. the title sits in a settings Row). */
export function Switch({ checked, onChange, label, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; ariaLabel?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" aria-label={ariaLabel} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {label}
    </label>
  );
}

/** Dropdown menu anchored to its trigger. */
export function MenuButton({
  trigger,
  children,
  align = "right",
  className,
}: {
  trigger: (toggle: () => void, open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase, swallowed: Escape closes the menu, not the panel behind it.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    addEventListener("mousedown", on);
    addEventListener("keydown", key, true);
    return () => {
      removeEventListener("mousedown", on);
      removeEventListener("keydown", key, true);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }} className={`no-drag ${className ?? ""}`}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && (
        <div className="menu" role="menu" style={{ top: "calc(100% + 4px)", [align]: 0 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export const isMac = navigator.platform.toLowerCase().includes("mac");
export const MOD = isMac ? "⌘" : "Ctrl";
