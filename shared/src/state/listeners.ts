// The listeners (watchers) a chief of staff manages, as its Listeners tab shows them. Pure: the
// clients derive the list from the watchers they already hold, so it stays live with no endpoint.

import type { Cos } from "../cos";
import type { Watcher } from "../protocol";
import { watcherCommandLine } from "../watchers";

/** The watchers a chief manages, paused last, then by name. The All chief manages every watcher; a group's chief only its own. */
export function chiefListeners(watchers: readonly Watcher[], chief: Pick<Cos, "ticketId" | "scope">): Watcher[] {
  const own = chief.scope === "all" ? watchers : watchers.filter((w) => w.cosId === chief.ticketId);
  return [...own].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

const SECRET_WORD = "(?:token|secret|password|passwd|pass|pwd|key|auth|credential|cookie)";
const MASK = "***";

/** Masks what looks like a credential in one line of text: inline headers, `--token x` flags, `FOO_KEY=x` assignments and URL passwords. Best effort, not a guarantee. */
export function maskSecrets(line: string): string {
  return line
    .replace(/(authorization\s*[:=]\s*)[^"'\n]+/gi, `$1${MASK}`)
    .replace(/\b(bearer|basic)\s+[^\s"']+/gi, `$1 ${MASK}`)
    .replace(new RegExp(`(--?[\\w-]*${SECRET_WORD}[\\w-]*)(=|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), `$1$2${MASK}`)
    .replace(new RegExp(`(\\b[\\w]*${SECRET_WORD}[\\w]*=)("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), `$1${MASK}`)
    .replace(/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, `$1${MASK}@`);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * What a listener runs, safe to show: the command's first line with leading `VAR=value` assignments
 * dropped, credentials masked and the whole cut to `max` characters. Never includes `env`.
 */
export function listenerCommand(w: Pick<Watcher, "command" | "args">, max = 90): string {
  const first = watcherCommandLine(w).split(/\r?\n/).find((l) => l.trim()) ?? "";
  const bare = first.replace(/^\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
  return clip(maskSecrets(bare).replace(/\s+/g, " ").trim(), max);
}

/** A listener's last error, masked and cut to one short line ("" when it has none). */
export function listenerError(w: Pick<Watcher, "lastError">, max = 120): string {
  const first = (w.lastError ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  return clip(maskSecrets(first).replace(/\s+/g, " ").trim(), max);
}

export type ListenerStatus = "paused" | "running" | "error" | "active";

/** paused (switched off), running (a process is alive), error (the last run failed), else active (waiting for its next run). */
export function listenerStatus(w: Pick<Watcher, "enabled" | "lastError" | "live">): ListenerStatus {
  if (!w.enabled) return "paused";
  if (w.live?.state === "running") return "running";
  if (w.lastError) return "error";
  return "active";
}

export const LISTENER_STATUS_LABEL: Record<ListenerStatus, string> = { paused: "Paused", running: "Running", error: "Error", active: "Active" };

function span(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** How often it runs: "Every 5m" for an interval, "Runs continuously" for a loop. */
export function listenerSchedule(w: Pick<Watcher, "mode" | "intervalSec">): string {
  return w.mode === "loop" ? "Runs continuously" : `Every ${span(w.intervalSec)}`;
}

/** When it runs next, if the service says so and it is on (null otherwise). */
export function listenerNextRun(w: Pick<Watcher, "enabled" | "live">): number | null {
  return w.enabled ? (w.live?.nextRunAt ?? null) : null;
}

/** The chief that owns a listener, for the All chief's list: the owner's name tag, or null when the listener belongs to the viewer (no tag). */
export function listenerOwner(w: Pick<Watcher, "cosId">, viewer: Pick<Cos, "ticketId">, chiefName: (cosId: string) => string | null): string | null {
  if (!w.cosId || w.cosId === viewer.ticketId) return null;
  return chiefName(w.cosId);
}
