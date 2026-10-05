// The process a browser_run script runs in (tools/browser-run.ts starts it). It never touches
// Chrome: each page call (click, wait, evaluate…) goes to the service over IPC, which runs it
// through the same browser tools the agent calls, so a reload between steps is just another step.
// console.* and log() go back over IPC as log lines; the script's default export is its result.
//
//   bun service/src/browser/script-child.ts <script.mjs>     (a checkout)
//   harness-service browser-script <script.mjs>              (Harness.app)

import { pathToFileURL } from "node:url";
import { inspect } from "node:util";

/** What the child sends the service. */
export type ChildMessage =
  | { type: "call"; id: number; method: string; args: unknown[] }
  | { type: "log"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
  | { type: "done"; ok: true; value: unknown }
  | { type: "done"; ok: false; error: string; stack?: string; step?: string };

/** What the service answers a call with. */
export type ParentMessage = { type: "reply"; id: number; ok: true; value: unknown } | { type: "reply"; id: number; ok: false; error: string; step: string };

/** A page call that failed: carries the step, and the stack of the script line that made it. */
class StepError extends Error {
  step = "";
}

const send = (m: ChildMessage) => process.send!(m);
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; site: StepError }>();
let nextId = 1;

process.on("message", (m: ParentMessage) => {
  if (m?.type !== "reply") return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) return p.resolve(m.value);
  p.site.message = m.error;
  p.site.step = m.step;
  p.reject(p.site);
});

function call(method: string, args: unknown[]): Promise<unknown> {
  // Made here, so its stack points at the script line that called (the failure's location).
  const site = new StepError("");
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, site });
    send({ type: "call", id, method, args });
  });
}

const format = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 4, breakLength: Infinity }))).join(" ");

type Opts = Record<string, unknown>;
/** content(opts) and screenshot(opts) may skip their first argument. */
const split = (first: unknown, opts: Opts | undefined): [unknown, Opts] =>
  first !== null && typeof first === "object" && opts === undefined ? [undefined, first as Opts] : [first, opts ?? {}];

const api = {
  click: (selector: string, opts?: Opts) => call("click", [selector, opts ?? {}]),
  type: (selector: string, text: string, opts?: Opts) => call("type", [selector, text, opts ?? {}]),
  wait: (condition: Opts) => call("wait", [condition]),
  evaluate: (exprOrFn: string | ((...a: unknown[]) => unknown), opts?: Opts & { args?: unknown[] }) => {
    const expression = typeof exprOrFn === "function" ? `(${exprOrFn.toString()})(...${JSON.stringify(opts?.args ?? [])})` : String(exprOrFn);
    const { args: _a, ...rest } = opts ?? {};
    return call("evaluate", [expression, rest]);
  },
  content: (selector?: string | Opts, opts?: Opts) => call("content", split(selector, opts)),
  screenshot: (path?: string | Opts, opts?: Opts) => call("screenshot", split(path, opts)),
  open: (url: string, opts?: Opts) => call("open", [url, opts ?? {}]),
  resize: (size: Opts, opts?: Opts) => call("resize", [size, opts ?? {}]),
  url: () => call("url", []),
  log: (...args: unknown[]) => send({ type: "log", level: "log", text: format(args) }),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};
Object.assign(globalThis, api);
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  console[level] = (...args: unknown[]) => send({ type: "log", level, text: format(args) });
}

/** The result as JSON the IPC channel can carry (a function or a cycle becomes its description). */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) ?? null;
  } catch {
    return inspect(value, { depth: 4, breakLength: Infinity });
  }
}

const file = process.argv[process.argv.length - 1]!;
try {
  const mod = await import(pathToFileURL(file).href);
  send({ type: "done", ok: true, value: jsonSafe(mod.default) });
} catch (e) {
  const err = e as Partial<StepError> | undefined;
  send({
    type: "done",
    ok: false,
    error: String(err?.message ?? e),
    ...(typeof err?.stack === "string" ? { stack: err.stack } : {}),
    ...(err instanceof StepError ? { step: err.step } : {}),
  });
}
// Let the last message go out before the process ends.
setTimeout(() => process.exit(0), 20);
