import type { DriverInfo, ModelInfo } from "@harness/shared";
import { executeTool, type Driver, type DriverEvent, type RunRequest } from "../../service/src/drivers/types";

/** A latch the test opens when it wants a scripted run to go on. */
export interface Gate {
  readonly opened: boolean;
  open(): void;
  wait(signal: AbortSignal): Promise<void>;
}

export function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  let opened = false;
  return {
    get opened() {
      return opened;
    },
    open() {
      opened = true;
      open();
    },
    wait(signal) {
      if (signal.aborted) return Promise.reject(abortError());
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        void promise.then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
    },
  };
}

function abortError(): Error {
  const err = new Error("Run aborted");
  err.name = "AbortError";
  return err;
}

/**
 * One step of a scripted run: a driver event to emit, a gate to wait on (an abort while waiting
 * throws AbortError, the way the real drivers do), a function to run (to read the request or
 * poke the service mid-run), or an error to throw.
 */
export type Step = DriverEvent | { wait: Gate } | { event: (req: RunRequest) => DriverEvent | Promise<DriverEvent> } | { run: (req: RunRequest) => void | Promise<void> } | { throw: Error };

export type Script = Step[] | ((req: RunRequest) => Step[]);

/**
 * What claude-code emits for a turn that answers once (drivers/claude-code.ts: `state` when the
 * CLI reports its session, `call` then `text` for the model's reply, `usage` and the final
 * `state` when the result arrives). A script that sends events in an order no real driver sends
 * would pass orchestrator tests for the wrong reason, so the defaults follow it.
 */
export function replyScript(text: string, opts: { sessionId?: string } = {}): Step[] {
  const sessionId = opts.sessionId ?? "fake-session";
  return [
    { type: "state", state: { sessionId, costUsd: 0 } },
    { type: "call", call: { input: 10, cacheRead: 0, cacheWrite: 100, output: 5 } },
    { type: "text", text },
    { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    { type: "state", state: { sessionId, costUsd: 0.01 } },
  ];
}

/** A reply whose model call read `prefix` tokens, as a long conversation's does. */
export function bigReplyScript(text: string, prefix = 150_000): Step[] {
  return replyScript(text).map((s) => ("type" in s && s.type === "call" ? { type: "call", call: { input: 10, cacheRead: prefix - 10, cacheWrite: 0, output: 5 } } : s));
}

/** A run that reports an error then fails, as claude-code does when the CLI exits non-zero. */
export function failScript(message: string): Step[] {
  return [{ type: "error", message }, { throw: new Error(message) }];
}

export interface FakeDriverOptions {
  id?: string;
  /** Takes human messages mid-run through RunRequest.input */
  supportsSteering?: boolean;
  /** Asks permission through the harness's permission_prompt tool, as claude-code does */
  usesPermissionPromptTool?: boolean;
  /** Prompt-cache lifetime the driver declares (Driver.cacheTtlMs); unset: sessions never expire */
  cacheTtlMs?: number;
  /** The driver's sub-agent tool (Driver.subagentTool) */
  subagentTool?: string;
  /** Scripts for the runs, in order; later runs get the default reply */
  scripts?: Script[];
}

/**
 * A Driver the test scripts. Every run records its request and takes the next queued script (or
 * answers "ok"). `runStarted(n)` resolves once the nth run has begun, so a test waits on the run
 * itself, never a timer.
 */
export class FakeDriver implements Driver {
  readonly id: string;
  readonly name = "Fake";
  readonly description = "A scripted test driver";
  readonly hasBuiltinTools = true;
  readonly supportsSteering: boolean;
  readonly usesPermissionPromptTool: boolean;
  readonly cacheTtlMs?: number;
  readonly subagentTool?: string;
  readonly requests: RunRequest[] = [];
  private scripts: Script[];
  private waiters: { n: number; resolve: (req: RunRequest) => void }[] = [];
  /** Aborts seen: the run ids whose signal was aborted while the run was going */
  readonly aborted: string[] = [];

  constructor(opts: FakeDriverOptions = {}) {
    this.id = opts.id ?? "fake";
    this.supportsSteering = opts.supportsSteering ?? false;
    this.usesPermissionPromptTool = opts.usesPermissionPromptTool ?? false;
    this.cacheTtlMs = opts.cacheTtlMs;
    this.subagentTool = opts.subagentTool;
    this.scripts = [...(opts.scripts ?? [])];
  }

  /** Queue scripts for the next runs. */
  script(...scripts: Script[]) {
    this.scripts.push(...scripts);
  }

  /** The nth (1-based) run's request, once that run has started. */
  runStarted(n = 1): Promise<RunRequest> {
    const hit = this.requests[n - 1];
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => this.waiters.push({ n, resolve }));
  }

  async info(): Promise<DriverInfo> {
    return { id: this.id, name: this.name, description: this.description, available: true, authenticated: true } as unknown as DriverInfo;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: "fake-model", name: "Fake Model", description: "", default: true }];
  }

  async *run(req: RunRequest): AsyncIterable<DriverEvent> {
    this.requests.push(req);
    for (const w of this.waiters.filter((w) => w.n <= this.requests.length)) w.resolve(this.requests[w.n - 1]!);
    this.waiters = this.waiters.filter((w) => w.n > this.requests.length);
    req.signal.addEventListener("abort", () => this.aborted.push(req.runId), { once: true });
    const script = this.scripts.shift() ?? replyScript("ok");
    for (const step of typeof script === "function" ? script(req) : script) {
      if (req.signal.aborted) throw abortError();
      if ("wait" in step) await step.wait.wait(req.signal);
      else if ("event" in step) yield await step.event(req);
      else if ("run" in step) await step.run(req);
      else if ("throw" in step) throw step.throw;
      else yield step;
    }
  }
}

/**
 * What a native-loop agent does to call one of the run's tools: the `tool_call` event, the tool run
 * for real through the run's own tool list and context (so it reaches the orchestrator exactly as
 * an agent's call would), then the `tool_result` event. `then` sees the result.
 */
export function toolCall(name: string, input: unknown, then?: (result: Awaited<ReturnType<typeof executeTool>>) => void): Step[] {
  const callId = `call-${name}`;
  let result: Awaited<ReturnType<typeof executeTool>>;
  return [
    { type: "tool_call", callId, name, input },
    {
      run: async (req) => {
        result = await executeTool(req.tools, name, input, req.toolContext);
        then?.(result);
      },
    },
    { event: () => ({ type: "tool_result", callId, name, result }) },
  ];
}
