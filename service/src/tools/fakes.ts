// Test doubles for tool and driver tests: a recording HarnessOps, a recording
// BrowserService, and a ToolContext builder. Not used at runtime.

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState, RunKind, Session, Ticket } from "@harness/shared";
import type { BrowserService } from "../browser/types";
import type { BoardListFilter, HarnessOps, ToolContext } from "./types";

export function fakeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t_1",
    key: "TEST-1",
    projectId: "p_1",
    kind: "task",
    title: "A ticket",
    description: "Do the thing",
    status: "in_progress",
    sessionId: "s_1",
    driver: "dummy",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    blockedReason: null,
    permissionMode: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    model: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s_1",
    key: "TEST-1",
    kind: "ticket",
    ticketId: "t_1",
    driver: "dummy",
    cwd: "/tmp",
    title: "",
    triageStatus: null,
    outcome: null,
    busy: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export interface RecordedCall {
  method: string;
  args: unknown[];
}

type OpsImpl = { [K in keyof HarnessOps]?: (...args: any[]) => any };

/**
 * HarnessOps that records every call (minus the ctx argument). Behaviour can be
 * overridden per method; defaults return plausible values. Children created with
 * createTicket are remembered and served by listTickets / getTicket (project "TEST").
 */
export function fakeOps(overrides: OpsImpl = {}): HarnessOps & { calls: RecordedCall[]; children: Ticket[] } {
  const calls: RecordedCall[] = [];
  const children: Ticket[] = [];
  let seq = 1;
  const find = (key: string) => {
    const t = children.find((c) => c.key === key);
    if (!t) throw new Error(`No ticket ${key}`);
    return t;
  };
  const defaults: Required<OpsImpl> = {
    postSummary: async () => {},
    updatePlan: async () => {},
    block: async () => {},
    unblock: async () => {},
    resumeWork: async () => {},
    submitForReview: async () => {},
    updateBranch: async () => "Branch updated.",
    reviewDecision: async () => {},
    createTicket: async (_ctx: ToolContext, input: { title: string; description: string; dependsOn?: string[]; autoStart?: boolean }) => {
      seq++;
      const t = fakeTicket({
        id: `t_${seq}`,
        key: `TEST-${seq}`,
        title: input.title,
        description: input.description,
        dependsOn: input.dependsOn ?? [],
        autoStart: input.autoStart ?? true,
        status: "planning",
        parentId: "t_1",
      });
      children.push(t);
      return t;
    },
    listTickets: async (_ctx: ToolContext, filter: BoardListFilter) => ({
      tickets: children.slice(0, filter.limit ?? children.length).map((t) => ({ ...t, projectKey: "TEST" })),
      total: children.length,
      scope: filter.scope ?? "children",
    }),
    getTicket: async (_ctx: ToolContext, key: string) => ({
      ticket: { ...find(key), projectKey: "TEST" },
      relatedTickets: [],
      resolvedFrom: null,
      parent: "TEST-1",
      children: [],
      base: { branch: "main", source: "settings" },
      summaries: [{ author: "agent", body: "did it", createdAt: 1 }],
    }),
    searchTickets: async () => ({ hits: [], nextCursor: null, total: 0 }),
    updateTicket: async (_ctx: ToolContext, key: string, patch: Record<string, unknown>) =>
      Object.assign(find(key), Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))),
    moveTicket: async (_ctx: ToolContext, key: string, status: Ticket["status"]) => Object.assign(find(key), { status }),
    startTicket: async (_ctx: ToolContext, key: string) => ({ ...find(key), status: "in_progress" }),
    messageTicket: async () => {},
    cancelTicket: async (_ctx: ToolContext, key: string) => find(key),
    reopenTicket: async (_ctx: ToolContext, key: string) => Object.assign(find(key), { status: "in_progress" }),
    reviewTicket: async (_ctx: ToolContext, key: string, decision: string) => ({
      ...find(key),
      humanReview: decision === "approve" ? "approved" : "changes_requested",
    }),
    completeTicket: async (_ctx: ToolContext, key: string) => find(key),
    recordPullRequest: async (_ctx: ToolContext, url: string) => `Recorded ${url}.`,
    listProjects: async () => [{ key: "WEB", name: "Website", path: "/code/web" }],
    listInbox: async () => ({ items: [], total: 0 }),
    dispatchTicket: async (_ctx: ToolContext, input: { key?: string; conductor?: boolean; start?: boolean; title: string }) =>
      fakeTicket({ key: input.key ?? "WEB-1", kind: input.conductor ? "conductor" : "task", status: input.start ? "in_progress" : "planning", title: input.title }),
    declineWork: async () => {},
    requestApproval: async (_ctx: ToolContext, _tool: string, input: unknown) => ({ behavior: "allow", updatedInput: input }),
    checkPermission: async () => ({ behavior: "allow" }),
    fileOutputScope: async (ctx: ToolContext) => ({ scratchDir: join(tmpdir(), "harness-fake-scratch", ctx.session.id), readOnly: false }),
    listWatchers: async () => [],
    getSettings: async () => ({}),
    listPrompts: async () => [],
    listDrivers: async () => [],
    createWatcher: async (_ctx: ToolContext, input: Record<string, unknown>, dryRun?: boolean) =>
      dryRun ? null : { id: "w_1", args: [], cwd: null, env: {}, mode: "loop", intervalSec: 60, enabled: true, driver: null, lastRunAt: null, lastError: null, ...input },
    updateWatcher: async () => null,
    deleteWatcher: async (_ctx: ToolContext, ref: string) => ({ id: ref, name: ref }),
    runWatcher: async (_ctx: ToolContext, ref: string) => ({ id: ref, name: ref }),
    createProject: async () => null,
    updateProject: async () => null,
    deleteProject: async (_ctx: ToolContext, key: string) => ({ key, name: key }),
    updateSettings: async () => ({}),
    deleteTicket: async (_ctx: ToolContext, key: string) => fakeTicket({ key }),
  };
  const ops = {} as HarnessOps & { calls: RecordedCall[]; children: Ticket[] };
  for (const name of Object.keys(defaults) as (keyof HarnessOps)[]) {
    const impl = overrides[name] ?? defaults[name];
    (ops as any)[name] = async (ctx: ToolContext, ...args: unknown[]) => {
      calls.push({ method: name, args });
      return impl(ctx, ...args);
    };
  }
  ops.calls = calls;
  ops.children = children;
  return ops;
}

