// "Needs you" (DESIGN.md "Open questions"): what the ticket waits on the human for, at the top of
// the composer, on the Spec tab only. In a wide pane (the panel layout, QuestionAnswers.tsx) it's
// this panel: each open question item (`- ( )`) in the spec as plain text with one growing reply
// box under it, then the answered ones (`- (x)`) folded under "N answered". The replies are part of the
// message draft: they save as they're typed, go with the composer's Send as one message, and stay
// in their boxes afterwards, so the human can edit them and send again (a send steers a live run or
// starts one, like any message). The panel caps its height and scrolls, so the composer stays on
// screen. A blocked ticket's question isn't here: it heads the spec (SpecTab), where it can scroll,
// though the count still includes it.

import type { Ticket } from "@harness/shared";
import type { QuestionPanel } from "@harness/shared/state";
import { blockedCallout } from "../state/blockedCallout";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { QuestionReplyField } from "./QuestionAnswers";

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
  if (!panel.open.length && !panel.answered.length) return null;
  const count = needsYouCount(ticket, panel);
  return (
    <section className="needs-you" data-testid="needs-you" aria-label="Needs you">
      <div className="needs-you-head">
        <Icon name="alert" size={12} />
        <strong>{count ? `Needs you · ${count}` : "Nothing needs you"}</strong>
        {panel.open.length > 0 && <span className="muted">Replies go out together when you send</span>}
      </div>
      <div className="needs-you-list">
        {panel.open.map((q) => (
          <div key={q.question} className="needs-you-q" data-testid="needs-you-question">
            <div className="needs-you-q-text">
              <Markdown text={q.question} />
            </div>
            <QuestionReplyField value={q.draft} question={q.question} onChange={(b) => onReply(q.question, b)} onFocus={onFocus} onSend={onSend} />
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
