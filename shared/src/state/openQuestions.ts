// A spec's open questions (DESIGN.md "Open questions"): every GFM task item in it (`- [ ] question`),
// under any heading or none. Agents write them wherever they fit and resolve them by moving the
// answer into the spec and removing the item or checking it off; they use task items for nothing
// else. The apps show them with an answer box, in the panel above the composer or inline in the
// spec (needsYouLayout), where the human replies to several at once (the replies stay after a send,
// to edit and send again); the service counts the unchecked ones for the board card
// (Ticket.openQuestionCount) and composes the message a batch of replies sends.

import type { QuestionReply } from "../protocol";
import { parseBlocks, type Block } from "./markdown";

export interface OpenQuestion {
  /** The item's text, as written: also the question's identity (replies and drafts match on it). */
  text: string;
  checked: boolean;
}

/**
 * Every task item in the spec, in document order, nested ones included, checked or not. Plain
 * bullets and prose aren't questions, and neither is anything inside a code block.
 */
export function openQuestions(spec: string): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  const walk = (list: Block[]) => {
    for (const b of list) {
      if (b.t !== "ul" && b.t !== "ol") continue;
      for (const it of b.items) {
        if (it.checked !== undefined && it.text.trim()) out.push({ text: it.text.trim(), checked: it.checked });
        walk(it.children);
      }
    }
  };
  walk(parseBlocks(spec));
  return out;
}

/** How many of the spec's open questions are still unchecked. */
export function openQuestionCount(spec: string): number {
  return openQuestions(spec).filter((q) => !q.checked).length;
}

/** The replies worth sending: each with a question and a body that isn't blank, trimmed, in order. */
export function pendingQuestionReplies(replies: readonly QuestionReply[] | null | undefined): QuestionReply[] {
  return (replies ?? []).map((r) => ({ question: r.question.trim(), body: r.body.trim() })).filter((r) => r.question && r.body);
}

/**
 * The message a batch of question replies sends: each question quoted with its reply under it, in
 * order, then the rest of what the human typed. Blank replies are dropped; with none left it's the
 * typed text alone.
 */
export function composeQuestionReplies(replies: readonly QuestionReply[] | null | undefined, text: string): string {
  const parts = pendingQuestionReplies(replies).map((r) => `> ${r.question.replace(/\n/g, "\n> ")}\n\n${r.body}`);
  if (text.trim()) parts.push(text.trim());
  return parts.join("\n\n");
}

/** One question as the panel shows it, with the reply in the draft. */
export interface QuestionThread {
  question: string;
  checked: boolean;
  draft: string;
}

export interface QuestionPanel {
  /** The unchecked questions, in the spec's order */
  open: QuestionThread[];
  /** The checked ones, folded into an "N answered" disclosure */
  answered: QuestionThread[];
}

/**
 * The panel above the composer (DESIGN.md "Open questions"): the spec's questions, each with its
 * reply in the draft (matched by the question's text).
 */
export function questionPanel(spec: string, drafts: readonly QuestionReply[]): QuestionPanel {
  const questions = openQuestions(spec);
  const thread = (q: OpenQuestion): QuestionThread => ({ question: q.text, checked: q.checked, draft: drafts.find((d) => d.question === q.text)?.body ?? "" });
  return { open: questions.filter((q) => !q.checked).map(thread), answered: questions.filter((q) => q.checked).map(thread) };
}

/**
 * The replies a Send delivers: the non-blank ones under questions still open in the spec. Replies
 * stay in the draft after a send (the human can edit and send them again), so one under a question
 * the agent has since resolved or reworded is kept but no longer goes out.
 */
export function sendableQuestionReplies(spec: string, replies: readonly QuestionReply[] | null | undefined): QuestionReply[] {
  const open = new Set(openQuestions(spec).filter((q) => !q.checked).map((q) => q.text));
  return pendingQuestionReplies(replies).filter((r) => open.has(r.question));
}

/**
 * Where the ticket view answers its questions (DESIGN.md "Open questions"): `panel`, a sticky panel
 * above the composer, or `inline`, an answer box under each question in the rendered spec with a
 * one-line bar above the composer. It follows the ticket view's size, not the platform, so the same
 * size behaves the same on the Mac, iPhone and iPad: the panel needs a landscape view at least this
 * wide and tall, so it never covers much of the spec. Every iPhone, an iPad in portrait or split
 * view and a Mac pane squeezed by the board go inline; a full Mac window and a large iPad in
 * landscape get the panel. Ported to HarnessKit's `NeedsYouLayout`.
 */
export type NeedsYouLayout = "panel" | "inline";
export const NEEDS_YOU_PANEL_MIN_WIDTH = 700;
export const NEEDS_YOU_PANEL_MIN_HEIGHT = 600;

export function needsYouLayout(width: number, height: number): NeedsYouLayout {
  return width >= NEEDS_YOU_PANEL_MIN_WIDTH && height >= NEEDS_YOU_PANEL_MIN_HEIGHT && width > height ? "panel" : "inline";
}

/** The inline layout's one-line bar above the composer: what it reads and what a click does. */
export interface NeedsYouBar {
  label: string;
  /** `focus`: scroll to the first open question and focus its box (the composer when there's none); `send`: send */
  action: "focus" | "send";
}

/**
 * `count` is everything waiting on the human (the block and the open questions), `ready` the
 * answers a Send would deliver, `questions` the open questions they're out of. Once there are answers it sends them; before, it takes the human
 * to the first question. None when nothing waits.
 */
export function needsYouBar(count: number, ready: number, questions: number): NeedsYouBar | null {
  // Out of the open questions ("2/3 answers ready"); a reply to a question an agent has since
  // checked off still goes, so the total never reads below what's ready.
  const total = Math.max(questions, ready);
  if (ready > 0) return { label: `${ready}/${total} ${total === 1 ? "answer" : "answers"} ready · Send`, action: "send" };
  if (count > 0) return { label: `Needs you · ${count}`, action: "focus" };
  return null;
}
