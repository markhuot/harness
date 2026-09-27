// Test doubles for tool and driver tests: a recording HarnessOps, a recording
// BrowserService, and a ToolContext builder. Not used at runtime.

import type { BrowserState, RunKind, Session, Ticket } from "@harness/shared";
import type { BrowserService } from "../browser/types";
import type { HarnessOps, ToolContext } from "./types";

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
 * createTicket are remembered and served by listTickets / getTicket.
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
    submitForReview: async () => {},
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
    listTickets: async () => children,
    getTicket: async (_ctx: ToolContext, key: string) => ({ ticket: find(key), summaries: [{ author: "agent", body: "did it", createdAt: 1 }] }),
    startTicket: async (_ctx: ToolContext, key: string) => ({ ...find(key), status: "in_progress" }),
    messageTicket: async () => {},
    reviewTicket: async (_ctx: ToolContext, key: string, decision: string) => ({
      ...find(key),
      humanReview: decision === "approve" ? "approved" : "changes_requested",
    }),
    completeTicket: async (_ctx: ToolContext, key: string) => find(key),
    listProjects: async () => [{ key: "WEB", name: "Website", path: "/code/web" }],
    dispatchTicket: async (_ctx: ToolContext, input: { key?: string; conductor?: boolean; start?: boolean; title: string }) =>
      fakeTicket({ key: input.key ?? "WEB-1", kind: input.conductor ? "conductor" : "task", status: input.start ? "in_progress" : "planning", title: input.title }),
    declineWork: async () => {},
    requestApproval: async (_ctx: ToolContext, _tool: string, input: unknown) => ({ behavior: "allow", updatedInput: input }),
    checkPermission: async () => ({ behavior: "allow" }),
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
    open: async (sessionId: string, url: string) => (current = { sessionId, url, title: `Title of ${url}`, loading: false }),
    state: async () => current,
    content: async () => "Example page text",
    click: async () => {},
    type: async () => {},
    evaluate: async () => "42",
    screenshot: async () => "iVBORw0KGgo=",
    input: async () => {},
    subscribe: async () => {},
    unsubscribe: async () => {},
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
