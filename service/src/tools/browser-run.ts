// browser_run: a JS script that drives a tab from outside the page, as a job the agent polls.
//
// The script runs in its own process (browser/script-child.ts), never in the service's. Each page
// call it makes (click, wait, evaluate…) comes back here over IPC and runs through the same browser
// tools the agent calls, so a reload between steps is just another step. Everything the job does
// lands in its log: its own console output, every step and its result, the page's console, its
// navigations and failed requests. browser_run and browser_run_status return within `wait`
// seconds with the lines since the last call, so a slow script never leaves the agent blind. Jobs
// stop at their timeout, when their run ends, and when their tab closes.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ToolResultContent } from "@harness/shared";
import type { ChildMessage, ParentMessage } from "../browser/script-child";
import type { BrowserPageEvent } from "../browser/types";
import { seconds } from "../browser/wait";
import { COMPILED } from "../runtime";
import { browserClick, browserContent, browserEval, browserOpen, browserResize, browserScreenshot, browserType, browserWait } from "./browser";
import type { ToolContext, ToolResult } from "./types";
import { defineTool, errorResult, schema } from "./util";

export const RUN_DEFAULT_TIMEOUT_S = 120;
export const RUN_MAX_TIMEOUT_S = 600;
export const RUN_DEFAULT_WAIT_S = 20;
export const RUN_MAX_WAIT_S = 60;
/** Lines one report returns at most (the rest are counted, not shown). */
const MAX_REPORT_LINES = 200;
/** Lines a job keeps; older ones are dropped (and counted). */
const MAX_JOB_LINES = 2_000;
/** Lines a job mirrors to the ticket's transcript before it stops mirroring. */
const MAX_STATUS_LINES = 300;
/** How often the transcript gets the job's new lines. */
const STATUS_FLUSH_MS = 1_000;
/** After the first new line, how long browser_run_status gathers more before answering. */
const GATHER_MS = 300;
/** Finished jobs kept per session, so their log can still be read. */
const KEEP_FINISHED = 20;

type JobStatus = "running" | "done" | "failed" | "stopped";
type LineSource = "run" | "step" | "script" | "page";

interface LogLine {
  at: number;
  source: LineSource;
  text: string;
}

interface Failure {
  message: string;
  /** "line 4, column 9" in the script, when the error came from a script line. */
  location?: string;
  step?: string;
  url?: string;
  screenshot?: string;
  screenshotPath?: string;
}

class Job {
  readonly started = Date.now();
  status: JobStatus = "running";
  lines: LogLine[] = [];
  /** Lines dropped from the front (MAX_JOB_LINES), so line numbers stay true. */
  dropped = 0;
  /** How many lines (counting dropped ones) the agent has been given. */
  delivered = 0;
  result: unknown;
  failure?: Failure;
  stopReason?: string;
  proc?: ReturnType<typeof Bun.spawn>;
  private wakers = new Set<() => void>();
  private offs: (() => void)[] = [];
  private statusQueue: string[] = [];
  private statusSent = 0;
  private statusTimer?: ReturnType<typeof setTimeout>;
  /** The last step that failed, so the script's failure can name it. */
  lastFailedStep?: { label: string; error: string };
  /** fail() is taking its screenshot: a second failure (the process exiting) waits its turn. */
  failing = false;
  private steps = 0;

  constructor(
    readonly id: number,
    readonly ctx: ToolContext,
    public tab: number | undefined,
    readonly timeoutS: number,
  ) {}

  get total(): number {
    return this.dropped + this.lines.length;
  }

  get sessionId(): string {
    return this.ctx.session.id;
  }

  log(source: LineSource, text: string): void {
    const line = { at: Date.now() - this.started, source, text };
    this.lines.push(line);
    if (this.lines.length > MAX_JOB_LINES) {
      const cut = this.lines.length - MAX_JOB_LINES;
      this.lines.splice(0, cut);
      this.dropped += cut;
    }
    this.mirror(formatLine(line));
    this.wake();
  }

  /** Copy a line to the ticket's transcript (batched, and capped so a chatty page can't flood it). */
  private mirror(text: string): void {
    if (this.statusSent >= MAX_STATUS_LINES) return;
    this.statusQueue.push(text);
    this.statusSent++;
    if (this.statusSent === MAX_STATUS_LINES) this.statusQueue.push(`(the rest of job ${this.id}'s log goes to the agent only)`);
    this.statusTimer ??= setTimeout(() => this.flushStatus(), STATUS_FLUSH_MS);
  }

