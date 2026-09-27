// Live validation + preview for the project identifier field (Project settings → Identifier).
// Mirrors the service's rules (checkProjectKey + Orchestrator.updateProject collisions) so the
// field can explain a rename before it's saved; the service stays the authority.

import { checkProjectKey, type Project, type Ticket } from "../index";

export interface KeyPreview {
  /** Normalized (trimmed, upper-cased) draft */
  key: string;
  /** Why the draft can't be saved, if it can't */
  error: string | null;
  /** True when the draft differs from the current key */
  changed: boolean;
  /** Native tickets that would be renamed, in number order */
  renames: { from: string; to: string }[];
  /** Mirrored tickets that keep their keys */
  kept: string[];
  /** The next two native keys under the draft */
  next: string[];
  /** One-line description for the field hint */
  message: string;
}

/** Native tickets of a project: `<KEY>-<n>`, not mirrored from an external system. */
export function nativeTickets(project: Project, tickets: Ticket[]): { ticket: Ticket; suffix: string; n: number }[] {
  const prefix = `${project.key}-`;
  return tickets
    .filter((t) => t.projectId === project.id && !t.externalRef && t.key.startsWith(prefix) && /^\d+$/.test(t.key.slice(prefix.length)))
    .map((t) => ({ ticket: t, suffix: t.key.slice(prefix.length), n: Number(t.key.slice(prefix.length)) }))
    .sort((a, b) => a.n - b.n);
}

/** "1…3, 5, 7…8" for a sorted list of numbers. */
export function formatRuns(nums: number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j]! + 1) j++;
    runs.push(j === i ? String(nums[i]) : `${nums[i]}…${nums[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

export function previewProjectKey(project: Project, projects: Project[], tickets: Ticket[], draft: string): KeyPreview {
  const checked = checkProjectKey(draft);
  const key = checked.key;
  const changed = key !== project.key;
  const native = nativeTickets(project, tickets);
  const renaming = new Set(native.map((x) => x.ticket.id));
  const kept = tickets.filter((t) => t.projectId === project.id && t.externalRef).map((t) => t.key);
  const renames = changed && !checked.error ? native.map((x) => ({ from: x.ticket.key, to: `${key}-${x.suffix}` })) : [];

  let error: string | null = checked.error;
  if (!error && changed) {
    const other = projects.find((p) => p.id !== project.id && p.key === key);
    if (other) error = `Already used by ${other.name}`;
  }
  if (!error && changed) {
    const taken = new Map(tickets.map((t) => [t.key, t.id]));
    const clashes = renames.filter((r) => {
      const holder = taken.get(r.to);
      return holder !== undefined && !renaming.has(holder);
    });
    if (clashes.length) error = `${clashes.map((c) => c.to).slice(0, 3).join(", ")}${clashes.length > 3 ? "…" : ""} already exist${clashes.length === 1 ? "s" : ""}`;
  }

  // Next native numbers, skipping keys already taken (the service does the same).
  const next: string[] = [];
  if (!checked.error) {
    const taken = new Set(tickets.filter((t) => !renaming.has(t.id)).map((t) => t.key));
    for (let n = project.nextSeq; next.length < 2; n++) if (!taken.has(`${key}-${n}`)) next.push(`${key}-${n}`);
  }

  let message: string;
  if (error) message = error;
  else if (!changed) message = `New tickets are numbered ${next.join(", ")}…`;
  else {
    message = `Tickets will be numbered ${next.join(", ")}…`;
    if (renames.length) {
      const runs = formatRuns(native.map((x) => x.n));
      const verb = renames.length === 1 ? "becomes" : "become";
      message += `; existing ${project.key}-${runs} ${verb} ${key}-${runs}`;
    }
    if (kept.length) message += `. ${kept.length === 1 ? `${kept[0]} keeps its key` : `${kept.length} mirrored tickets keep their keys`}`;
  }
  return { key, error, changed, renames, kept, next, message };
}
