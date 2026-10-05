// Labels, previews and small derivations the desktop and iOS UIs present the same way. Pure.

import type {
  ClassifierBackend,
  DriverInfo,
  PermissionDecisionLog,
  PermissionMode,
  Session,
  Ticket,
  TicketKind,
  TicketStatus,
  TranscriptEntry,
  TriageStatus,
} from "../protocol";
import { PERMISSION_MODE_LABELS } from "../permissions";
import { commandLine } from "../commandLine";

export const STATUS_LABEL: Record<TicketStatus, string> = {
  planning: "Planning",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

/** Board column placeholder when a column has no tickets. */
export const COLUMN_EMPTY_TEXT: Record<TicketStatus, string> = {
  planning: "Sessions you want to plan first",
  in_progress: "Agents at work show up here",
  blocked: "Nothing waiting on you",
  review: "Nothing to review",
  done: "Finished work",
};

const DRIVER_SHORT: Record<string, string> = { "claude-code": "Claude Code", "anthropic-api": "API", dummy: "Dummy" };
export function driverLabel(id: string, drivers?: DriverInfo[]) {
  return DRIVER_SHORT[id] ?? drivers?.find((d) => d.id === id)?.name ?? id;
}

/** Icon for a driver badge. */
export function driverIcon(id: string): "bot" | "key" | "sparkle" {
  return id === "dummy" ? "bot" : id === "anthropic-api" ? "key" : "sparkle";
}

export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.round((now - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** ~/… for paths under a macOS home directory. */
export const tildify = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

// ---------------------------------------------------------------------------
// Composers
// ---------------------------------------------------------------------------

/** Ticket message composer placeholder by status. */
export const COMPOSER_PLACEHOLDER: Record<TicketStatus, string> = {
  planning: "Refine the plan…",
  in_progress: "Send a follow-up…",
  blocked: "Answer the agent…",
  review: "Ask about the work, or ask for a change…",
  done: "Ask about the finished work…",
};

/** New-session prompt placeholder. Start vs plan is picked when it's submitted, so only the kind matters. */
export function newSessionPlaceholder(kind: TicketKind): string {
  return kind === "conductor" ? "Describe a larger job. The conductor splits it into tickets and steers them…" : "What should the agent do? Start it now, or plan it first…";
}

// ---------------------------------------------------------------------------
// Tools, approvals, permissions
// ---------------------------------------------------------------------------

/** mcp__harness__post_note → post_note */
export const shortToolName = (name: string) => name.replace(/^mcp__[^_]+__/, "");

export type ShownInput = { label: string; value: string; code: boolean };

/** Pick the part of a tool input a human needs to judge an approval request. */
export function describeApprovalInput(toolName: string, input: unknown): { primary: ShownInput | null; description: string | null; rest: Record<string, unknown> | null } {
  const o = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : null;
  if (!o) return { primary: input === undefined || input === null ? null : { label: "Input", value: JSON.stringify(input, null, 2), code: true }, description: null, rest: null };
  const take = (k: string) => {
    const v = o[k];
    delete o[k];
    return typeof v === "string" ? v : null;
  };
  const description = take("description");
  const tool = shortToolName(toolName);
  let primary: ShownInput | null = null;
  const pick = (k: string, label: string, code: boolean) => {
    if (primary || typeof o[k] !== "string") return;
    primary = { label, value: take(k)!, code };
  };
  if (/^bash$/i.test(tool)) pick("command", "Command", true);
  if (/^(write|edit|multiedit|read|notebookedit)$/i.test(tool)) {
    pick("file_path", "File", true);
    pick("notebook_path", "File", true);
  }
  if (/^(webfetch|websearch)$/i.test(tool)) {
    pick("url", "URL", false);
    pick("query", "Query", false);
  }
  // Harness config tools: a watcher's command line is what the human is really approving.
  if (/^(create|update)_watcher$/.test(tool) && (typeof o.command === "string" || Array.isArray(o.args))) {
    const args = Array.isArray(o.args) ? o.args.map(String) : [];
    primary = { label: "Command", value: commandLine(typeof o.command === "string" ? o.command : "(unchanged command)", args), code: true };
    delete o.command;
    delete o.args;
  }
  if (/^(delete|run)_watcher$/.test(tool) || tool === "update_watcher") pick("watcher", "Watcher", false);
  if (/^(create|delete|update)_project$/.test(tool)) {
    pick("path", "Directory", true);
    pick("project_key", "Project", false);
  }
  if (tool === "delete_ticket") pick("key", "Ticket", false);
  pick("command", "Command", true);
  pick("url", "URL", false);
  pick("file_path", "File", true);
  pick("path", "Path", true);
  return { primary, description, rest: Object.keys(o).length ? o : null };
}

/** Toast after answering an approval. */
export function approvalToast(decision: "allow_once" | "allow_tool" | "deny", tool: string, ticketKey: string): string {
  return decision === "deny" ? `Denied ${tool}` : decision === "allow_tool" ? `${tool} allowed on ${ticketKey}` : `Allowed ${tool} once`;
}

export function permissionVerb(log: Pick<PermissionDecisionLog, "decision" | "source">): string {
  return log.decision === "allow" ? (log.source === "classifier" ? "Auto-approved" : "Allowed") : log.decision === "ask" ? "Asked you" : "Denied";
}

/** "classifier · claude-cli · 2.4s" / "policy" */
export function decisionSource(log: Pick<PermissionDecisionLog, "source" | "backend" | "latencyMs">): string {
  const parts: string[] = [log.source];
  if (log.backend) parts.push(log.backend);
  if (log.latencyMs !== undefined) parts.push(`${(log.latencyMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODE_LABELS[mode]?.label ?? mode;
}

export const CLASSIFIER_LABELS: Record<ClassifierBackend, string> = {
  "claude-cli": "Claude CLI (your Claude plan)",
  "anthropic-api": "Anthropic API (API key)",
  off: "Off (ask me instead)",
};

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export type ToolCallEntry = TranscriptEntry & { content: { type: "tool_call" } };
export type ToolResultEntry = TranscriptEntry & { content: { type: "tool_result" } };
export type TranscriptItem = { kind: "entry"; entry: TranscriptEntry } | { kind: "tool"; call: ToolCallEntry; result?: ToolResultEntry };

/** Pair each tool_call with its tool_result (by callId) so they render as one collapsible row. */
export function groupTranscript(entries: TranscriptEntry[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const calls = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const e of entries) {
    if (e.content.type === "tool_call") {
      const item = { kind: "tool" as const, call: e as ToolCallEntry };
      calls.set(e.content.callId, item);
      items.push(item);
    } else if (e.content.type === "tool_result" && calls.has(e.content.callId)) {
      calls.get(e.content.callId)!.result = e as ToolResultEntry;
    } else {
      items.push({ kind: "entry", entry: e });
    }
  }
  return items;
}

/** One-line preview of a tool input, e.g. the bash command or file path. */
export function toolPreview(name: string, input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["command", "url", "path", "file_path", "selector", "pattern", "key", "title", "question", "note", "expression", "text"]) {
      if (typeof o[k] === "string" && o[k]) return String(o[k]).split("\n")[0]!;
    }
    const s = JSON.stringify(o);
    return s === "{}" ? "" : s;
  }
  return input === undefined || input === null ? "" : String(input);
}

/** Icon for a tool row. */
export function toolIcon(name: string): "terminal" | "globe" | "tool" {
  return name === "bash" || name === "Bash" ? "terminal" : name.startsWith("browser") ? "globe" : "tool";
}

/** Pretty-print JSON-looking tool output; cap very long text. */
export function formatMaybeJson(text: string, max = 20000): string {
  const t = text.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {}
  }
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const TRIAGE_LABEL: Record<TriageStatus, { label: string; tone: "amber" | "green" | "neutral" | "red" }> = {
  triaging: { label: "Triaging", tone: "amber" },
  dispatched: { label: "Dispatched", tone: "green" },
  declined: { label: "Declined", tone: "neutral" },
  failed: { label: "Failed", tone: "red" },
};

/** "Dispatched to FOO-123" → "FOO-123" (the ticket a triage outcome names). */
export function dispatchedKey(session: Pick<Session, "outcome">): string | undefined {
  return session.outcome?.match(/\b[A-Z][A-Z0-9_]*-\d+\b/)?.[0];
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

/** URL bar input → a navigable URL ("example.com" → "https://example.com"); "" when empty. */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return "https://" + t;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Letterbox a w×h image into a box, preserving aspect ratio. */
export function fitRect(boxW: number, boxH: number, w: number, h: number): Rect {
  if (!w || !h || !boxW || !boxH) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(boxW / w, boxH / h);
  const dw = w * scale;
  const dh = h * scale;
  return { x: (boxW - dw) / 2, y: (boxH - dh) / 2, w: dw, h: dh };
}

/**
 * A point in the drawn frame (local to the box the frame is letterboxed into) → page CSS pixels.
 * null when the point is outside the drawn image or nothing is drawn yet.
 */
export function toPagePoint(local: { x: number; y: number }, drawn: Rect, page: { width: number; height: number }): { x: number; y: number } | null {
  if (!drawn.w || !drawn.h || !page.width || !page.height) return null;
  const lx = local.x - drawn.x;
  const ly = local.y - drawn.y;
  if (lx < 0 || ly < 0 || lx > drawn.w || ly > drawn.h) return null;
  return { x: Math.round((lx / drawn.w) * page.width), y: Math.round((ly / drawn.h) * page.height) };
}
