import type { Ticket } from "@harness/shared";

/**
 * A ticket as the wire carries it. Only `status` is required: it is the field nearly every test
 * is about. Everything else is the least a ticket can be, and ids come from the key, not a
 * counter, so two builds with the same overrides are equal.
 */
export function makeTicket(overrides: Partial<Ticket> & Pick<Ticket, "status">): Ticket {
  const key = overrides.key ?? "TEST-1";
  const base: Ticket = {
    id: `ticket-${key}`,
    key,
    projectId: "project-TEST",
    kind: "task",
    title: `Ticket ${key}`,
    spec: "",
    sessionId: `session-${key}`,
    driver: "claude-code",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    pullRequests: [],
    blockedReason: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    permissionMode: null,
    model: null,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    status: overrides.status,
  };
  // The defaults are checked as a Ticket above; an override is the test's own word.
  return { ...base, ...overrides } as Ticket;
}
