// Test doubles shared by service tests. Not imported by production code.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState, DriverInfo, ModelInfo } from "@harness/shared";
import type { Driver, DriverEvent, RunRequest } from "../drivers/types";
import { outputKey, watcherProject } from "../drivers/dummy";
import type { BrowserService } from "../browser/types";
import { ensureHome } from "../config";
import { openDb } from "../db";
import { Store } from "../store";
import { EventBus } from "../events";
import { Orchestrator, type OrchestratorOptions } from "../orchestrator/orchestrator";

export function tempHome(prefix = "harness-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function stubBrowser(): BrowserService & { closed: string[]; subs: Map<string, { onFrame: Function; onState: Function }> } {
  const states = new Map<string, BrowserState>();
  const subs = new Map<string, { onFrame: Function; onState: Function }>();
  const closed: string[] = [];
  return {
    closed,
    subs,
    async open(sessionId, url) {
      const s = { sessionId, url, title: url, loading: false };
      states.set(sessionId, s);
      for (const [k, v] of subs) if (k.startsWith(sessionId + "|")) v.onState(s);
      return s;
    },
    async state(sessionId) {
      return states.get(sessionId) ?? null;
    },
    async content() {
      return "page text";
    },
    async click() {},
    async type() {},
    async evaluate() {
      return "null";
    },
    async screenshot() {
      return "";
    },
    async input() {},
    async subscribe(sessionId, subscriberId, onFrame, onState) {
      subs.set(`${sessionId}|${subscriberId}`, { onFrame, onState });
    },
    async unsubscribe(sessionId, subscriberId) {
      subs.delete(`${sessionId}|${subscriberId}`);
    },
    async close(sessionId) {
      closed.push(sessionId);
    },
    async shutdown() {},
  };
}

export interface RecordedCall {
  runId: string;
  kind: RunRequest["kind"];
  prompt: string;
  state: unknown;
  cwd: string;
  mcpUrl: string;
  toolNames: string[];
  model: string | null;
  grants: RunRequest["grants"];
  permissionMode: RunRequest["permissionMode"];
}

/**
 * Scripted driver implementing the subset of the DESIGN.md dummy behaviour the
 * orchestrator tests need, calling HarnessOps directly (no tool layer).
 *
 * work directives: `/block <q>`, `/fail <msg>`, `/hold` (wait for release()/abort),
 * `/nosubmit` (end without submitting → auto-submit), `/throw <msg>`.
 * review: request_changes while `rejectsLeft > 0` or the prompt contains [dummy:reject].
 */
export class FakeDriver implements Driver {
  id: string;
  name = "Fake";
  description = "test driver";
  hasBuiltinTools = true;
  calls: RecordedCall[] = [];
  running = 0;
  maxRunning = 0;
  rejectsLeft = 0;
  /** Last tool requested via /tool, re-requested when a prompt says "Retry it now" */
  lastTool: { name: string; input: unknown } | null = null;
  approvals: { name: string; behavior: string }[] = [];
  private holds: (() => void)[] = [];
  /** What listModels() returns (or throws, when a function throws) */
  models: ModelInfo[] | (() => Promise<ModelInfo[]>) = [{ id: "fake-model", name: "Fake Model", default: true }];
  listModelsCalls = 0;
  /** Optional per-run override */
  script: ((req: RunRequest) => AsyncIterable<DriverEvent>) | null = null;

  constructor(id = "fake") {
    this.id = id;
  }

  async info(): Promise<DriverInfo> {
    return { id: this.id, name: this.name, description: this.description, available: true, authenticated: true, detail: "fake", supportsLogin: false };
  }

  async listModels(): Promise<ModelInfo[]> {
    this.listModelsCalls++;
    return typeof this.models === "function" ? this.models() : this.models;
  }

  /** Release every run currently waiting on /hold. */
  release() {
    const h = this.holds;
    this.holds = [];
    for (const r of h) r();
  }
  get holding() {
    return this.holds.length;
  }