type BrowserImpl = { [K in keyof BrowserService]?: (...args: any[]) => any };

export function fakeBrowser(overrides: BrowserImpl = {}): BrowserService & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let current: BrowserState | null = null;
  const defaults: Required<BrowserImpl> = {
    open: async (sessionId: string, url: string, opts?: { tab?: number; newTab?: boolean }) =>
      (current = { sessionId, tabId: opts?.tab ?? (opts?.newTab ? 2 : 1), url, title: `Title of ${url}`, loading: false }),
    state: async () => current,
    tabs: async () => (current ? [{ id: current.tabId ?? 1, url: current.url, title: current.title, loading: false }] : []),
    closeTab: async () => {},
    content: async () => "Example page text",
    click: async () => {},
    type: async () => {},
    evaluate: async () => "42",
    screenshot: async () => "iVBORw0KGgo=",
    input: async () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
    closeTabs: async () => {},
    close: async () => {},
    shutdown: async () => {},
  };
  const browser = {} as BrowserService & { calls: RecordedCall[] };
  for (const name of Object.keys(defaults) as (keyof BrowserService)[]) {
    const impl = overrides[name] ?? defaults[name];
    (browser as any)[name] = async (...args: unknown[]) => {
      calls.push({ method: name, args });
      return impl(...args);
    };
  }
  browser.calls = calls;
  return browser;
}

export function fakeContext(overrides: Partial<ToolContext> & { runKind?: RunKind } = {}): ToolContext {
  return {
    runId: "run_1",
    runKind: "work",
    session: fakeSession(),
    ticket: fakeTicket(),
    cwd: "/tmp",
    ops: fakeOps(),
    browser: fakeBrowser(),
    signal: new AbortController().signal,
    ...overrides,
  };
}
