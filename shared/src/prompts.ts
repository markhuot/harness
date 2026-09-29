// Prompt overrides, client side (DESIGN.md "Prompt overrides"): the pure logic behind the Mac and
// iPhone Settings → Prompts screens. The service owns the catalog (GET /prompts); this groups it,
// labels each prompt's state, validates a draft the way the service will, and turns a draft into
// the settings PATCH.

import type { PromptEntry, PromptGroup, PromptId, Settings } from "./protocol";
import { templateError } from "./templates";
import { HarnessApiError } from "./client";

/** What to show when GET /prompts fails: a service from before prompt overrides answers 404. */
export function promptsLoadError(e: unknown): string {
  if (e instanceof HarnessApiError && e.status === 404) return "This service doesn't support prompt overrides yet. Update Harness to customize prompts.";
  return e instanceof Error ? e.message : String(e);
}

export const PROMPT_GROUPS: { group: PromptGroup; title: string; description: string }[] = [
  { group: "system", title: "System prompt", description: "Sections of a run's system prompt. Harness picks which sections a run gets and puts them in order." },
  { group: "run", title: "Run messages", description: "The message that starts a run." },
];

/** The catalog split by group, in PROMPT_GROUPS order (catalog order within each); empty groups are left out. */
export function groupPrompts(entries: readonly PromptEntry[]): { group: PromptGroup; title: string; description: string; entries: PromptEntry[] }[] {
  return PROMPT_GROUPS.map((g) => ({ ...g, entries: entries.filter((e) => e.group === g.group) })).filter((g) => g.entries.length > 0);
}

/**
 * builtin: no override. customized: the override is what runs get. broken: an override is stored
 * but no longer validates (usually an app update renamed a variable), so runs get the built-in.
 */
export type PromptState = "builtin" | "customized" | "broken";

export function promptState(entry: Pick<PromptEntry, "override" | "overrideError">): PromptState {
  if (entry.override == null) return "builtin";
  return entry.overrideError ? "broken" : "customized";
}

export const PROMPT_STATE_LABELS: Record<PromptState, string> = {
  builtin: "Built-in",
  customized: "Customized",
  broken: "Not in use",
};

/** For a list header: prompts with a stored override (broken ones included), and how many of those are broken. */
export function promptCounts(entries: readonly Pick<PromptEntry, "override" | "overrideError">[]): { customized: number; broken: number } {
  const states = entries.map(promptState);
  return { customized: states.filter((s) => s !== "builtin").length, broken: states.filter((s) => s === "broken").length };
}

/** One line for a Settings row: "All built-in", "2 customized" or "2 customized · 1 not in use". */
export function promptsSummary(entries: readonly Pick<PromptEntry, "override" | "overrideError">[]): string {
  const { customized, broken } = promptCounts(entries);
  if (!customized) return "All built-in";
  return broken ? `${customized} customized · ${broken} ${PROMPT_STATE_LABELS.broken.toLowerCase()}` : `${customized} customized`;
}

/**
 * The error line under the editor: the service's 400, else the live check of `draft` (null while
 * showing the built-in read-only). A broken override's banner already says what's wrong, so the
 * line stays empty until the user changes the stored text.
 */
export function promptErrorLine(entry: Pick<PromptEntry, "variables" | "override" | "overrideError">, draft: string | null, serverError: string | null): string | null {
  if (serverError) return serverError;
  if (draft === null) return null;
  if (promptState(entry) === "broken" && draft === entry.override) return null;
  return promptDraftError(entry, draft);
}

/** Why the broken override isn't used, for the editor. */
export function brokenOverrideMessage(entry: Pick<PromptEntry, "overrideError">): string {
  return `Your customization isn't in effect: runs use the built-in prompt until you fix it or reset it. ${entry.overrideError ?? ""}`.trim();
}

/** The error the service would give for saving `draft` as this prompt, or null. Blank is fine (it resets). */
export function promptDraftError(entry: Pick<PromptEntry, "variables">, draft: string): string | null {
  if (!draft.trim()) return null;
  return templateError(
    draft,
    entry.variables.map((v) => v.name),
  );
}

/** The text in effect for the editor to start from: the user's override, else the built-in. */
export function promptStartText(entry: Pick<PromptEntry, "override" | "builtin">): string {
  return entry.override ?? entry.builtin;
}

/** True when saving `draft` would change what's stored. */
export function promptDraftDirty(entry: Pick<PromptEntry, "override" | "builtin">, draft: string): boolean {
  return promptOverrideFor(entry, draft) !== entry.override;
}

/**
 * What storing `draft` means: null (the built-in) when it's blank, as the service treats it, or
 * exactly the built-in, so the prompt keeps picking up built-in improvements; otherwise the text.
 */
export function promptOverrideFor(entry: Pick<PromptEntry, "builtin">, draft: string): string | null {
  return !draft.trim() || draft === entry.builtin ? null : draft;
}

/** The settings PATCH that saves `draft` (or resets with null). */
export function promptSavePatch(entry: Pick<PromptEntry, "id" | "builtin">, draft: string | null): Pick<Settings, "prompts"> {
  const value = draft == null ? null : promptOverrideFor(entry, draft);
  return { prompts: { [entry.id]: value } as Partial<Record<PromptId, string | null>> };
}

/** `insert` put in place of text[start, end), with the caret after it. */
export function insertText(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return { text: text.slice(0, a) + insert + text.slice(b), caret: a + insert.length };
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/**
 * A line diff turning `from` into `to` (longest common subsequence): deletions come before the
 * additions that replace them. Prompts are a few hundred lines at most, so O(n·m) is fine.
 */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from.split("\n");
  const b = to.split("\n");
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the LCS length of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ type: "del", text: a[i++]! });
    } else {
      out.push({ type: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++]! });
  while (j < m) out.push({ type: "add", text: b[j++]! });
  return out;
}