  flushStatus(): void {
    clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    if (!this.statusQueue.length) return;
    const text = `browser_run job ${this.id}:\n${this.statusQueue.join("\n")}`;
    this.statusQueue = [];
    void this.ctx.ops.statusLine(this.ctx, text).catch(() => {});
  }

  onEnd(off: () => void): void {
    this.offs.push(off);
  }

  /** Mark the job over (once), release what it holds and wake anyone waiting on it. */
  finish(status: Exclude<JobStatus, "running">, how: string): void {
    if (this.status !== "running") return;
    this.status = status;
    this.log("run", how);
    for (const off of this.offs.splice(0)) off();
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGKILL");
    this.flushStatus();
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }

  /** Resolve after `ms`, when the job ends, or (with `onLine`) once a new line has arrived and settled. */
  until(ms: number, onLine: boolean): Promise<void> {
    if (this.status !== "running" || (onLine && this.total > this.delivered)) {
      return onLine && this.status === "running" ? Bun.sleep(GATHER_MS) : Promise.resolve();
    }
    return new Promise((resolve) => {
      let gathering = false;
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(waker);
        resolve();
      };
      const waker = () => {
        if (this.status !== "running") return done();
        if (onLine && !gathering && this.total > this.delivered) {
          gathering = true;
          setTimeout(done, GATHER_MS);
        }
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(waker);
    });
  }

  nextStep(): number {
    return ++this.steps;
  }
}

const jobs = new Map<number, Job>();
let nextJobId = 1;

/** Stop every running job of a run (the run ended or was cancelled). Called by the orchestrator. */
export function stopBrowserJobs(runId: string, why = "the run ended"): void {
  for (const job of jobs.values()) if (job.ctx.runId === runId) job.finish("stopped", `Stopped: ${why}.`);
}

/** The running job on a session's tab, if any (one job per tab at a time). */
function runningOn(sessionId: string, tab: number | undefined): Job | undefined {
  return [...jobs.values()].find((j) => j.status === "running" && j.sessionId === sessionId && j.tab === tab);
}

/** Forget a session's oldest finished jobs beyond KEEP_FINISHED. */
function prune(sessionId: string): void {
  const finished = [...jobs.values()].filter((j) => j.sessionId === sessionId && j.status !== "running");
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(j.id);
}

const pad = (s: string) => s.padEnd(6);

function formatLine(l: LogLine): string {
  const [first, ...rest] = l.text.split("\n");
  return [`${seconds(l.at).padStart(7)} ${pad(l.source)} ${first}`, ...rest.map((r) => `${" ".repeat(15)}${r}`)].join("\n");
}

function pageLine(e: BrowserPageEvent): string | null {
  switch (e.kind) {
    case "console":
      return `${e.level}: ${e.text}${e.source && (e.level === "error" || e.level === "warning") ? ` (${e.source})` : ""}`;
    case "exception":
      return `uncaught: ${e.text}${e.source ? ` (${e.source})` : ""}`;
    case "navigated":
      return `→ navigated to ${e.url}`;
    case "request-failed":
      return `✗ ${e.method} ${e.url} ${e.status ?? e.failure ?? "failed"}`;
    case "closed":
      return null;
  }
}

/** A step for the log: `click("button", { wait_for: { idle: true } })`, long arguments shortened. */
function stepLabel(method: string, args: unknown[]): string {
  // evaluate(fn) arrives as "(fn)(...[])": show the function as the script wrote it.
  if (method === "evaluate" && typeof args[0] === "string") {
    const m = /^\(([\s\S]*)\)\(\.\.\.\[\]\)$/.exec(args[0]);
    if (m) args = [m[1], ...args.slice(1)];
  }
  const shown = args
    .filter((a) => !(a && typeof a === "object" && !Array.isArray(a) && Object.keys(a as object).length === 0))
    .map((a) => {
      const s = JSON.stringify(a) ?? "undefined";
      return s.length > 100 ? `${s.slice(0, 97)}…` : s;
    });
  return `${method}(${shown.join(", ")})`;
}

