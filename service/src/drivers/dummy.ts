// Dummy driver: deterministic, no network. Follows the "Dummy driver script" in DESIGN.md.
// Tools are called through executeTool, exactly like a real native-loop driver would.

import type { DriverInfo, ModelInfo } from "@harness/shared";
import type { ToolResult } from "../tools/types";
import { executeTool, type Driver, type DriverEvent, type RunRequest } from "./types";

export interface DummyState {
  turns: number;
  /** Conductor runs: keys of the children created on the first run */
  children?: string[];
  /** Model of the latest run (as resolved by the orchestrator) */
  model?: string;
  /** `/tools` calls not yet done: the first one failed (e.g. awaiting approval); retried on "Retry it now" */
  pendingCalls?: { name: string; input: Record<string, unknown> }[];
}

/**
 * The dummy "models" differ only in streaming speed. dummy-fast is the default (null model);
 * dummy-slow streams DUMMY_SLOW_FACTOR× slower, handy for watching live deltas / cancelling.
 * Any other model id fails the run, the way a real API rejects an unknown model.
 */
export const DUMMY_MODELS: ModelInfo[] = [
  { id: "dummy-fast", name: "Dummy Fast", description: "Streams at the normal dummy speed", default: true },
  { id: "dummy-slow", name: "Dummy Slow", description: "Streams 10× slower (at least 50 ms per word)" },
];
export const DUMMY_SLOW_FACTOR = 10;
const DUMMY_SLOW_MIN_MS = 50;

export interface DummyDriverOptions {
  /** Per-word streaming delay; default HARNESS_DUMMY_DELAY_MS or 15 */
  delayMs?: number;
}

