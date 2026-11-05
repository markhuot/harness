// Answering the spec's questions (DESIGN.md "Open questions"): every unchecked task item in the
// spec is one, answered in a growing box bound to the ticket's message draft by the question's
// text. Where the boxes sit follows the ticket pane's size (needsYouLayout): a wide pane lists them
// in the Needs you panel above the composer (NeedsYouPanel.tsx); a narrow one puts each box under
// its question in the rendered spec (InlineAnswer, through Markdown's TaskAnswerScope) and the
// composer shows a one-line bar (NeedsYouBar) that jumps to the first one. Either way the answers
// live in the draft, so they carry across a resize, save as they're typed, and go with Send.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import type { Ticket } from "@harness/shared";
import { needsYouLayout, questionReply, withQuestionReply, type NeedsYouBar as Bar, type NeedsYouLayout } from "@harness/shared/state";
import { useStore } from "../state/store";
import { messageDraftSession, type MessageDraftSession } from "../state/messageDraftSession";
import { Icon } from "../components/Icon";

/** The ticket's message draft session in this window (state/messageDraftSession.ts), wired to the service. */
export function useMessageDraft(ticket: Ticket): MessageDraftSession {
  const { client, dispatch, toast } = useStore();
  return messageDraftSession(ticket, {
    save: (key, body) => client.saveMessageDraft(key, body),
    upsert: (t) => dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: t } }),
    error: (m) => toast(m, "error"),
    keepalive: (path, body) =>
      void fetch(client.baseUrl + path, {
        method: "PUT",
        keepalive: true,
        headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {}),
  });
}

/**
 * The layout the ticket pane's size calls for, re-measured as it resizes. Until it's measured (and
 * where nothing can measure it) it's the panel.
 */
export function useNeedsYouLayout(ref: RefObject<HTMLElement | null>): NeedsYouLayout {
  const [layout, setLayout] = useState<NeedsYouLayout>("panel");
  const observed = useRef<{ el: HTMLElement; ro: ResizeObserver | null } | null>(null);
  // After every render, since the pane swaps its element (loading, then loaded): it observes the one there now.
  useLayoutEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.ro?.disconnect();
    observed.current = null;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setLayout(needsYouLayout(r.width, r.height));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    observed.current = { el, ro };
  });
  useEffect(() => () => observed.current?.ro?.disconnect(), []);
  return layout;
}

/**
 * A question's answer box, growing with its text. Uncontrolled while it has focus (like the
 * composer's input), so a draft saved by another device, or the spec re-rendering around it, can't
 * move the caret; it shows the draft's value again on blur. ⌘↩ sends, like the composer.
 */
export function QuestionReplyField({
  value,
  question,
  onChange,
  onFocus,
  onSend,
}: {
  value: string;
  question: string;
  onChange: (v: string) => void;
  onFocus: (focused: boolean) => void;
  onSend: () => void;
}) {
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
      data-question={question}
      aria-label={`Reply to: ${question}`}
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

/** The answer box under a question in the rendered spec (the inline layout). */
export function InlineAnswer({ ticket, question, onSend }: { ticket: Ticket; question: string; onSend: () => void }) {
  const draft = useMessageDraft(ticket);
  useSyncExternalStore(draft.subscribe, () => draft.version);
  return (
    <QuestionReplyField
      value={questionReply(draft.value, question)}
      question={question}
      onChange={(b) => draft.edit({ questionReplies: withQuestionReply(draft.value, question, b).questionReplies })}
      onFocus={(on) => draft.focus(on, ticket.messageDraft)}
      onSend={onSend}
    />
  );
}

/** Scrolls to the first answer box in the rendered spec under `root` and focuses it; false when there's none. */
export function focusFirstQuestion(root: ParentNode | null | undefined): boolean {
  const box = root?.querySelector<HTMLTextAreaElement>(".spec-doc [data-testid=needs-you-reply]");
  if (!box) return false;
  box.scrollIntoView?.({ block: "center", behavior: "smooth" });
  box.focus({ preventScroll: true });
  return true;
}

/** The inline layout's one-line bar above the composer: "Needs you · N", or "N answers ready · Send". */
export function NeedsYouBar({ bar, onClick, disabled }: { bar: Bar; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`needs-you-bar is-${bar.action}`} data-testid="needs-you-bar" data-action={bar.action} disabled={disabled} onClick={onClick}>
      <Icon name="alert" size={12} />
      <strong>{bar.label}</strong>
      {bar.action === "focus" && <span className="muted">Answer in the spec</span>}
    </button>
  );
}
