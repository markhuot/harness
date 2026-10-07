// Conductor presentation shared by the board and the ticket detail: the segmented progress
// bar, the rollup on a conductor's card, the "Part of" breadcrumb on a child, and the board's
// "Hide child tickets" preference.

import { useCallback, useState } from "react";
import { keyLabel, type Ticket } from "@harness/shared";
import { progressLabel, progressSegments, readHideChildren, writeHideChildren, type Progress } from "@harness/shared/state";
import { STATUS_LABEL, TicketKey } from "./bits";
import { Icon } from "./Icon";
import { HIDE_CHILDREN_CHANGED } from "../state/usePresence";
import "./conductor.css";

export function ProgressBar({ progress, size = "md" }: { progress: Progress; size?: "sm" | "md" }) {
  const segs = progressSegments(progress);
  return (
    <span className={`cond-bar cond-bar-${size}`} role="img" aria-label={progressLabel(progress)}>
      {segs.map((s) => (
        <span
          key={s.status}
          className="cond-seg"
          data-status={s.status}
          style={{ width: `${s.pct}%`, ["--seg" as string]: `var(--c-${s.status})` }}
          title={`${s.count} ${STATUS_LABEL[s.status].toLowerCase()}`}
        />
      ))}
    </span>
  );
}

/** Rollup on a conductor's board card: mini bar, "4/10 done", and how many children need you. */
export function ConductorRollup({ progress }: { progress: Progress }) {
  if (!progress.total) return null;
  return (
    <div className="cond-rollup" data-testid="conductor-rollup">
      <ProgressBar progress={progress} size="sm" />
      <span className="cond-rollup-text">
        {progress.byStatus.done}/{progress.total} done
      </span>
      {progress.attention > 0 && (
        <span className="cond-attn" title={`${progress.attention} child ticket${progress.attention === 1 ? "" : "s"} waiting on you`}>
          <Icon name="alert" size={10} />
          {progress.attention} need{progress.attention === 1 ? "s" : ""} you
        </span>
      )}
    </div>
  );
}

/** "Part of HEL-1 <title>" above a child's title; opens the conductor's Tickets tab. */
export function ParentCrumb({ parent, onOpen }: { parent: Ticket; onOpen: (key: string) => void }) {
  return (
    <button className="cond-crumb" data-testid="parent-crumb" onClick={() => onOpen(parent.key)} title={`Open ${keyLabel(parent)}`}>
      <Icon name="conductor" size={11} />
      <span className="muted">Part of</span>
      <span className="mono">
        <TicketKey ticket={parent} />
      </span>
      <span className="truncate">{parent.title || "Untitled"}</span>
      <Icon name="chevronRight" size={11} />
    </button>
  );
}

export function useHideChildren() {
  const [hide, setHide] = useState(readHideChildren);
  const toggle = useCallback(() => {
    setHide((h) => {
      writeHideChildren(!h);
      // Presence lists the cards on screen (state/usePresence.ts).
      queueMicrotask(() => dispatchEvent(new Event(HIDE_CHILDREN_CHANGED)));
      return !h;
    });
  }, []);
  return [hide, toggle] as const;
}
