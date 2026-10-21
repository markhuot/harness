// The transcript as run sections: each run opens with a sticky header ("Work • Claude Code, Opus
// 5.5" and its start time) and the rows that run produced under it. Pure, so the desktop and iOS
// clients (HarnessKit's RunSections) split and label the same way.

import { PHASE_LABELS, runPhase } from "../phases";
import type { DriverInfo, ModelInfo, Run } from "../protocol";
import { driverLabel, type TranscriptItem } from "./format";
import { subagentModelLabel } from "./subagents";

/** What a row says about its run, for splitting. null for rows that belong to no run (streaming text, "Working…"). */
export interface RowRun {
  runId: string | null;
  /** The text of a "Run started (…)" status: the header draws instead of it, so the row is dropped */
  startText: string | null;
  createdAt: number;
}

export interface RunSection<T> {
  /** null: a section of the human's messages, or the rows before the first run (no header) */
  runId: string | null;
  /** The run's "Run started (…)" text, when its entry is in the list: the header's fallback when the run isn't loaded */
  startText: string | null;
  /** When the section's first row was written: the header's last-resort time */
  firstAt: number | null;
  rows: T[];
}

const RUN_STARTED = /^Run started \(([^)]*)\)$/;

/** The text of a run-start status ("Run started (work · opus)"), else null. */
export function runStartedText(text: string): string | null {
  return RUN_STARTED.test(text) ? text : null;
}

/**
 * Split rows into run sections. A section starts at the first row whose run differs from the
 * current section's. The human's messages have no run: they form sections of their own with no
 * header (so no run's header sticks above them), and so do rows before the first run. A run that
 * carries on after such a message opens another section, with its header again. Rows that tell
 * nothing about their run (`at` returns null: streaming text, "Working…", a status written without
 * a run) go to the last section.
 * The "Run started" rows are consumed (they become the header).
 */
export function splitRunSections<T>(rows: T[], at: (row: T) => RowRun | null): RunSection<T>[] {
  const sections: RunSection<T>[] = [];
  let cur: RunSection<T> | null = null;
  for (const row of rows) {
    const info = at(row);
    if (!cur || (info && info.runId !== cur.runId)) {
      cur = { runId: info?.runId ?? null, startText: null, firstAt: null, rows: [] };
      sections.push(cur);
    }
    if (info?.startText && info.runId === cur.runId) {
      cur.startText ??= info.startText;
      cur.firstAt ??= info.createdAt;
      continue;
    }
    if (info) cur.firstAt ??= info.createdAt;
    cur.rows.push(row);
  }
  return sections;
}

export interface RunHeader {
  /** "Work • Claude Code, Opus 5.5" */
  title: string;
  /** When the run started (ms), for the right-aligned time */
  at: number | null;
}

/** "conductor" → "Conductor": the label of a run kind that has no phase. */
const kindLabel = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);

/**
 * A run's header. The phase, driver and model come from the run; the model is the driver's list
 * name when the list is loaded, else the id made readable. A run on the driver's default model
 * names it when the list is loaded and says just the driver otherwise. A run the client hasn't
 * loaded falls back to the kind in its "Run started (kind · …)" text, and to the first row's time.
 */
export function runHeader(
  run: Run | null | undefined,
  ctx: { startText?: string | null; firstAt?: number | null; drivers?: DriverInfo[]; models?: ModelInfo[] },
): RunHeader {
  if (!run) {
    const kind = (RUN_STARTED.exec(ctx.startText ?? "")?.[1] ?? "").split(" · ")[0]!.trim();
    return { title: kind ? phaseOrKindLabel(kind) : "Run", at: ctx.firstAt ?? null };
  }
  const parts = `${phaseOrKindLabel(run.kind)} • ${driverLabel(run.driver, ctx.drivers)}`;
  const listed = ctx.models?.find((m) => m.id === run.model)?.name;
  const model = run.model ? (listed ?? subagentModelLabel(run.model)) : ctx.models?.find((m) => m.default)?.name;
  return { title: model ? `${parts}, ${model}` : parts, at: run.startedAt || run.createdAt || ctx.firstAt || null };
}

function phaseOrKindLabel(kind: string): string {
  const phase = runPhase(kind as Run["kind"]);
  // runPhase maps every non-plan/review/complete kind to work, so name the kinds that aren't Work.
  return (kind === "work" || phase !== "work") ? PHASE_LABELS[phase] : kindLabel(kind);
}

/**
 * A grouped transcript item's run, for `splitRunSections`. The human's messages with no run are
 * their own section; anything else the service wrote without a run ("Moved to review") says nothing
 * about its run (null), so it stays where it is.
 */
export function itemRun(item: TranscriptItem): RowRun | null {
  const e = item.kind === "tool" ? item.call : item.entry;
  const c = e.content;
  if (!e.runId && !(e.role === "user" && c.type === "text")) return null;
  return { runId: e.runId, startText: item.kind === "entry" && c.type === "status" && !c.permission ? runStartedText(c.text) : null, createdAt: e.createdAt };
}
