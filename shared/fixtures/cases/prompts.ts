// Prompt overrides, client side (shared/src/prompts.ts) for HarnessKit's Prompts.swift.
import { HarnessApiError } from "../../src/client";
import {
  brokenOverrideMessage,
  groupPrompts,
  insertText,
  lineDiff,
  PROMPT_GROUPS,
  PROMPT_STATE_LABELS,
  promptCounts,
  promptDraftDirty,
  promptDraftError,
  promptErrorLine,
  promptOverrideFor,
  promptSavePatch,
  promptsLoadError,
  promptStartText,
  promptsSummary,
  promptState,
} from "../../src/prompts";
import type { PromptEntry } from "../../src/protocol";
import { cases } from "../case";

const entry = (over: Partial<PromptEntry>): PromptEntry => ({
  id: "system.work",
  group: "system",
  label: "Work",
  description: "",
  variables: [
    { name: "branch", description: "" },
    { name: "worktree", description: "" },
  ],
  builtin: "Work on {{branch}}.",
  override: null,
  overrideError: null,
  ...over,
});

const builtin = entry({});
const custom = entry({ override: "Mine" });
const broken = entry({ override: "On {{brnch}}", overrideError: "Unknown variable {{brnch}}" });
const emptyError = entry({ override: "x", overrideError: "" });
const errorOnly = entry({ overrideError: "stale" });

export const promptGroups = PROMPT_GROUPS;
export const promptStateLabels = PROMPT_STATE_LABELS;

export const groupPromptsCases = cases(groupPrompts, {
  "system then run whatever the catalog order": [entry({ id: "run.review", group: "run" }), entry({ id: "system.intro" }), entry({ id: "system.work" })],
  "run only": [entry({ group: "run", id: "run.review" })],
  empty: [],
  "unknown group is dropped": [entry({ group: "later" as never }), entry({ id: "system.intro" })],
});

export const promptStateCases = cases(promptState, {
  builtin,
  customized: custom,
  broken,
  "error without override": errorOnly,
  "empty error is customized": emptyError,
  "empty override is customized": entry({ override: "" }),
});

export const promptCountsCases = cases(promptCounts, {
  mixed: [builtin, custom, broken],
  "error without override": [builtin, errorOnly],
  empty: [],
  "empty error": [emptyError],
});

export const promptsSummaryCases = cases(promptsSummary, {
  "all built-in": [builtin],
  "one customized": [custom, builtin],
  "with broken": [custom, entry({ override: "x", overrideError: "bad" })],
  empty: [],
  "only broken": [broken, broken],
});

type ErrorLineInput = { entry: PromptEntry; draft: string | null; serverError: string | null };

export const promptErrorLineCases = cases(({ entry: e, draft, serverError }: ErrorLineInput) => promptErrorLine(e, draft, serverError), {
  "broken untouched defers to the banner": { entry: broken, draft: broken.override, serverError: null },
  "server error wins": { entry: broken, draft: broken.override, serverError: "prompts.system.work: bad" },
  "broken edited is checked": { entry: broken, draft: "On {{brnch}}!", serverError: null },
  "broken fixed": { entry: broken, draft: "On {{branch}}", serverError: null },
  "read-only built-in": { entry: builtin, draft: null, serverError: null },
  "customized untouched is checked": { entry: entry({ override: "{{nope}}" }), draft: "{{nope}}", serverError: null },
  "empty server error falls through": { entry: builtin, draft: "{{nope}}", serverError: "" },
  "server error without a draft": { entry: builtin, draft: null, serverError: "boom" },
  "broken untouched only by exact code units": { entry: entry({ override: "café {{x}}", overrideError: "bad" }), draft: "café {{x}}", serverError: null },
  "blank draft is fine": { entry: builtin, draft: "  \n", serverError: null },
});

export const brokenOverrideMessageCases = cases(brokenOverrideMessage, {
  broken,
  "no error": builtin,
  "error with trailing whitespace": entry({ overrideError: "  bad \n" }),
});

type DraftInput = { entry: PromptEntry; draft: string };

export const promptDraftErrorCases = cases(({ entry: e, draft }: DraftInput) => promptDraftError(e, draft), {
  "own variables": { entry: builtin, draft: "On {{branch}}{{#if worktree}} (worktree){{/if}}" },
  "unknown variable": { entry: builtin, draft: "On {{brnch}}" },
  unclosed: { entry: builtin, draft: "{{#if branch}}open" },
  empty: { entry: builtin, draft: "" },
  blank: { entry: builtin, draft: " \n " },
  "NBSP only is blank": { entry: builtin, draft: " " },
  "NEL only is not blank": { entry: entry({ variables: [] }), draft: "\u0085{{x}}" },
  "no variables": { entry: entry({ variables: [] }), draft: "{{x}}" },
});

export const promptStartTextCases = cases(promptStartText, {
  builtin,
  customized: custom,
  "empty override": entry({ override: "" }),
});