function abortError(): Error {
  const err = new Error("Run aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function resultText(result: ToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
}

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/** Body of a `## <title…>` section of a prompt, up to the next `## ` heading. */
function promptSection(prompt: string, title: string): string {
  const start = prompt.indexOf(`\n## ${title}`);
  if (start < 0) return "";
  const body = prompt.slice(prompt.indexOf("\n", start + 1) + 1);
  const end = body.search(/^## /m);
  return end < 0 ? body : body.slice(0, end);
}

/** The watcher's output from a triage prompt, without its fence. */
function watcherOutput(prompt: string): string {
  const start = prompt.indexOf("\n## Output");
  if (start < 0) return "";
  const rest = prompt.slice(prompt.indexOf("\n", start + 1) + 1);
  const fence = rest.match(/^`{3,}/)?.[0];
  if (!fence) return "";
  const body = rest.slice(fence.length + 1);
  const end = body.indexOf(`\n${fence}`);
  return end < 0 ? body : body.slice(0, end);
}

/** The `[dummy:project KEY]` a watcher's prompt names, if any. Only the watcher's prompt counts. */
export function watcherProject(prompt: string): string | null {
  return promptSection(prompt, "What the human wants").match(/\[dummy:project ([A-Za-z0-9_]+)\]/)?.[1] ?? null;
}

/** The first external key (FOO-123) in the watcher's output: the key a dispatch mirrors. */
export function outputKey(prompt: string): string | undefined {
  return watcherOutput(prompt).match(/\b[A-Z][A-Z0-9_]*-\d+\b/)?.[0];
}

/** A `[dummy:dispatch-if /re/flags]` rule from the watcher's prompt. */
function watcherRule(prompt: string): RegExp | null {
  const wants = promptSection(prompt, "What the human wants");
  const m = wants.match(/\[dummy:dispatch-if \/(.+?)\/([a-z]*)\]/);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]);
  } catch {
    return null;
  }
}

const DIRECTIVE =/(?:^|\s)\/(block|fail|browse|bash|approve|tools|agents|child)\b[ \t]*([^\n]*)/;
/** conductorUpdatePrompt: the orchestrator telling a parent (of either kind) that children changed. */
const CHILD_UPDATES = /^(Child ticket updates:|Check on your children)/;

interface ChildView {
  key: string;
  status: string;
  agentReview: string;
  humanReview: string;
}

export class DummyDriver implements Driver {
  readonly id = "dummy";
  readonly name = "Dummy";
  readonly description = "Deterministic scripted agent for tests and quick manual checks. No network, no model.";
  readonly hasBuiltinTools = false;
  /** Gets permission_prompt so `/approve` can exercise the approval flow like claude-code does. */
  readonly usesPermissionPromptTool = true;

  constructor(private readonly opts: DummyDriverOptions = {}) {}

  private get delay(): number {
    if (this.opts.delayMs !== undefined) return this.opts.delayMs;
    const raw = process.env.HARNESS_DUMMY_DELAY_MS;
    const env = raw ? Number(raw) : NaN;
    return Number.isFinite(env) && env >= 0 ? env : 15;
  }

  async info(): Promise<DriverInfo> {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      available: true,
      authenticated: true,
      detail: "Scripted responses",
      supportsLogin: false,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return DUMMY_MODELS.map((m) => ({ ...m }));
  }

  /** Per-word delay for a model; throws for a model the dummy doesn't have. */
  delayFor(model: string | null): number {
    const id = model ?? "dummy-fast";
    if (!DUMMY_MODELS.some((m) => m.id === id)) throw new Error(`Unknown dummy model: ${id} (use ${DUMMY_MODELS.map((m) => m.id).join(" or ")})`);
    return id === "dummy-slow" ? Math.max(this.delay * DUMMY_SLOW_FACTOR, DUMMY_SLOW_MIN_MS) : this.delay;
  }

  async *run(req: RunRequest): AsyncGenerator<DriverEvent> {
    let delay: number;
    try {
      delay = this.delayFor(req.model);
    } catch (err) {
      const message = (err as Error).message;
      yield { type: "error", message };
      throw err;
    }
    const prev = (req.state ?? {}) as Partial<DummyState>;
    const state: DummyState = { turns: (typeof prev.turns === "number" ? prev.turns : 0) + 1 };
    if (req.model) state.model = req.model;
    if (Array.isArray(prev.children)) state.children = [...prev.children];
    let callSeq = 0;

    const check = () => {
      if (req.signal.aborted) throw abortError();
    };

    async function* say(text: string): AsyncGenerator<DriverEvent> {
      const words = text.split(/(\s+)/).filter((w) => w !== "");
      for (const word of words) {
        check();
        yield { type: "text_delta", text: word };
        if (/\S/.test(word)) await sleep(delay, req.signal);
      }
      check();
      yield { type: "text", text };
    }

    // Returns the tool result via the holder so callers can inspect it.
    async function* call(name: string, input: Record<string, unknown>, out?: { result?: ToolResult }): AsyncGenerator<DriverEvent> {
      check();
      const callId = `dummy_${req.runId}_${++callSeq}`;
      yield { type: "tool_call", callId, name, input };
      const result = await executeTool(req.tools, name, input, req.toolContext);
      if (out) out.result = result;
      yield { type: "tool_result", callId, name, result };
    }

    const hasTool = (name: string) => req.tools.some((t) => t.name === name);

    // `/tools [{"name":…,"input":{…}},…]`: call harness tools in order. The first error stops
    // the run with the rest kept in state; a later "Retry it now" prompt (an answered approval)
    // repeats the failed call with the same input, like an agent told to retry.
    async function* runCalls(calls: { name: string; input: Record<string, unknown> }[]): AsyncGenerator<DriverEvent> {
      for (let i = 0; i < calls.length; i++) {
        const out: { result?: ToolResult } = {};
        yield* call(calls[i]!.name, calls[i]!.input ?? {}, out);
        if (!out.result || out.result.isError) {
          state.pendingCalls = calls.slice(i);
          return;
        }
      }
      yield* say(`Ran ${calls.map((c) => c.name).join(", ")}.`);
      yield* call("submit_for_review", { summary: `Ran ${calls.length} tool call${calls.length === 1 ? "" : "s"}.` });
    }
    // A later conductor run, or a work run on a task ticket with children: approve and complete
    // children whose agent review passed, and submit once every child is done.
    async function* steerChildren(): AsyncGenerator<DriverEvent> {
      const out: { result?: ToolResult } = {};
      yield* call("list_tickets", { scope: "children", limit: 200 }, out);
      let children: ChildView[] = [];
      try {
        const parsed = out.result && !out.result.isError ? JSON.parse(resultText(out.result)) : [];
        if (Array.isArray(parsed)) children = parsed;
      } catch {
        children = [];
      }
      let acted = 0;
      for (const child of children) {
        if (child.status !== "review" || (child.agentReview !== "approved" && child.agentReview !== "skipped")) continue;
        if (child.humanReview === "pending") {
          yield* call("review_ticket", { key: child.key, decision: "approve", notes: "Approved by the dummy conductor." });
          yield* call("complete_ticket", { key: child.key });
          acted++;
        } else if (child.humanReview === "approved") {
          yield* call("complete_ticket", { key: child.key });
          acted++;
        }
      }
      if (children.length > 0 && children.every((c) => c.status === "done")) {
        yield* say("All child tickets are done.");
        yield* call("submit_for_review", { summary: `All ${children.length} child tickets are done.` });
      } else {
        yield* say(acted ? `Handled ${acted} child ticket${acted === 1 ? "" : "s"}; waiting on the rest.` : "Waiting on child tickets.");
      }
    }
    // `/agents [n]`: run n sub-agents (DESIGN.md "Sub-agents"), the way claude-code reports its
    // Agent tool: the call, a "subagent" event, the sub-agent's own tagged output, its result.
    // From three on, the last one is started by the one before it (a nested agent).
    async function* subagent(n: number, parentId: string | null, inner?: () => AsyncGenerator<DriverEvent>): AsyncGenerator<DriverEvent> {
      check();
      const id = `dummy_agent_${req.runId}_${n}`;
      const description = `Sub-task ${n}`;
      const input = { description, subagent_type: "general-purpose", prompt: `Look into sub-task ${n} and report back.` };
      const from = parentId ? { subagentId: parentId } : {};
      yield { type: "tool_call", callId: id, name: "Agent", input, ...from };
      yield { type: "subagent", subagent: { id, parentId, description, agentType: "general-purpose", prompt: input.prompt, status: "running" } };
      await sleep(delay * 10, req.signal);
      yield { type: "text", text: `Looking into sub-task ${n}.`, subagentId: id };
      const readId = `${id}_read`;
      yield { type: "tool_call", callId: readId, name: "Read", input: { file_path: "README.md" }, subagentId: id };
      await sleep(delay * 10, req.signal);
      yield { type: "tool_result", callId: readId, name: "Read", result: { content: [{ type: "text", text: `(dummy) notes for sub-task ${n}` }] }, subagentId: id };
      if (inner) yield* inner();
      const report = `Sub-task ${n} is done.`;
      yield { type: "text", text: report, subagentId: id };
      check();
      yield { type: "tool_result", callId: id, name: "Agent", result: { content: [{ type: "text", text: report }] }, ...from };
      yield { type: "subagent", subagent: { id, status: "succeeded", result: report } };
    }

    const prompt = req.prompt;

    switch (req.kind) {
      case "plan": {
        const subject = firstLine(prompt) || "this ticket";
        const plan = [
          `Here's a plan for: ${subject}`,
          "",
          "1. Read the relevant code and confirm the current behaviour.",
          "2. Make the change in small, testable steps.",
          "3. Run the tests and check the result.",
          "4. Submit the work for review.",
          "",
          "| Step | Check | Risk |",
          "|:-----|:------|:----:|",
          "| Change | `bun run test` | low |",
          "| Review | The reviewer agent reads the diff against the ticket, then approves it or asks for changes | **medium** |",
        ].join("\n");
        yield* say(plan);
        yield* call("update_plan", { plan });
        break;
      }

      case "work": {
        yield* say(`Hello from the dummy driver! You said: "${prompt}"`);
        const m = prompt.match(DIRECTIVE);
        const directive = m?.[1];
        const arg = (m?.[2] ?? "").trim();
        if (!directive && CHILD_UPDATES.test(prompt)) {
          yield* steerChildren();
        } else if (directive === "child") {
          // `/child <title>`: a child of this task ticket, which then conducts it (no submit yet).
          const title = arg || "Child task";
          yield* call("create_ticket", { title, description: `Dummy child ticket: ${title}`, child: true });
          yield* say(`Created a child ticket for "${title}"; I'll review and complete it when it's ready.`);
        } else if (directive === "block") {
          yield* call("block", { question: arg || "The dummy driver needs input." });
        } else if (directive === "approve") {
          // `/approve <tool> [json input]`: ask for permission the way the claude-code CLI does.
          const [, tool = "Bash", rawInput = ""] = arg.match(/^(\S+)?\s*(.*)$/s) ?? [];
          let toolInput: unknown = {};
          if (rawInput.trim()) {
            try {
              toolInput = JSON.parse(rawInput);
            } catch {
              toolInput = { command: rawInput.trim() };
            }
          }
          const out: { result?: ToolResult } = {};
          yield* call("permission_prompt", { tool_name: tool, input: toolInput, tool_use_id: `dummy_tool_${req.runId}` }, out);
          let decision: { behavior?: string; message?: string } = {};
          try {
            decision = JSON.parse(out.result ? resultText(out.result) : "{}");
          } catch {
            decision = {};
          }
          if (decision.behavior === "allow") {
            yield* say(`Approved ${tool}`);
            yield* call("submit_for_review", { summary: `Ran ${tool} after approval.` });
          }
          // Denied (or no answer): stop here, like a real agent told to wait for the human.
        } else if (directive === "tools") {
          let calls: { name: string; input: Record<string, unknown> }[] = [];
          try {
            const parsed = JSON.parse(arg);
            if (Array.isArray(parsed)) calls = parsed.filter((c) => c && typeof c.name === "string");
          } catch {}
          if (calls.length) yield* runCalls(calls);
          else yield* say("The /tools directive needs a JSON array of {name, input}.");
        } else if (!directive && prev.pendingCalls?.length && prompt.includes("Retry it now")) {
          yield* runCalls(prev.pendingCalls);
        } else if (directive === "fail") {
          const message = arg || "Dummy failure";
          yield { type: "error", message };
          throw new Error(message);
        } else if (directive === "browse") {
          yield* call("browser_open", { url: arg });
          const out: { result?: ToolResult } = {};
          yield* call("browser_content", { format: "text", max_chars: 2000 }, out);
          const text = out.result ? resultText(out.result) : "";
          yield* say(out.result?.isError ? `Could not read ${arg}: ${text}` : `Page content: ${text.slice(0, 500)}`);
        } else if (directive === "agents") {
          const count = Math.min(5, Math.max(1, Number.parseInt(arg, 10) || 2));
          const nestLast = count >= 3;
          for (let n = 1; n <= count - (nestLast ? 1 : 0); n++) {
            const parent = `dummy_agent_${req.runId}_${n}`;
            yield* subagent(n, null, nestLast && n === count - 1 ? () => subagent(count, parent) : undefined);
          }
          yield* say(`The ${count} sub-agent${count === 1 ? "" : "s"} finished.`);
          yield* call("submit_for_review", { summary: `Ran ${count} sub-agent${count === 1 ? "" : "s"}.` });
        } else if (directive === "bash") {
          if (hasTool("bash")) {
            const out: { result?: ToolResult } = {};
            yield* call("bash", { command: arg }, out);
            yield* say(`Command output:\n${out.result ? resultText(out.result) : ""}`);
          } else {
            yield* say("The bash tool is not available in this run.");
          }
        } else {
          yield* call("post_summary", { summary: `Dummy work done for: ${firstLine(prompt) || "(empty prompt)"}` });
          yield* call("submit_for_review", { summary: "The dummy driver finished the work." });
        }
        break;
      }

      case "review": {
        const reject = prompt.includes("[dummy:reject]");
        yield* say(reject ? "Reviewing the work: changes are needed." : "Reviewing the work: it looks good.");
        yield* call(
          "review_decision",
          reject
            ? { decision: "request_changes", notes: "The dummy reviewer was asked to reject this ([dummy:reject])." }
            : { decision: "approve", notes: "The dummy reviewer approves." },
        );
        break;
      }

      case "chat": {
        // The human's words, without the harness note a blocked ticket's message carries.
        const said = prompt.split("\n\n[Harness note:")[0] ?? prompt;
        yield* say(`(dummy chat) You said: "${said}"`);
        // [dummy:unblock] picks the work back up; [dummy:submit] / [dummy:block] then move the
        // ticket on, the way a real agent does once it's done or needs the human again.
        if (said.includes("[dummy:unblock]")) yield* call("unblock", { note: "The dummy's question was answered." });
        if (said.includes("[dummy:block]")) yield* call("block", { question: "The dummy needs another answer. What next?" });
        else if (said.includes("[dummy:submit]")) yield* call("submit_for_review", { summary: "The dummy finished the work from a message." });
        break;
      }

      case "complete": {
        yield* say("Finalizing the ticket.");
        // A pull request completion only finishes once one is recorded; the dummy makes one up.
        const t = req.toolContext.ticket;
        if (t?.completionAction === "pr") {
          yield* call("record_pull_request", { url: t.pullRequestUrl ?? `https://github.com/example/dummy/pull/${t.key.split("-").pop()}` });
        }
        yield* call("post_summary", { summary: "Completed." });
        break;
      }

      case "conductor": {
        if (!state.children) {
          const bullets = [...prompt.matchAll(/^[ \t]*- (.+)$/gm)].map((b) => b[1]!.trim()).filter(Boolean);
          const specs: { title: string; dependsOnIndex?: number }[] = bullets.length
            ? bullets.map((title) => ({ title }))
            : [{ title: "Part 1" }, { title: "Part 2", dependsOnIndex: 0 }];
          yield* say(`Splitting the work into ${specs.length} child ticket${specs.length === 1 ? "" : "s"}.`);
          const keys: string[] = [];
          for (const spec of specs) {
            const input: Record<string, unknown> = { title: spec.title, description: `Dummy child ticket: ${spec.title}` };
            const dep = spec.dependsOnIndex !== undefined ? keys[spec.dependsOnIndex] : undefined;
            if (dep) input.depends_on = [dep];
            const out: { result?: ToolResult } = {};
            yield* call("create_ticket", input, out);
            const key = out.result && !out.result.isError ? resultText(out.result).match(/^Created (\S+?)\./)?.[1] : undefined;
            if (key) keys.push(key);
          }
          state.children = keys;
        } else {
          yield* steerChildren();
        }
        break;
      }

      case "triage": {
        // The watcher's prompt names the project (`[dummy:project KEY]`); the output can't. The
        // first external key in the output is the key to mirror.
        const project = watcherProject(prompt);
        const key = outputKey(prompt);
        const title = prompt.match(/^Inbox title:[ \t]*"(.+)"$/m)?.[1]?.trim() || firstLine(prompt) || "Untitled work item";
        // A watcher prompt can also carry a rule: `[dummy:dispatch-if /regex/flags]`. Only the
        // watcher's prompt sets it and only the output is matched.
        const rule = watcherRule(prompt);
        if (rule) {
          if (!rule.test(watcherOutput(prompt))) {
            yield* say("This output doesn't match the watcher's rule.");
            yield* call("decline_work", { reason: "The output doesn't match the watcher's prompt.", title });
          } else if (!project) {
            yield* say("The output matches, but no project is named.");
            yield* call("decline_work", { reason: "No project for this output.", title });
          } else {
            yield* say(`Dispatching to ${project}.`);
            const input: Record<string, unknown> = { project_key: project, title, description: `Dispatched by the dummy triager.\n\n${title}`, start: true };
            if (key) input.key = key;
            yield* call("dispatch_ticket", input);
          }
        } else if (prompt.includes("[unscoped]")) {
          yield* say("This item is not scoped well enough to work on.");
          yield* call("decline_work", { reason: "The item is marked [unscoped]." });
        } else if (!project) {
          yield* say("No project matches this item.");
          yield* call("decline_work", { reason: "The watcher's prompt names no project for this output." });
        } else {
          const big = prompt.includes("[big]");
          yield* say(`Dispatching to ${project}${big ? " as a conductor ticket" : ""}.`);
          const input: Record<string, unknown> = { project_key: project, title, description: `Dispatched by the dummy triager.\n\n${title}` };
          if (key) input.key = key;
          input.start = true;
          if (big) input.conductor = true;
          yield* call("dispatch_ticket", input);
        }
        break;
      }
    }

    check();
    yield { type: "state", state };
  }
}