const textOf = (r: ToolResult) =>
  r.content
    .filter((c): c is Extract<ToolResultContent, { type: "text" }> => c.type === "text")
    .map((c) => c.text);

/** browser_eval's JSON text as a value ("undefined" → undefined, bare NaN and the like as text). */
function parseEval(text: string): unknown {
  if (text === "undefined") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type Opts = Record<string, unknown>;
const opt = (o: unknown): Opts => (o && typeof o === "object" && !Array.isArray(o) ? (o as Opts) : {});
const str = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v) throw new Error(`${what} must be a non-empty string.`);
  return v;
};

/**
 * Run one page call from the script through the browser tools. Returns the call's value; a tool
 * error (a wait that timed out, a selector that matched nothing) throws with the tool's text.
 */
async function runStep(job: Job, method: string, args: unknown[]): Promise<unknown> {
  const { ctx } = job;
  const tab = job.tab;
  const exec = async (tool: { execute(input: any, ctx: ToolContext): Promise<ToolResult> }, input: Opts) => {
    const r = await tool.execute({ ...input, ...(tab !== undefined ? { tab } : {}) }, ctx);
    if (r.isError) throw new Error(textOf(r).join("\n"));
    return r;
  };
  switch (method) {
    case "click": {
      const o = opt(args[1]);
      return textOf(await exec(browserClick, { selector: str(args[0], "click's selector"), wait_for: o.wait_for })).join("\n");
    }
    case "type": {
      const o = opt(args[2]);
      if (typeof args[1] !== "string") throw new Error("type's text must be a string.");
      return textOf(await exec(browserType, { selector: str(args[0], "type's selector"), text: args[1], submit: o.submit, wait_for: o.wait_for })).join("\n");
    }
    case "wait":
      return textOf(await exec(browserWait, opt(args[0]))).join("\n");
    case "evaluate": {
      const o = opt(args[1]);
      const parts = textOf(await exec(browserEval, { expression: str(args[0], "evaluate's expression"), wait_for: o.wait_for }));
      return parseEval(parts[parts.length - 1] ?? "undefined");
    }
    case "content": {
      const o = opt(args[1]);
      const parts = textOf(await exec(browserContent, { selector: args[0] ?? undefined, format: o.format, max_chars: o.max_chars, wait_for: o.wait_for }));
      return parts[parts.length - 1] ?? "";
    }
    case "screenshot": {
      const o = opt(args[1]);
      const scope = await ctx.ops.fileOutputScope(ctx);
      const path = typeof args[0] === "string" && args[0] ? args[0] : join(scope.scratchDir, "browser-run", `job-${job.id}-${job.nextStep()}.png`);
      await exec(browserScreenshot, { save_to: path, wait_for: o.wait_for });
      return resolve(scope.readOnly ? scope.scratchDir : ctx.cwd, path);
    }
    case "open": {
      const o = opt(args[1]);
      const { wait_for, device, width, height } = o;
      const r = await exec(browserOpen, { url: str(args[0], "open's url"), wait_for, device, width, height });
      return textOf(r).join("\n");
    }
    case "resize": {
      const size = opt(args[0]);
      const o = opt(args[1]);
      return textOf(await exec(browserResize, { device: size.device, width: size.width, height: size.height, wait_for: o.wait_for })).join("\n");
    }
    case "url":
      return (await ctx.browser.state(job.sessionId, tab !== undefined ? { tab } : {}))?.url ?? "about:blank";
    default:
      throw new Error(`Unknown call ${method}.`);
  }
}

/** Where the script's error came from: the first stack frame in the script file. */
function locate(stack: string | undefined, file: string, prefix: number): string | undefined {
  if (!stack) return undefined;
  const escaped = file.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const m = new RegExp(`(?:file://)?${escaped}:(\\d+):(\\d+)`).exec(stack);
  if (!m) return undefined;
  const line = Number(m[1]);
  // The wrapper sits before the script on its first line.
  const column = line === 1 ? Math.max(1, Number(m[2]) - prefix) : Number(m[2]);
  return `line ${line}, column ${column}`;
}

/** The script wrapped so top-level await and `return` work, with its lines where they were. */
const WRAP_START = "export default await (async () => {";
const WRAP_END = "\n})();\n";

