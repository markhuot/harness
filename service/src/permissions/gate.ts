// PermissionGate: decides whether a native tool call (bash, write_file, edit_file, reads outside
// the workdir) may run, for drivers without their own permission system (anthropic-api, dummy).
// See DESIGN.md "Permissions". Per call:
//   1. static policy: hard-deny patterns → deny; reads/edits inside the workdir and read-only
//      commands (allowlist) → allow; read_only mode → deny everything else
//   2. human grants (ticket.allowedTools, one-time grants) → allow
//   3. ask mode → a human; auto mode → the classifier (allow → run, soft_deny → denied to the
//      agent so it can find another way, and a card only if the run ends stuck on it (env.defer),
//      hard_deny → deny with its reason). Classifier failure or timeout → a human, never allow.
// Every decision on a gated call is logged (PermissionDecisionLog) so the human can audit it.

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { PermissionDecisionLog, PermissionMode, RunKind } from "@harness/shared";
import { hardDenyReason, isReadOnlyCommand } from "./bash";
import type { Classifier, ClassifierRequest } from "./classifier";

export type GateDecision = { behavior: "allow" } | { behavior: "deny"; message: string };
export type ApprovalAnswer = { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

export interface GateEnv {
  mode: PermissionMode;
  runKind: RunKind;
  /** The run's working directory: the project scope for "inside the workdir" */
  cwd: string;
  /** Human grants: tool allowed for the ticket, or a one-time grant for exactly this call (consumed) */
  isGranted(tool: string, input: unknown): boolean;
  /** Send the call to a human (HarnessOps.requestApproval) */
  requestApproval(tool: string, input: unknown, meta: { reason: string; source: "classifier" | "policy" }): Promise<ApprovalAnswer>;
  /**
   * A classifier soft_deny the agent gets to work around first: the call is denied with the
   * reason, and the run remembers it (it becomes an approval card only if the run ends stuck on
   * it). Without it, a soft_deny goes to requestApproval right away.
   */
  defer?(tool: string, input: unknown, reason: string): void;
  log(entry: PermissionDecisionLog): void;
  /** Context for the classifier (lazy: only built when the classifier is consulted) */
  context(): Pick<ClassifierRequest, "ticket" | "transcript">;
  signal?: AbortSignal;
}

export interface PermissionGateOptions {
  /** The configured classifier (null → "off": auto mode asks a human instead) */
  classifier: () => Classifier | null;
  timeoutMs?: number;
  now?: () => number;
}

export const CLASSIFIER_TIMEOUT_MS = 60_000;

/** A classifier reason ending in a full stop, so the instructions after it read as a new sentence. */
const sentence = (reason: string) => reason.trim().replace(/[.!?]?$/, (end) => end || ".");

/** A deferred soft_deny, as the model sees it: `${CLASSIFIER_DENIED}<reason>.${CLASSIFIER_DENIED_NEXT}` */
export const CLASSIFIER_DENIED = "Permission denied by the auto-mode classifier: ";
export const CLASSIFIER_DENIED_NEXT =
  " Don't retry this call or rephrase it to get it through. Rethink the step: if a safer command or approach gets you to the same goal, take it and keep working. If there's no other way, ask the human as your instructions say; they can approve this call.";

/** Tools the gate checks. Anything else (harness tools) is not a native side effect. */
export const GATED_TOOLS = new Set(["bash", "write_file", "edit_file", "read_file", "list_files"]);

const READ_TOOLS = new Set(["read_file", "list_files"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

function expandPath(cwd: string, p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** realpath of the nearest existing ancestor + the rest, so symlinks can't smuggle a path out. */
function realish(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      return [realpathSync(head), ...tail.reverse()].join(sep);
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.push(head.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      head = parent;
    }
  }
}

/** Is `p` (relative to cwd, ~ and absolute allowed) inside cwd after resolving symlinks? */
export function insideWorkdir(cwd: string, p: string): boolean {
  const root = realish(resolve(cwd));
  const target = realish(expandPath(cwd, p));
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Edits to git internals (hooks, config) run code later: never fast-allowed. */
function protectedInWorkdir(cwd: string, p: string): boolean {
  const rel = relative(realish(resolve(cwd)), realish(expandPath(cwd, p)));
  return rel.split(sep).includes(".git");
}

export function summarizeCall(tool: string, input: unknown, max = 160): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const raw = typeof o.command === "string" ? o.command : typeof o.path === "string" ? o.path : JSON.stringify(input ?? null);
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Assessment =
  | { kind: "allow"; reason: string; quiet?: boolean }
  | { kind: "deny"; reason: string }
  | { kind: "judge"; what: string; editInWorkdir?: boolean };

function assess(tool: string, input: Record<string, unknown>, cwd: string): Assessment {
  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    const hard = hardDenyReason(command);
    if (hard) return { kind: "deny", reason: `Blocked by policy: ${hard}.` };
    if (isReadOnlyCommand(command)) return { kind: "allow", reason: "read-only command" };
    return { kind: "judge", what: "this command" };
  }
  const path = typeof input.path === "string" ? input.path : ".";
  if (READ_TOOLS.has(tool)) {
    if (insideWorkdir(cwd, path)) return { kind: "allow", reason: "read inside the working directory", quiet: true };
    return { kind: "judge", what: "a read outside the working directory" };
  }
  if (EDIT_TOOLS.has(tool)) {
    if (insideWorkdir(cwd, path) && !protectedInWorkdir(cwd, path)) return { kind: "judge", what: "an edit", editInWorkdir: true };
    return { kind: "judge", what: insideWorkdir(cwd, path) ? "an edit to git internals" : "an edit outside the working directory" };
  }
  return { kind: "allow", reason: "not a gated tool", quiet: true };
}

const deny = (message: string): GateDecision => ({ behavior: "deny", message });

/** Per-call logging and human-approval helpers shared by check() and judge(). */
function helpers(tool: string, rawInput: unknown, env: GateEnv) {
  const summary = summarizeCall(tool, rawInput);
  const log = (decision: PermissionDecisionLog["decision"], reason: string, source: PermissionDecisionLog["source"], extra: Partial<PermissionDecisionLog> = {}) =>
    env.log({ tool, summary, decision, reason, source, mode: env.mode, ...extra });
  const ask = async (reason: string, source: "classifier" | "policy"): Promise<GateDecision> => {
    log("ask", reason, source);
    const answer = await env.requestApproval(tool, rawInput ?? {}, { reason, source });
    return answer.behavior === "allow" ? { behavior: "allow" } : deny(answer.message);
  };
  return { summary, log, ask };
}

export class PermissionGate {
  constructor(private readonly opts: PermissionGateOptions) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  async check(tool: string, rawInput: unknown, env: GateEnv): Promise<GateDecision> {
    if (!GATED_TOOLS.has(tool)) return { behavior: "allow" };
    const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
    const { log, ask } = helpers(tool, rawInput, env);

    const a = assess(tool, input, env.cwd);
    if (a.kind === "deny") {
      log("deny", a.reason, "policy");
      return deny(`${a.reason} This action is never allowed; do something else.`);
    }
    if (a.kind === "allow") {
      if (!a.quiet) log("allow", a.reason, "policy");
      return { behavior: "allow" };
    }

    if (env.mode === "read_only") {
      const reason = `Read-only mode: ${a.what} isn't allowed.`;
      log("deny", reason, "policy");
      return deny(`${reason} This ticket is read-only; don't retry it. Report what you would change instead.`);
    }
    if (a.editInWorkdir) {
      log("allow", "edit inside the working directory", "policy");
      return { behavior: "allow" };
    }
    if (env.isGranted(tool, rawInput ?? {})) {
      log("allow", "approved by you for this ticket", "policy");
      return { behavior: "allow" };
    }
    if (env.mode === "ask") return ask(`Ask mode: ${a.what} needs your approval.`, "policy");
    return this.judge(tool, rawInput, env, a.what);
  }

  /**
   * Auto mode's classifier step for a call no policy or grant settled: allow → run; soft_deny →
   * deferred to the agent (env.defer) or a human; hard_deny → deny. Failure, timeout or no
   * classifier → a human, never allow. Also used for Claude Code calls that reach the prompt tool
   * while an auto-mode ticket's run is in ask mode (planGrants).
   */
  async judge(tool: string, rawInput: unknown, env: GateEnv, what = "this call"): Promise<GateDecision> {
    const { summary, log, ask } = helpers(tool, rawInput, env);
    const classifier = this.opts.classifier();
    if (!classifier) return ask(`Auto mode without a classifier: ${what} needs your approval.`, "policy");
    const started = this.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    env.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = this.opts.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ctx = env.context();
      const verdict = await Promise.race([
        classifier.classify({ tool, input: rawInput ?? {}, cwd: env.cwd, runKind: env.runKind, ...ctx }, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs);
        }),
      ]);
      const meta = { backend: classifier.backend, latencyMs: this.now() - started };
      if (verdict.decision === "allow") {
        log("allow", verdict.reason, "classifier", meta);
        return { behavior: "allow" };
      }
      if (verdict.decision === "hard_deny") {
        log("deny", verdict.reason, "classifier", meta);
        return deny(`${CLASSIFIER_DENIED}${sentence(verdict.reason)} This action is never allowed, so don't retry it or rephrase it to get it through. Find another way to do the task without it and keep working; if there is none, ask the human as your instructions say.`);
      }
      if (env.defer) {
        log("deny", verdict.reason, "classifier", meta);
        env.defer(tool, rawInput ?? {}, verdict.reason);
        return deny(`${CLASSIFIER_DENIED}${sentence(verdict.reason)}${CLASSIFIER_DENIED_NEXT}`);
      }
      env.log({ tool, summary, decision: "ask", reason: verdict.reason, source: "classifier", mode: env.mode, ...meta });
      const answer = await env.requestApproval(tool, rawInput ?? {}, { reason: verdict.reason, source: "classifier" });
      return answer.behavior === "allow" ? { behavior: "allow" } : deny(answer.message);
    } catch (err) {
      if (env.signal?.aborted) return deny("The run was cancelled.");
      const why = err instanceof Error ? err.message : String(err);
      return ask(`The classifier couldn't decide (${why}), so ${what} needs your approval.`, "policy");
    } finally {
      clearTimeout(timer);
      env.signal?.removeEventListener("abort", onAbort);
    }
  }
}
