// The Spec tab: the ticket's living document (DESIGN.md "Spec revisions and attachments"), with a
// history bar over it: when the revision on show was written and its note, a Show changes toggle
// that keeps the rendered spec and marks what that revision changed from the one before it
// (MarkdownDiff: added text green, removed text red and struck through, in place), and along its
// bottom edge a timeline with one segment per revision, dragged or scrolled to scrub through them.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { SpecRevisionInfo, Ticket } from "@harness/shared";
import { depChipTitle, dependencyStates, diffUnchanged, specBody, specDiff } from "@harness/shared/state";
import { useStore } from "../state/store";
import { FOLLOW_LATEST, revisionAt, scrubTo, segmentTone, shownRevision, wheelScrub, type SpecHistory } from "../state/specHistory";
import { Icon } from "../components/Icon";
import { Markdown, MarkdownDiff } from "../components/Markdown";
import { relativeTime, Switch, TicketKey, useNow } from "../components/bits";
import { PromptAttachmentList } from "../components/PromptAttachments";

export function SpecTab({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, epoch } = useStore();
  const now = useNow();
  const latest = ticket.specRevision ?? 1;
  const revisions = state.specRevisions[ticket.id];
  const [history, setHistory] = useState<SpecHistory>(FOLLOW_LATEST);
  const [showChanges, setShowChanges] = useState(false);
  const [bodyErrors, setBodyErrors] = useState<Record<number, Error>>({});
  const shown = shownRevision(history, latest);
  const body = specBody(state, ticket.id, shown);
  /** Show changes compares the revision on show with the one before it. */
  const comparing = showChanges && shown > 1;
  const prevBody = comparing ? specBody(state, ticket.id, shown - 1) : undefined;
  const info = revisions?.find((r) => r.rev === shown);
  const baseline = ticket.specBaselineRevision ?? revisions?.find((r) => r.approvedBaseline)?.rev ?? null;
  const deps = dependencyStates(state, ticket);

  // The revision list (metadata only); spec.revised events keep it current once it's loaded.
  useEffect(() => {
    let live = true;
    client.specRevisions(ticket.key).then(
      (list) => live && dispatch({ type: "specRevisions", ticketId: ticket.id, revisions: list }),
      () => {},
    );
    return () => void (live = false);
  }, [client, dispatch, ticket.key, ticket.id, epoch]);

  // An earlier revision's body, fetched when it's first shown, and the one before it for Show changes.
  const fetchError = (rev: number) => (e: unknown) => setBodyErrors((m) => ({ ...m, [rev]: e instanceof Error ? e : new Error(String(e)) }));
  useRevisionBody(ticket, shown, body === undefined && !bodyErrors[shown], fetchError(shown));
  useRevisionBody(ticket, shown - 1, comparing && prevBody === undefined && !bodyErrors[shown - 1], fetchError(shown - 1));

  const diff = useMemo(() => (body !== undefined && prevBody !== undefined ? specDiff(prevBody, body) : undefined), [body, prevBody]);
  const unchanged = diff !== undefined && diffUnchanged(diff);
  const bodyError = bodyErrors[shown] ?? (comparing ? bodyErrors[shown - 1] : undefined);

  const head = useRef<HTMLDivElement>(null);

  return (
    <div className="spec-tab">
      <div className="spec-head" ref={head}>
        <div className={`spec-history${latest > 1 ? " has-timeline" : ""}`} data-testid="spec-history">
          <span className="spec-history-meta truncate">
            {info && info.createdAt > 0 && <span title={new Date(info.createdAt).toLocaleString()}>{relativeTime(info.createdAt, now)}</span>}
            {info && info.createdAt > 0 && info.note && " · "}
            {info?.note && <em>{info.note}</em>}
          </span>
          {(info?.approvedBaseline || ticket.specBaselineRevision === shown) && (
            <span className="chip done spec-baseline" title="The revision approved when the ticket was started">
              <Icon name="check" size={9} strokeWidth={3} />
              Approved plan
            </span>
          )}
          <div className="grow" />
          {showChanges && latest > 1 && (shown === 1 || unchanged) && (
            <span className="spec-diff-note">{shown === 1 ? "First revision: nothing to compare" : `No changes from rev ${shown - 1}`}</span>
          )}
          {latest > 1 && <Switch checked={showChanges} onChange={setShowChanges} label="Show changes" />}
        </div>
        {latest > 1 && (
          <SpecTimeline
            shown={shown}
            latest={latest}
            baseline={baseline}
            revisions={revisions}
            now={now}
            scrollArea={head}
            onScrub={(rev) => setHistory(scrubTo(rev, latest))}
          />
        )}
      </div>
      <div className="spec-body">
        {deps.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            <span className="section-title">Depends on</span>
            {deps.map((d) => (
              <span key={d.key} className={`chip ${d.state}`} data-dep-state={d.state} title={depChipTitle(d)}>
                {d.done && <Icon name="check" size={9} strokeWidth={3} />}
                {d.ticket ? <TicketKey ticket={d.ticket} /> : d.key}
              </span>
            ))}
          </div>
        )}
        {body === undefined || (comparing && prevBody === undefined) ? (
          bodyError ? (
            <div className="empty">Couldn't load this revision: {bodyError.message}</div>
          ) : (
            <div className="empty">
              <div className="spinner" />
            </div>
          )
        ) : comparing && prevBody !== undefined && diff && (body.trim() || prevBody.trim()) ? (
          <section className="spec-doc" data-testid="spec-doc" data-changes={`${shown - 1}-${shown}`}>
            <MarkdownDiff diff={diff} before={prevBody} after={body} />
          </section>
        ) : body.trim() ? (
          <section className="spec-doc" data-testid="spec-doc">
            <Markdown text={body} />
          </section>
        ) : (
          <div className="empty">
            <Icon name="fileText" />
            <strong>No spec yet</strong>
            {ticket.status === "planning" ? "The planning agent writes the plan here." : "Write one in Details, or ask the agent to."}
          </div>
        )}
        {!!ticket.promptAttachments?.length && (
          <section className="spec-prompt-attachments" data-testid="spec-prompt-attachments">
            <span className="section-title">Attachments</span>
            <PromptAttachmentList items={ticket.promptAttachments} annotate={(a) => ({ attachment: a })} />
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * The history bar's bottom edge: one segment per revision, the one on show in the accent color and
 * the approved plan in green. Press and drag to sweep through the revisions (the spec follows
 * live), click to jump, scroll anywhere over the bar, or focus it and use ← → Home End. Its tip
 * ("Rev 3 of 7 · 2h ago · note") names the revision under the pointer, or the one on show while
 * dragging or scrolling.
 */
function SpecTimeline(props: {
  shown: number;
  latest: number;
  baseline: number | null;
  revisions: SpecRevisionInfo[] | undefined;
  now: number;
  /** Scrolling over this element (the bar and the timeline) scrubs. */
  scrollArea: RefObject<HTMLElement | null>;
  onScrub: (rev: number) => void;
}) {
  const { shown, latest, baseline, revisions, now, scrollArea, onScrub } = props;
  const [dragging, setDragging] = useState(false);
  // The pointer is down: read by pointermove, which can fire before the render that sets `dragging`.
  const down = useRef(false);
  const drag = (on: boolean) => {
    down.current = on;
    setDragging(on);
  };
  const [hover, setHover] = useState<number | null>(null);
  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return revisionAt(e.clientX - r.left, r.width, latest);
  };
  const scrub = (rev: number) => rev !== shown && onScrub(rev);
  // Scrolling: the wheel listener is native and not passive, so the scroll doesn't also move
  // whatever is under the bar; the tip shows the revision on show until the scrolling stops.
  const [scrolling, setScrolling] = useState(false);
  const wheel = useRef({ carry: 0, shown, latest, onScrub });
  wheel.current = { ...wheel.current, shown, latest, onScrub };
  useEffect(() => {
    const el = scrollArea.current;
    if (!el) return;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const w = wheel.current;
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      const r = wheelScrub(w.carry, e.deltaX * px, e.deltaY * px, w.shown, w.latest);
      w.carry = r.carry;
      if (r.rev !== w.shown) {
        w.shown = r.rev;
        w.onScrub(r.rev);
      }
      setScrolling(true);
      clearTimeout(quiet);
      quiet = setTimeout(() => {
        w.carry = 0;
        setScrolling(false);
      }, 900);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      clearTimeout(quiet);
      el.removeEventListener("wheel", onWheel);
    };
  }, [scrollArea]);
  const onKeyDown = (e: KeyboardEvent) => {
    const to = { ArrowLeft: shown - 1, ArrowDown: shown - 1, ArrowRight: shown + 1, ArrowUp: shown + 1, Home: 1, End: latest }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onScrub(to);
  };
  const label = (rev: number) => {
    const info = revisions?.find((r) => r.rev === rev);
    const parts = [`Rev ${rev} of ${latest}`];
    if (info && info.createdAt > 0) parts.push(relativeTime(info.createdAt, now));
    if (rev === baseline) parts.push("Approved plan");
    if (info?.note) parts.push(info.note);
    return parts.join(" · ");
  };
  const tip = dragging || scrolling ? shown : hover;
  const tipText = tip === null ? "" : label(tip);
  // Center the tip under its segment, kept inside the strip near either end.
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = tipRef.current;
    const strip = el?.parentElement;
    if (!el || !strip || tip === null) return;
    const w = strip.clientWidth;
    const center = ((tip - 0.5) / latest) * w;
    el.style.left = `${Math.max(0, Math.min(w - el.offsetWidth, center - el.offsetWidth / 2))}px`;
  }, [tip, tipText, latest]);
  return (
    <div
      className={`spec-timeline${dragging ? " is-dragging" : ""}`}
      data-testid="spec-timeline"
      role="slider"
      tabIndex={0}
      aria-label="Spec revision"
      aria-valuemin={1}
      aria-valuemax={latest}
      aria-valuenow={shown}
      aria-valuetext={label(shown)}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag(true);
        scrub(at(e));
      }}
      onPointerMove={(e) => (down.current ? scrub(at(e)) : setHover(at(e)))}
      onPointerUp={() => drag(false)}
      onPointerCancel={() => drag(false)}
      onLostPointerCapture={() => drag(false)}
      onPointerLeave={() => setHover(null)}
    >
      <div className="spec-timeline-track" style={{ "--n": latest } as CSSProperties}>
        {Array.from({ length: latest }, (_, i) => i + 1).map((rev) => (
          <span key={rev} className="spec-timeline-seg" data-tone={segmentTone(rev, shown, baseline)} data-hover={rev === tip || undefined} />
        ))}
      </div>
      {tip !== null && (
        <div className="spec-timeline-tip" ref={tipRef}>
          {tipText}
        </div>
      )}
    </div>
  );
}

/** Fetch revision `rev`'s body into the store while `needed`; `onError` hears a failed fetch. */
function useRevisionBody(ticket: Ticket, rev: number, needed: boolean, onError: (e: unknown) => void) {
  const { client, dispatch } = useStore();
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    client.specRevision(ticket.key, rev).then(
      (revision) => live && dispatch({ type: "specRevision", ticketId: ticket.id, revision }),
      (e) => live && report.current(e),
    );
    return () => void (live = false);
  }, [client, dispatch, ticket.key, ticket.id, rev, needed]);
}