function childCommand(file: string): string[] {
  return COMPILED ? [process.execPath, "browser-script", file] : [process.execPath, resolve(import.meta.dir, "../browser/script-child.ts"), file];
}

async function start(job: Job, script: string): Promise<void> {
  const { ctx } = job;
  const scope = await ctx.ops.fileOutputScope(ctx);
  const dir = join(scope.scratchDir, "browser-run");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `job-${job.id}.mjs`);
  writeFileSync(file, WRAP_START + script + WRAP_END);

  // The page, as it happens: console, uncaught errors, navigations, failed requests.
  job.onEnd(
    ctx.browser.watch(job.sessionId, (e) => {
      if (job.tab !== undefined && e.tabId !== job.tab) return;
      if (e.kind === "closed") return job.finish("stopped", `Stopped: tab ${e.tabId} closed.`);
      const line = pageLine(e);
      if (line) job.log("page", line);
    }),
  );
  const onAbort = () => job.finish("stopped", "Stopped: the run was cancelled.");
  ctx.signal.addEventListener("abort", onAbort);
  job.onEnd(() => ctx.signal.removeEventListener("abort", onAbort));
  const timer = setTimeout(() => void fail(job, { message: `Timed out after ${job.timeoutS}s.` }, "stopped"), job.timeoutS * 1000);
  job.onEnd(() => clearTimeout(timer));

  const proc = Bun.spawn(childCommand(file), {
    cwd: ctx.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    serialization: "json",
    ipc(message: ChildMessage) {
      void onMessage(job, message, file);
    },
  });
  job.proc = proc;
  job.log("run", `Started on ${job.tab !== undefined ? `tab ${job.tab}` : "the session's first tab"} (pid ${proc.pid}; stops after ${job.timeoutS}s).`);
  void pipeLines(proc.stdout as ReadableStream<Uint8Array>, (l) => job.log("script", l));
  void pipeLines(proc.stderr as ReadableStream<Uint8Array>, (l) => job.log("script", `stderr: ${l}`));
  void proc.exited.then((code) => {
    // Give a done message that raced the exit a moment to land.
    setTimeout(() => {
      if (job.status === "running") void fail(job, { message: `The script's process exited (code ${code}) before it finished.` });
    }, 100);
  });
}

async function onMessage(job: Job, m: ChildMessage, file: string): Promise<void> {
  if (job.status !== "running") return;
  if (m.type === "log") return job.log("script", m.level === "log" ? m.text : `${m.level}: ${m.text}`);
  if (m.type === "call") {
    const label = stepLabel(m.method, m.args);
    let reply: ParentMessage;
    try {
      const value = await runStep(job, m.method, m.args);
      // A step that opened the session's first tab pins the job to it.
      if (job.tab === undefined) job.tab = (await job.ctx.browser.state(job.sessionId))?.tabId;
      job.log("step", `${label} → ${typeof value === "string" ? value : JSON.stringify(value) ?? "undefined"}`);
      reply = { type: "reply", id: m.id, ok: true, value: value === undefined ? null : value };
    } catch (e) {
      const error = (e as Error).message;
      job.lastFailedStep = { label, error };
      job.log("step", `${label} ✗ ${error}`);
      reply = { type: "reply", id: m.id, ok: false, error, step: label };
    }
    if (job.status === "running") job.proc?.send(reply);
    return;
  }
  if (m.ok) {
    job.result = m.value;
    return job.finish("done", `Done in ${seconds(Date.now() - job.started)}.`);
  }
  await fail(job, {
    message: m.error,
    location: locate(m.stack, file, WRAP_START.length),
    step: m.step ?? (job.lastFailedStep?.error === m.error ? job.lastFailedStep.label : undefined),
  });
}

