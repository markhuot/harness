// The process a browser_run script runs in (tools/browser-run.ts starts it). It never touches
// Chrome: each page call (click, wait, evaluate…) goes to the service over IPC, which runs it
// through the same browser tools the agent calls, so a reload between steps is just another step.
// console.* and log() go back over IPC as log lines; the script's default export is its result.
// expect is bun:test's, with page matchers that wait in the page the same way.
//
//   bun service/src/browser/script-child.ts <script.mjs>     (a checkout)
//   harness-service browser-script <script.mjs>              (Harness.app)

import { expect } from "bun:test";
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
  click: (element: string | Opts, opts?: Opts) => call("click", [element, opts ?? {}]),
  type: (element: string | Opts, text: string, opts?: Opts) => call("type", [element, text, opts ?? {}]),
  keys: (input: Opts) => call("keys", [input ?? {}]),
  select: (element: string | Opts, opts?: Opts) => call("select", [element, opts ?? {}]),
  upload: (element: string | Opts, paths: string | string[], opts?: Opts) => call("upload", [element, paths, opts ?? {}]),
  snapshot: (opts?: Opts) => call("snapshot", [opts ?? {}]),
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
/** expect(page): the page itself, for toHaveURL. */
const page = Object.freeze({ toString: () => "page" });

/**
 * The page matchers on Bun's expect, named after Playwright's web-first assertions. Each sends its
 * target, arguments and whether it was .not to the service, which waits for the matching condition
 * (tools/browser-run.ts) and answers with the wait's summary when it never held. Bun makes the
 * failure's error at the expect() call, so its stack points at the script line.
 */
const PAGE_MATCHERS = ["toBeVisible", "toBeHidden", "toBeEnabled", "toContainText", "toHaveCount", "toHaveValue", "toHaveAttribute", "toHaveURL"] as const;

/** An argument as JSON: page as { page: true }, a RegExp as { regexp: "/re/flags" }. */
const wire = (v: unknown): unknown => (v === page ? { page: true } : v instanceof RegExp ? { regexp: String(v) } : v);

expect.extend(
  Object.fromEntries(
    PAGE_MATCHERS.map((name) => [
      name,
      async function (this: { isNot: boolean }, received: unknown, ...args: unknown[]) {
        const isNot = this.isNot;
        try {
          await call("expect", [wire(received), name, args.map(wire), isNot]);
          return { pass: !isNot, message: () => "" };
        } catch (e) {
          return { pass: isNot, message: () => (e as Error).message };
        }
      },
    ]),
  ),
);

Object.assign(globalThis, api, { expect, page });
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
    // Bun starts a custom matcher's message with blank lines.
    error: String(err?.message ?? e).replace(/^\n+/, ""),
    ...(typeof err?.stack === "string" ? { stack: err.stack } : {}),
    ...(err instanceof StepError ? { step: err.step } : {}),
  });
}
// Let the last message go out before the process ends.
setTimeout(() => process.exit(0), 20);