  async *run(req: RunRequest): AsyncIterable<DriverEvent> {
    this.calls.push({
      runId: req.runId,
      kind: req.kind,
      prompt: req.prompt,
      state: req.state,
      cwd: req.cwd,
      mcpUrl: req.mcp.url,
      toolNames: req.tools.map((t) => t.name),
      model: req.model,
      grants: req.grants,
      permissionMode: req.permissionMode,
    });
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      if (this.script) {
        yield* this.script(req);
        return;
      }
      yield* this.behave(req);
    } finally {
      this.running--;
    }
  }

  private async *behave(req: RunRequest): AsyncGenerator<DriverEvent> {
    const ctx = req.toolContext;
    const ops = ctx.ops;
    const turns = ((req.state as { turns?: number } | null)?.turns ?? 0) + 1;
    const p = req.prompt;
    switch (req.kind) {
      case "plan": {
        yield { type: "text_delta", text: "Here's " };
        yield { type: "text", text: `Here's a plan for: ${p.split("\n")[0]}` };
        await ops.updatePlan(ctx, `1. Do ${p.split("\n")[0]}`);
        yield { type: "state", state: { turns } };
        return;
      }
      case "work": {
        if (p.includes("/hold")) {
          await new Promise<void>((resolve) => {
            this.holds.push(resolve);
            req.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (req.signal.aborted) return;
        }
        for (const w of ["Hello", " from", " fake"]) yield { type: "text_delta", text: w };
        yield { type: "text", text: `Hello from fake! You said: "${p}"` };
        yield { type: "state", state: { turns } };
        const tool = /\/tool (\S+) (\{.*\})/.exec(p);
        if (tool) this.lastTool = { name: tool[1]!, input: JSON.parse(tool[2]!) };
        if (tool || (p.includes("Retry it now") && this.lastTool)) {
          const r = await ops.requestApproval(ctx, this.lastTool!.name, this.lastTool!.input);
          this.approvals.push({ name: this.lastTool!.name, behavior: r.behavior });
          if (r.behavior === "deny") {
            yield { type: "text", text: `Denied: ${r.message}` };
            return;
          }
          yield { type: "text", text: "Tool ran." };
        }
        if (p.includes("/ask")) {
          yield { type: "text", text: "Should I use Postgres or MySQL? 🤔**" };
          return;
        }
        const block = /\/block (.+)/.exec(p);
        if (block) return void (await ops.block(ctx, block[1]!));
        const fail = /\/fail (.+)/.exec(p);
        if (fail) {
          yield { type: "error", message: fail[1]! };
          return;
        }
        const thrown = /\/throw (.+)/.exec(p);
        if (thrown) throw new Error(thrown[1]!);
        if (p.includes("/nosubmit")) return;
        await ops.postSummary(ctx, "Did the work.");
        await ops.submitForReview(ctx, "All done.");
        return;
      }
      case "review": {
        yield { type: "state", state: { reviewer: true } };
        if (this.rejectsLeft > 0 || p.includes("[dummy:reject]")) {
          if (this.rejectsLeft > 0) this.rejectsLeft--;
          await ops.reviewDecision(ctx, "request_changes", "Please fix X");
        } else {
          await ops.reviewDecision(ctx, "approve", "LGTM");
        }
        return;
      }
      case "chat": {
        yield { type: "text", text: `Chatting about: ${p}?` };
        yield { type: "state", state: { turns } };
        return;
      }
      case "complete": {
        yield { type: "text", text: "Finalized." };
        await ops.postSummary(ctx, "Completed.");
        return;
      }
      case "conductor": {
        const state = (req.state as { turns?: number; created?: boolean } | null) ?? {};
        if (!state.created) {
          const bullets = p
            .split("\n")
            .filter((l) => l.startsWith("- "))
            .map((l) => l.slice(2).trim());
          const specs = bullets.length ? bullets.map((b) => ({ title: b, deps: [] as number[] })) : [
            { title: "First child", deps: [] },
            { title: "Second child", deps: [0] },
          ];
          const keys: string[] = [];
          for (const s of specs) {
            const t = await ops.createTicket(ctx, { title: s.title, description: s.title, dependsOn: s.deps.map((i) => keys[i]!) });
            keys.push(t.key);
          }
          yield { type: "state", state: { turns, created: true } };
          return;
        }
        yield { type: "state", state: { ...state, turns } };
        const children = (await ops.listTickets(ctx, { scope: "children", limit: 200 })).tickets;
        for (const c of children) {
          if (c.status === "review" && c.agentReview === "approved" && c.humanReview === "pending") {
            await ops.reviewTicket(ctx, c.key, "approve", "ok");
          }
        }
        for (const c of (await ops.listTickets(ctx, { scope: "children", limit: 200 })).tickets) {
          if (c.status === "review" && c.agentReview === "approved" && c.humanReview === "approved" && !c.busy) {
            await ops.completeTicket(ctx, c.key);
          }
        }
        const after = (await ops.listTickets(ctx, { scope: "children", limit: 200 })).tickets;
        if (after.length && after.every((c) => c.status === "done")) await ops.submitForReview(ctx, "All children done.");
        return;
      }
      case "triage": {
        const suggested = watcherProject(p);
        const key = outputKey(p);
        if (p.includes("[unscoped]") || !suggested) {
          await ops.declineWork(ctx, "No project for this item");
          return;
        }
        await ops.dispatchTicket(ctx, {
          projectKey: suggested,
          key,
          url: /https?:\/\/[^\s"`]+/.exec(p)?.[0],
          title: `Work for ${key}`,
          description: `Handle ${key}`,
          start: true,
          conductor: p.includes("[big]"),
        });
        return;
      }
    }
  }
}

/** Build an orchestrator on an in-memory DB with a temp HARNESS_HOME. */
export function makeOrchestrator(opts: Partial<OrchestratorOptions> & { driver?: FakeDriver; dbPath?: string } = {}) {
  const home = opts.paths?.home ?? tempHome();
  const paths = ensureHome(home);
  const store = opts.store ?? new Store(openDb(opts.dbPath ?? ":memory:"));
  const bus = opts.bus ?? new EventBus();
  const driver = opts.driver ?? new FakeDriver();
  const browser = opts.browser ?? stubBrowser();
  const orch = new Orchestrator({
    store,
    bus,
    drivers: opts.drivers ?? [driver],
    browser,
    paths,
    tools: opts.tools ?? (() => []),
    baseUrl: opts.baseUrl ?? (() => "http://127.0.0.1:9"),
    watchers: opts.watchers === undefined ? null : opts.watchers,
    log: opts.log ?? (() => {}),
    modelCatalog: opts.modelCatalog,
    // Tests never reach a real classifier: auto mode asks a human unless one is injected.
    classifier: opts.classifier === undefined ? null : opts.classifier,
    autoModeRules: opts.autoModeRules,
    classifierTimeoutMs: opts.classifierTimeoutMs,
  });
  store.settings.set({ defaultDriver: driver.id });
  return { orch, store, bus, driver, browser, paths, home };
}