/** The job failed (or timed out): note where the page was and what it looked like, then end it. */
async function fail(job: Job, failure: Failure, status: "failed" | "stopped" = "failed"): Promise<void> {
  if (job.status !== "running" || job.failing) return;
  job.failing = true;
  job.proc?.kill("SIGKILL");
  const opts = job.tab !== undefined ? { tab: job.tab } : {};
  try {
    failure.url = (await job.ctx.browser.state(job.sessionId, opts))?.url;
    if (failure.url) {
      const data = await job.ctx.browser.screenshot(job.sessionId, opts);
      const scope = await job.ctx.ops.fileOutputScope(job.ctx);
      const path = join(scope.scratchDir, "browser-run", `job-${job.id}-failed.png`);
      mkdirSync(join(scope.scratchDir, "browser-run"), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
      failure.screenshot = data;
      failure.screenshotPath = path;
    }
  } catch {
    // The tab may be gone; the failure stands without a picture.
  }
  job.failure = failure;
  const where = [failure.location ? `at script ${failure.location}` : "", failure.step ? `in ${failure.step}` : ""].filter(Boolean).join(" ");
  job.finish(status, `${status === "stopped" ? "Stopped" : "Failed"}${where ? ` ${where}` : ""}: ${failure.message}`);
}

async function pipeLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  } catch {}
  if (buf) onLine(buf);
}

/** What browser_run and browser_run_status return: the job's state and its lines since the last report. */
function report(job: Job): ToolResult {
  const elapsed = seconds(Date.now() - job.started);
  const state =
    job.status === "running"
      ? `running (${elapsed} so far; it stops after ${job.timeoutS}s)`
      : `${job.status} after ${elapsed}`;
  const head = [`Job ${job.id}${job.tab !== undefined ? ` on tab ${job.tab}` : ""}: ${state}.`];
  const from = Math.max(job.delivered, job.dropped);
  const fresh = job.lines.slice(from - job.dropped);
  const skipped = from - job.delivered + Math.max(0, fresh.length - MAX_REPORT_LINES);
  const shown = fresh.slice(-MAX_REPORT_LINES);
  if (shown.length) {
    head.push(`Log, lines ${job.total - shown.length + 1}–${job.total} of ${job.total}${skipped ? ` (${skipped} earlier new lines skipped)` : ""}:`);
    head.push(...shown.map(formatLine));
  } else {
    head.push(`No new log lines (${job.total} so far).`);
  }
  job.delivered = job.total;
  const content: ToolResultContent[] = [];
  if (job.status === "running") {
    head.push(`Call browser_run_status { job: ${job.id} } for the next lines (it waits up to ${RUN_DEFAULT_WAIT_S}s for them), or browser_run_stop { job: ${job.id} } if the log shows it going wrong.`);
  } else if (job.status === "done") {
    head.push(`Result: ${JSON.stringify(job.result) ?? "undefined"}`);
  } else if (job.failure) {
    const f = job.failure;
    head.push(
      `${job.status === "stopped" ? "Stopped" : "Failed"}: ${f.message}`,
      ...(f.location ? [`Where: script ${f.location}`] : []),
      ...(f.step ? [`Step: ${f.step}`] : []),
      ...(f.url ? [`Page: ${f.url}`] : []),
      ...(f.screenshotPath ? [`Screenshot of the page when it stopped (below), saved to ${f.screenshotPath}`] : []),
    );
  } else if (job.stopReason) {
    head.push(job.stopReason);
  }
  content.push({ type: "text", text: head.join("\n") });
  if (job.status !== "running" && job.failure?.screenshot) content.push({ type: "image", data: job.failure.screenshot, mimeType: "image/png" });
  return job.status === "failed" ? { content, isError: true } : { content };
}

const SCRIPT_API =
  "click(selector, { wait_for }), type(selector, text, { submit, wait_for }), wait(condition), evaluate(expressionOrFunction, { args, wait_for }) (runs in the page and returns the value), content(selector?, { format, max_chars, wait_for }), screenshot(path?, { wait_for }) (returns the saved path), open(url, { wait_for, device, width, height }), resize({ device, width, height }, { wait_for }), url(), log(...) and console.log/info/warn/error, sleep(ms)";

const WAIT_PARAM = {
  type: "number",
  minimum: 0,
  maximum: RUN_MAX_WAIT_S,
  description: `Seconds to wait before answering (default ${RUN_DEFAULT_WAIT_S}, at most ${RUN_MAX_WAIT_S}).`,
} as const;

const clampWait = (w: number | undefined) => Math.min(RUN_MAX_WAIT_S, Math.max(0, w ?? RUN_DEFAULT_WAIT_S)) * 1000;