export const promptDraftDirtyCases = cases(({ entry: e, draft }: DraftInput) => promptDraftDirty(e, draft), {
  "fresh customize": { entry: builtin, draft: builtin.builtin },
  "changed from built-in": { entry: builtin, draft: "Changed" },
  "custom untouched": { entry: custom, draft: "Mine" },
  "custom back to built-in": { entry: custom, draft: custom.builtin },
  "custom cleared": { entry: custom, draft: "" },
  "built-in cleared": { entry: builtin, draft: "" },
  "decomposed built-in is a change": { entry: entry({ builtin: "café" }), draft: "café" },
  "empty override stored, empty draft": { entry: entry({ override: "" }), draft: "" },
});

export const promptOverrideForCases = cases(({ entry: e, draft }: DraftInput) => promptOverrideFor(e, draft), {
  blank: { entry: builtin, draft: " \t" },
  "the built-in": { entry: builtin, draft: builtin.builtin },
  other: { entry: builtin, draft: "Other" },
  "trailing newline is kept": { entry: builtin, draft: builtin.builtin + "\n" },
  "decomposed built-in is kept": { entry: entry({ builtin: "café" }), draft: "café" },
});

type PatchInput = { entry: PromptEntry; draft: string | null };

export const promptSavePatchCases = cases(({ entry: e, draft }: PatchInput) => promptSavePatch(e, draft), {
  other: { entry: custom, draft: "Other" },
  reset: { entry: custom, draft: null },
  empty: { entry: custom, draft: "" },
  blank: { entry: custom, draft: "  \n" },
  "the built-in": { entry: custom, draft: custom.builtin },
  "whitespace difference is real": { entry: custom, draft: custom.builtin + "\n" },
  "other id": { entry: entry({ id: "run.review", group: "run" }), draft: "R" },
  "unknown id": { entry: entry({ id: "later.thing" as never }), draft: "R" },
});

type InsertInput = { text: string; start: number; end: number; insert: string };

export const insertTextCases = cases(({ text, start, end, insert }: InsertInput) => insertText(text, start, end, insert), {
  // prompts.test.ts
  "replaces the selection": { text: "ab cd", start: 3, end: 5, insert: "{{x}}" },
  "inserts at a caret": { text: "ab", start: 1, end: 1, insert: "Z" },
  "clamps past the end": { text: "ab", start: 9, end: 12, insert: "Z" },
  "end before start": { text: "ab", start: 2, end: 0, insert: "Z" },
  // more
  "negative start": { text: "ab", start: -3, end: 1, insert: "Z" },
  "empty text": { text: "", start: 0, end: 0, insert: "{{x}}" },
  "empty insert deletes": { text: "abc", start: 1, end: 2, insert: "" },
  "UTF-16 offsets after an emoji": { text: "😀ab", start: 2, end: 3, insert: "Z" },
  "emoji insert moves the caret by two": { text: "ab", start: 1, end: 1, insert: "😀" },
  "combining mark before": { text: "éx", start: 2, end: 3, insert: "y" },
});

export const lineDiffCases = cases(({ from, to }: { from: string; to: string }) => lineDiff(from, to), {
  // prompts.test.ts
  "change and add": { from: "one\ntwo\nthree\nfour", to: "one\n2\nthree\nfour\nfive" },
  identical: { from: "a\nb", to: "a\nb" },
  "to empty": { from: "x", to: "" },
  // more
  "both empty": { from: "", to: "" },
  "from empty": { from: "", to: "a\nb" },
  "CRLF lines differ from LF": { from: "a\r\nb", to: "a\nb" },
  "CRLF both sides": { from: "a\r\nb\r\n", to: "a\r\nc\r\n" },
  "trailing newline added": { from: "a", to: "a\n" },
  "deletions before additions": { from: "a\nb\nc", to: "x\ny\nc" },
  "move ties prefer deleting first": { from: "a\nb", to: "b\na" },
  "repeated lines": { from: "x\nx\ny", to: "x\ny\nx" },
  "canonically equivalent lines differ": { from: "café", to: "café" },
  "emoji lines": { from: "😀\nb", to: "😀\nc" },
  "only whitespace change": { from: "a \nb", to: "a\nb" },
});

type LoadErrorInput = { api?: { status: number; message: string }; message?: string; thrown?: string };

export const promptsLoadErrorCases = cases(
  ({ api, message, thrown }: LoadErrorInput) =>
    promptsLoadError(api ? new HarnessApiError(api.status, api.message) : message !== undefined ? new Error(message) : thrown),
  {
    "404 is an older service": { api: { status: 404, message: "Not found" } },
    "500 keeps its message": { api: { status: 500, message: "database is locked" } },
    "401 keeps its message": { api: { status: 401, message: "Unauthorized" } },
    "plain error": { message: "Network request failed" },
    "a thrown string": { thrown: "weird" },
  } satisfies Record<string, LoadErrorInput>,
);
