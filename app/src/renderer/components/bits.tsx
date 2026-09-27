// Small presentational pieces shared across views.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DriverInfo, ReviewState, Ticket, TicketStatus } from "@harness/shared";
import { Icon } from "./Icon";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  planning: "Planning",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

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

const DRIVER_SHORT: Record<string, string> = { "claude-code": "Claude Code", "anthropic-api": "API", dummy: "Dummy" };
export function driverLabel(id: string, drivers?: DriverInfo[]) {
  return DRIVER_SHORT[id] ?? drivers?.find((d) => d.id === id)?.name ?? id;
}

export function DriverBadge({ driver }: { driver: string }) {
  return (
    <span className="badge badge-outline driver-badge" data-driver={driver} title={`Driver: ${driver}`}>
      <Icon name={driver === "dummy" ? "bot" : driver === "anthropic-api" ? "key" : "sparkle"} />
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

export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.round((now - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
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

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {label}
    </label>
  );
}

/** Dropdown menu anchored to its trigger. */
export function MenuButton({ trigger, children, align = "right" }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", on);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("mousedown", on);
      removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }} className="no-drag">
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div className="menu" style={{ top: "calc(100% + 4px)", [align]: 0 }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export const isMac = navigator.platform.toLowerCase().includes("mac");
export const MOD = isMac ? "⌘" : "Ctrl";