export const browserRun = defineTool<{ script: string; tab?: number; timeout?: number; wait?: number }>({
  name: "browser_run",
  description:
    `Run a JavaScript script that drives a browser tab from outside the page, for flows that span reloads or loop: click, wait, click again, until done. It runs as a job in its own process: this call returns after wait seconds (or sooner when the script ends) with the job number and its log so far, and browser_run_status returns the next lines, so a long script never leaves you waiting blind. ` +
    `The script is async JS (top-level await; return a value to make it the job's result) with these functions: ${SCRIPT_API}. Every page call goes through the same browser tools, wait_for included, and throws when the tool fails (a wait timing out, no element matching). ` +
    `The log has the script's own console output, every step with its result, and the page's console, uncaught errors, navigations and failed requests. A failure reports the script line, the failing step, the page's URL and a screenshot. ` +
    `Example: while (await evaluate(() => document.querySelectorAll(".remove").length)) await click(".remove", { wait_for: { idle: true } }); ` +
    `One job runs per tab at a time; it stops at its timeout, when this run ends, or when its tab closes.`,
  inputSchema: schema(
    {
      script: { type: "string", minLength: 1, description: "The script's body (async JS; no import statements)." },
      tab: { type: "integer", minimum: 1, description: "Tab the script drives. Omitted: the lowest open tab (tab 1, created if there is none)." },
      timeout: { type: "number", minimum: 1, maximum: RUN_MAX_TIMEOUT_S, description: `Seconds before the job is stopped (default ${RUN_DEFAULT_TIMEOUT_S}, at most ${RUN_MAX_TIMEOUT_S}).` },
      wait: WAIT_PARAM,
    },
    ["script"],
  ),
  async run({ script, tab, timeout, wait }, ctx) {
    const pinned = tab ?? (await ctx.browser.state(ctx.session.id))?.tabId;
    const busy = runningOn(ctx.session.id, pinned);
    if (busy) return errorResult(`Job ${busy.id} is still running on tab ${pinned}. Read it with browser_run_status { job: ${busy.id} }, or stop it with browser_run_stop { job: ${busy.id} }.`);
    const job = new Job(nextJobId++, ctx, pinned, timeout ?? RUN_DEFAULT_TIMEOUT_S);
    jobs.set(job.id, job);
    prune(ctx.session.id);
    try {
      await start(job, script);
    } catch (e) {
      job.finish("failed", `Couldn't start the script: ${(e as Error).message}`);
      return errorResult(`Couldn't start the script: ${(e as Error).message}`);
    }
    await job.until(clampWait(wait), false);
    return report(job);
  },
});

function sessionJob(ctx: ToolContext, id: number): Job | string {
  const job = jobs.get(id);
  if (!job || job.sessionId !== ctx.session.id) {
    const mine = [...jobs.values()].filter((j) => j.sessionId === ctx.session.id).map((j) => `${j.id} (${j.status})`);
    return `No browser_run job ${id} in this session.${mine.length ? ` Jobs: ${mine.join(", ")}.` : ""}`;
  }
  return job;
}

export const browserRunStatus = defineTool<{ job: number; wait?: number }>({
  name: "browser_run_status",
  description: `A browser_run job's state and the log lines since you last looked. It waits up to wait seconds for a new line (or the job's end) before answering, so call it again until the job isn't running. A finished job gives its result, or for a failure the script line, the step, the URL and a screenshot.`,
  inputSchema: schema({ job: { type: "integer", minimum: 1, description: "The job number browser_run returned." }, wait: WAIT_PARAM }, ["job"]),
  async run({ job: id, wait }, ctx) {
    const job = sessionJob(ctx, id);
    if (typeof job === "string") return errorResult(job);
    await job.until(clampWait(wait), true);
    return report(job);
  },
});

export const browserRunStop = defineTool<{ job: number }>({
  name: "browser_run_stop",
  description: "Stop a running browser_run job (its process is killed) and get the rest of its log.",
  inputSchema: schema({ job: { type: "integer", minimum: 1, description: "The job number browser_run returned." } }, ["job"]),
  async run({ job: id }, ctx) {
    const job = sessionJob(ctx, id);
    if (typeof job === "string") return errorResult(job);
    if (job.status === "running") {
      job.stopReason = "Stopped by browser_run_stop.";
      job.finish("stopped", "Stopped by browser_run_stop.");
    }
    return report(job);
  },
});
