// "Needs you" (DESIGN.md "Open questions"): what the ticket waits on the human for, at the top of
// the composer. On the Spec tab it's a panel: the blocked ticket's question (BlockedCallout: its
// Unblock, a restart time or a tool approval) first, then each unchecked task item under the spec's
// Open questions heading, with the replies already sent under it and a field for the next one, then
// the checked ones folded under "N answered". The replies are part of the message draft, so they
// save as they're typed and go with the composer's Send as one message. On other tabs it's a chip
// that opens the Spec tab. The panel caps its height and scrolls, so the composer stays on screen.

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { QuestionReply, Ticket } from "@harness/shared";
import type { QuestionPanel, QuestionThread } from "@harness/shared/state";
import { blockedCallout } from "../state/blockedCallout";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { relativeTime, useNow } from "../components/bits";
import { BlockedCallout } from "./BlockedCallout";

/** How many things wait on the human: the block (question, restart or approval) and the open questions. */
export function needsYouCount(ticket: Ticket, panel: QuestionPanel): number {
  return (blockedCallout(ticket).kind === "none" ? 0 : 1) + panel.open.length;
}

interface PanelProps {
  ticket: Ticket;
  panel: QuestionPanel;
  /** A reply field changed (empty drops the reply from the draft) */
  onReply: (question: string, body: string) => void;
  /** A detached reply was discarded */
  onDiscard: (reply: QuestionReply) => void;
  onFocus: (focused: boolean) => void;
  /** ⌘↩ in a reply field sends, like the composer */
  onSend: () => void;
}

export function NeedsYouPanel({ ticket, panel, onReply, onDiscard, onFocus, onSend }: PanelProps) {
  const blocked = blockedCallout(ticket).kind !== "none";
  if (!blocked && !panel.open.length && !panel.answered.length && !panel.detached.length) return null;
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
          <Question key={q.question} thread={q} onReply={onReply} onFocus={onFocus} onSend={onSend} />
        ))}
        {panel.detached.map((r) => (
          <div key={r.question} className="needs-you-q is-detached" data-testid="needs-you-detached">
            <div className="needs-you-q-text muted">
              <Icon name="alert" size={11} /> Question changed: “{r.question}”
            </div>
            <ReplyField value={r.body} placeholder="Your reply" onChange={(b) => onReply(r.question, b)} onFocus={onFocus} onSend={onSend} />
            <button className="btn btn-ghost btn-sm" data-testid="needs-you-discard" onClick={() => onDiscard(r)}>
              Discard
            </button>
          </div>
        ))}
        {panel.answered.length > 0 && (
          <details className="needs-you-answered" data-testid="needs-you-answered">
            <summary>{panel.answered.length} answered</summary>
            {panel.answered.map((q) => (
              <div key={q.question} className="needs-you-q is-answered">
                <div className="needs-you-q-text">
                  <Icon name="check" size={11} strokeWidth={3} /> <Markdown text={q.question} />
                </div>
                <SentReplies thread={q} />
              </div>
            ))}
          </details>
        )}
      </div>
    </section>
  );
}

function Question({ thread, onReply, onFocus, onSend }: { thread: QuestionThread } & Pick<PanelProps, "onReply" | "onFocus" | "onSend">) {
  return (
    <div className="needs-you-q" data-testid="needs-you-question">
      <div className="needs-you-q-text">
        <Markdown text={thread.question} />
      </div>
      <SentReplies thread={thread} />
      <ReplyField
        value={thread.draft}
        placeholder={thread.sent.length ? "Add to your reply" : "Reply to this question"}
        onChange={(b) => onReply(thread.question, b)}
        onFocus={onFocus}
        onSend={onSend}
      />
    </div>
  );
}

function SentReplies({ thread }: { thread: QuestionThread }) {
  const now = useNow();
  if (!thread.sent.length) return null;
  return (
    <ol className="needs-you-sent" data-testid="needs-you-sent">
      {thread.sent.map((r, i) => (
        <li key={i}>
          <span className="muted">You · {relativeTime(r.at, now)}</span>
          <Markdown text={r.body} />
        </li>
      ))}
    </ol>
  );
}

/**
 * A reply field. Uncontrolled while it has focus (like the composer's input), so a draft saved by
 * another device can't move the caret; it shows the draft's value again on blur.
 */
function ReplyField({ value, placeholder, onChange, onFocus, onSend }: { value: string; placeholder: string; onChange: (v: string) => void } & Pick<PanelProps, "onFocus" | "onSend">) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!focused && el.value !== value) el.value = value;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [value, focused]);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="needs-you-reply composer-input"
      data-testid="needs-you-reply"
      placeholder={placeholder}
      defaultValue={value}
      onChange={(e) => onChange(e.currentTarget.value)}
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
