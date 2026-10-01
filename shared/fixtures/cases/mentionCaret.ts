// The composer caret state machine (mobile/src/lib/mentionCaret.ts) for HarnessKit's
// MentionCaret.swift. Each case replays a sequence of input events and records the state after
// every step, so the Swift port has to agree step by step, not only at the end.
import { insertCommand } from "../../src/commands";
import { insertMention } from "../../src/mentions";
import { type Caret, commandAt, mentionAt, NO_CARET, onPick, onSelection, selectionProp } from "../../../mobile/src/lib/mentionCaret";
import { cases } from "../case";

type Step = { select: [number, number] } | { pick: number; before?: number | null };
type Run = { value: string; steps: Step[] };

/** The state after each step, with the mention/command the composer would show for `value`. */
function replay({ value, steps }: Run) {
  let c: Caret = NO_CARET;
  return steps.map((s) => {
    c = "select" in s ? onSelection(c, s.select[0], s.select[1]) : s.before === undefined ? onPick(s.pick) : onPick(s.pick, s.before);
    return { caret: c, selection: selectionProp(c) ?? null, mention: mentionAt(value, c), command: commandAt(value, c) };
  });
}

const picked = (() => {
  const text = "see @src/a";
  const next = insertMention(text, mentionAt(text, onSelection(NO_CARET, text.length, text.length))!, "src/app.ts");
  return { text, next };
})();
const cmd = (() => {
  const text = "/co";
  return insertCommand(text, commandAt(text, onSelection(NO_CARET, 3, 3))!, "code-walk");
})();
const folder = insertMention("@sr", mentionAt("@sr", onSelection(NO_CARET, 3, 3))!, "src/");

export const replayCases = cases(replay, {
  // mentionCaret.test.ts
  "collapsed caret is a mention, a range isn't": { value: "Summarize @READ", steps: [{ select: [15, 15] }, { select: [10, 15] }] },
  "no caret yet": { value: "@src", steps: [] as Step[] },
  "caret past the end": { value: "@a", steps: [{ select: [9, 9] }] },
  "pick held through the stale report, released when the input lands": {
    value: picked.next.text,
    steps: [{ pick: picked.next.caret, before: picked.text.length }, { select: [picked.text.length, picked.text.length] }, { select: [picked.next.caret, picked.next.caret] }],
  },
  "typing after a pick releases without the forced report": {
    value: cmd.text,
    steps: [{ pick: cmd.caret, before: 3 }, { select: [cmd.caret + 1, cmd.caret + 1] }, { select: [cmd.caret + 2, cmd.caret + 2] }],
  },
  "range after a pick releases": { value: "hello", steps: [{ pick: 5, before: 2 }, { select: [0, 5] }] },
  "folder pick keeps the list open": { value: folder.text, steps: [{ pick: folder.caret }, { select: [folder.caret, folder.caret] }] },
  // more
  "pick without a before: any collapsed report releases": { value: "@a b", steps: [{ pick: 2 }, { select: [1, 1] }] },
  "explicit null before": { value: "@a b", steps: [{ pick: 2, before: null }, { select: [2, 2] }] },
  "stale report twice: held both times": { value: "@abc x", steps: [{ pick: 4, before: 1 }, { select: [1, 1] }, { select: [1, 1] }] },
  "stale equal to forced is not held as stale": { value: "@ab", steps: [{ pick: 2, before: 2 }, { select: [2, 2] }] },
  "stale as a range releases": { value: "@ab", steps: [{ pick: 3, before: 1 }, { select: [1, 2] }] },
  "a second pick replaces the first": { value: "@a @b", steps: [{ pick: 2, before: 1 }, { pick: 5, before: 4 }, { select: [1, 1] }, { select: [4, 4] }] },
  "caret at 0": { value: "@a", steps: [{ select: [0, 0] }] },
  "reversed range": { value: "@abc", steps: [{ select: [4, 1] }] },
  "command caret": { value: "/co", steps: [{ select: [3, 3] }, { select: [0, 0] }] },
  "caret after an emoji in UTF-16": { value: "😀 @sr", steps: [{ select: [6, 6] }] },
  "negative caret": { value: "@a", steps: [{ select: [-1, -1] }] },
} satisfies Record<string, Run>);
