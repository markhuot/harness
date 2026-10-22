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

const SECRET_WORD = "(?:token|secret|password|passwd|pass|pwd|key|apikey|auth|authorization|credential|cookie)s?";
// A name that holds a secret word as a whole segment (`api-key`, `GH_TOKEN`), so `--passive` and `--bypass` don't count.
// Segments are alphanumeric runs split by `-`/`_`, so each string splits one way and matching stays linear.
const SECRET_NAME = `(?:[A-Za-z0-9]+[-_]+)*${SECRET_WORD}(?:[-_]+[A-Za-z0-9]+)*`;
// One shell word: quoted runs, backslash escapes and bare text joined, so `'pa'\''ss'` is one value.
const VALUE = `(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|\\\\.|[^\\s"'\\\\])+`;
const MASK = "***";
const BARE_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{16,}|xox[bpas]-[A-Za-z0-9-]{10,}|glpat-[\w-]{10,}|AKIA[0-9A-Z]{16})/gi;

/**
 * Masks what looks like a credential in one line of text: `Name: value` headers, `--token x` flags,
 * `FOO_KEY=x` assignments, JSON `"token":"x"` fields, `curl -u user:pass`, URL passwords, webhook URL
 * paths, and well-known token shapes (`ghp_`, `github_pat_`, `sk-`, `xoxb-`, `glpat-`, `AKIA`). Best effort, not a guarantee.
 */
export function maskSecrets(line: string): string {
  return line
    .replace(/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, `$1${MASK}@`)
    .replace(/(hooks\.slack\.com\/(?:services|triggers|workflows)\/|\/api\/webhooks\/)[^\s"'?#]+/gi, `$1${MASK}`)
    .replace(/((?:^|\s)(?:-u|--user|--proxy-user)(?:=|\s+)["']?[^\s:"']*:)[^\s"']+/g, `$1${MASK}`)
    .replace(new RegExp(`(\\b${SECRET_NAME}\\s*:\\s*)[^"'\\n]+`, "gi"), `$1${MASK}`)
    .replace(new RegExp(`(\\\\?"${SECRET_NAME}\\\\?"\\s*:\\s*)(?:\\\\?"[^"\\\\]*\\\\?"|[^\\s,}"'\\\\]+)`, "gi"), `$1${MASK}`)
    .replace(new RegExp(`(--?(?:[A-Za-z0-9]+[-_]+)*${SECRET_WORD}(?:[-_]+[A-Za-z0-9]+)*)(=|\\s+(?!-))${VALUE}`, "gi"), `$1$2${MASK}`)
    .replace(new RegExp(`(\\b${SECRET_NAME}=)${VALUE}`, "gi"), `$1${MASK}`)
    .replace(/\b(bearer|basic)\s+[^\s"']+/gi, `$1 ${MASK}`)
    .replace(BARE_TOKEN, MASK);
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
  if (w.lastError?.trim()) return "error";
  return "active";
}

export const LISTENER_STATUS_LABEL: Record<ListenerStatus, string> = { paused: "Paused", running: "Running", error: "Error", active: "Active" };

function span(sec: number): string {
  if (sec <= 0) return "0s";
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

/** The chief that owns a listener, for the All chief's list: the owner's name tag, "Another chief" when its owner is no longer known, or null when the listener belongs to the viewer or to no chief (no tag). */
export function listenerOwner(w: Pick<Watcher, "cosId">, viewer: Pick<Cos, "ticketId">, chiefName: (cosId: string) => string | null): string | null {
  if (!w.cosId || w.cosId === viewer.ticketId) return null;
  return chiefName(w.cosId) ?? "Another chief";
}

/** "in 5m" for a time ahead of `now` (ms). */
export function until(ts: number, now: number): string {
  const s = Math.round((ts - now) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}
