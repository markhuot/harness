// "Needs you" (DESIGN.md "Open questions"): what the ticket waits on the human for, at the top of
// the composer. On the Spec tab it's a panel: the blocked ticket's question (BlockedCallout: its
// Unblock, a restart time or a tool approval) first, then each unchecked task item under the spec's
// Open questions heading as plain text with one growing reply box under it, then the checked ones
// folded under "N answered". The replies are part of the message draft: they save as they're typed,
// go with the composer's Send as one message, and stay in their boxes afterwards, so the human can
// edit them and send again (a send steers a live run or starts one, like any message). On other
// tabs it's a chip that opens the Spec tab. The panel caps its height and scrolls, so the composer
// stays on screen.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Ticket } from "@harness/shared";
import type { QuestionPanel } from "@harness/shared/state";
import { blockedCallout } from "../state/blockedCallout";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { BlockedCallout } from "./BlockedCallout";

/** How many things wait on the human: the block (question, restart or approval) and the open questions. */
export function needsYouCount(ticket: Ticket, panel: QuestionPanel): number {
  return (blockedCallout(ticket).kind === "none" ? 0 : 1) + panel.open.length;
}

interface PanelProps {
  ticket: Ticket;
  panel: QuestionPanel;
  /** A reply box changed (empty drops the reply from the draft) */
  onReply: (question: string, body: string) => void;
  onFocus: (focused: boolean) => void;
  /** ⌘↩ in a reply box sends, like the composer */
  onSend: () => void;
}

export function NeedsYouPanel({ ticket, panel, onReply, onFocus, onSend }: PanelProps) {
  const blocked = blockedCallout(ticket).kind !== "none";
  if (!blocked && !panel.open.length && !panel.answered.length) return null;
  const count = needsYouCount(ticket, panel);
  return (
    <section className="needs-you" data-testid="needs-you" aria-label="Needs you">
      <div className="needs-you-head">
        <Icon name="alert" size={12} />
        <strong>{count ? `Needs you · ${count}` : "Nothing needs you"}</strong>
        {panel.open.length > 0 && <span className="muted">Replies go out together when you send</span>}
      </div>
      <div className="needs-you-list">
        <BlockedCallout ticket={ticket} />
        {panel.open.map((q) => (
          <div key={q.question} className="needs-you-q" data-testid="needs-you-question">
            <div className="needs-you-q-text">
              <Markdown text={q.question} />
            </div>
            <ReplyField value={q.draft} label={q.question} onChange={(b) => onReply(q.question, b)} onFocus={onFocus} onSend={onSend} />
          </div>
        ))}
        {panel.answered.length > 0 && (
          <details className="needs-you-answered" data-testid="needs-you-answered">
            <summary>{panel.answered.length} answered</summary>
            {panel.answered.map((q) => (
              <div key={q.question} className="needs-you-q-text is-answered">
                <Icon name="check" size={11} strokeWidth={3} /> <Markdown text={q.question} />
              </div>
            ))}
          </details>
        )}
      </div>
    </section>
  );
}

/**
 * A question's reply box, growing with its text. Uncontrolled while it has focus (like the
 * composer's input), so a draft saved by another device can't move the caret; it shows the
 * draft's value again on blur.
 */
function ReplyField({ value, label, onChange, onFocus, onSend }: { value: string; label: string; onChange: (v: string) => void } & Pick<PanelProps, "onFocus" | "onSend">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const grow = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };
  useEffect(() => {
    const el = ref.current;
    if (el && !focused && el.value !== value) el.value = value;
    grow();
  }, [value, focused]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="needs-you-reply composer-input"
      data-testid="needs-you-reply"
      aria-label={`Reply to: ${label}`}
      placeholder="Your answer"
      defaultValue={value}
      onChange={(e) => (onChange(e.currentTarget.value), grow())}
      onFocus={() => (setFocused(true), onFocus(true))}
      onBlur={() => (setFocused(false), onFocus(false))}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          onSend();
        }
      }}
    />
  );
}

/** Off the Spec tab: how many things wait on the human, opening the Spec tab's panel. */
export function NeedsYouChip({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (!count) return null;
  return (
    <button className="needs-you-chip" data-testid="needs-you-chip" onClick={onOpen}>
      <Icon name="alert" size={12} />
      {count === 1 ? "1 question needs you" : `${count} questions need you`}
    </button>
  );
}
