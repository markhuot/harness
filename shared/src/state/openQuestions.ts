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
