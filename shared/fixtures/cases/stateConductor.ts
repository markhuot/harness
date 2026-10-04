// Conductor/children derivations (shared/src/state/conductor.ts) for HarnessKit's
// State/Conductor.swift. Outputs that hold tickets are reduced to keys so a mismatch reads well.
import type { Ticket } from "../../src/protocol";
import {
  attentionOf,
  autoStartTitle,
  autoStartWaitingOn,
  childrenOfTicket,
  dependencyDepths,
  depChipTitle,
  depStates,
  dimOnBoard,
  groupChildren,
  HIDE_CHILDREN_DEFAULT,
  HIDE_CHILDREN_KEY,
  hideOnBoard,
  isChild,
  isWorking,
  needsHuman,
  progressLabel,
  progressOf,
  progressSegments,
  SEGMENT_ORDER,
  waitingOn,
  workingTitle,
  type DepState,
} from "../../src/state/conductor";
import { cases } from "../case";

let seq = 0;
function tk(o: Partial<Ticket> & { key: string }): Ticket {
  seq++;
  return {
    id: `id-${o.key}`,
    projectId: "p1",
    kind: "task",
    title: o.key,
    spec: "",
    status: "planning",
    sessionId: `s-${o.key}`,
    driver: "claude-code",
    parentId: null,
    dependsOn: [],
    autoStart: false,
    agentReview: "pending",
    humanReview: "pending",
    externalRef: null,
    workdir: null,
    branch: null,
    blockedReason: null,
    busy: false,
    pendingApproval: null,
    allowedTools: [],
    position: seq,
    createdAt: seq,
    updatedAt: seq,
    ...o,
  } as Ticket;
}
const rec = (...ts: Ticket[]) => Object.fromEntries(ts.map((t) => [t.id, t]));
const approval = { id: "a", runId: "r", toolName: "Bash", input: {}, requestedAt: 1 };
const keys = (ts: Ticket[]) => ts.map((t) => t.key);

export const hideChildrenKey = HIDE_CHILDREN_KEY;
export const hideChildrenDefault = HIDE_CHILDREN_DEFAULT;
export const segmentOrder = SEGMENT_ORDER;

// ---------------------------------------------------------------------------
// Attention and board weight
// ---------------------------------------------------------------------------

const boardTickets = {
  "blocked with approval": tk({ key: "A-1", status: "blocked", pendingApproval: approval }),
  blocked: tk({ key: "A-2", status: "blocked" }),
  "review pending": tk({ key: "A-3", status: "review", humanReview: "pending" }),
  "review approved": tk({ key: "A-4", status: "review", humanReview: "approved" }),
  "review changes requested": tk({ key: "A-7", status: "review", humanReview: "changes_requested" }),
  "in progress, review pending": tk({ key: "A-5", status: "in_progress", humanReview: "pending" }),
  "done, review pending": tk({ key: "A-6", status: "done", humanReview: "pending" }),
  "planning with approval": tk({ key: "A-8", status: "planning", pendingApproval: approval }),
  "child in review (conductor's job)": tk({ key: "P-2", parentId: "id-P-1", status: "review", humanReview: "pending" }),
  "child in review with approval": tk({ key: "P-3", parentId: "id-P-1", status: "review", humanReview: "pending", pendingApproval: approval }),
  "child blocked": tk({ key: "P-4", parentId: "id-P-1", status: "blocked" }),
  "child in progress": tk({ key: "C-2", parentId: "id-C-1", status: "in_progress" }),
  "child done": tk({ key: "C-7", parentId: "id-C-1", status: "done" }),
  "child with empty-string parent is still a child": tk({ key: "C-8", parentId: "", status: "in_progress" }),
  "top-level in progress": tk({ key: "C-5", status: "in_progress" }),
  "top-level review pending": tk({ key: "C-6", status: "review", humanReview: "pending" }),
};

export const boardWeightCases = cases(
  (t: Ticket) => ({
    isChild: isChild(t),
    attention: attentionOf(t),
    needsHuman: needsHuman(t),
    dimOnBoard: dimOnBoard(t),
    hideWhenHiding: hideOnBoard(t, true),
    hideWhenShowing: hideOnBoard(t, false),
  }),
  boardTickets,
);

// ---------------------------------------------------------------------------
// Children and progress
// ---------------------------------------------------------------------------

const h3 = tk({ key: "H-3", parentId: "id-H-1", createdAt: 30 });
const h2 = tk({ key: "H-2", parentId: "id-H-1", createdAt: 20 });
const h9 = tk({ key: "H-9", parentId: "id-H-8" });
const h4 = tk({ key: "H-4", parentId: "id-H-1", createdAt: 20, position: 0.5 });
const h5 = tk({ key: "H-5", parentId: "id-H-1", createdAt: 20, position: 100 });

export const childrenOfTicketCases = cases(
  ({ tickets, conductorId }: { tickets: Record<string, Ticket>; conductorId: string }) => keys(childrenOfTicket(tickets, conductorId)),
  {
    "filters by parent, creation order": { tickets: rec(h3, h9, h2), conductorId: "id-H-1" },
    "same createdAt falls back to position": { tickets: rec(h5, h3, h2, h4), conductorId: "id-H-1" },
    "no children": { tickets: rec(h3, h2), conductorId: "id-nope" },
    "empty record": { tickets: {}, conductorId: "id-H-1" },
  },
);

const kid = (o: Partial<Ticket> & { key: string }) => tk({ parentId: "id-K-0", ...o });
const kids = [
  kid({ key: "K-1", status: "done" }),
  kid({ key: "K-2", status: "done" }),
  kid({ key: "K-3", status: "in_progress" }),
  kid({ key: "K-4", status: "blocked", pendingApproval: approval }),
  kid({ key: "K-5", status: "review", humanReview: "pending" }),
  kid({ key: "K-6", status: "planning" }),
  kid({ key: "K-8", status: "blocked" }),
];

export const progressCases = cases(
  (children: Ticket[]) => {
    const p = progressOf(children);
    return { progress: p, label: progressLabel(p), segments: progressSegments(p) };
  },
  {
    "mixed children": kids,
    "one done": [tk({ key: "K-7", status: "done" })],
    "none done": [kid({ key: "K-9", status: "planning" }), kid({ key: "K-10", status: "in_progress" })],
    "thirds (pct is not a round number)": [kid({ key: "T-1", status: "done" }), kid({ key: "T-2", status: "review" }), kid({ key: "T-3", status: "blocked" })],
    "attention counts approvals outside blocked": [kid({ key: "Q-1", status: "in_progress", pendingApproval: approval }), kid({ key: "Q-2", status: "review", humanReview: "pending" })],
    "top-level review counts as attention": [tk({ key: "Q-3", status: "review", humanReview: "pending" })],
    empty: [],
  },
);

const w1 = tk({ key: "W-1", kind: "conductor" });
const w2 = tk({ key: "W-2", kind: "conductor", parentId: w1.id });
const wBusyKid = tk({ key: "W-3", parentId: w1.id, status: "in_progress", busy: true });
const wBusyGrandkid = tk({ key: "W-4", parentId: w2.id, busy: true });
const wBlocked = tk({ key: "W-5", parentId: w1.id, status: "blocked" });
const wStopped = tk({ key: "W-6", parentId: w1.id, status: "in_progress" });
const wElsewhere = tk({ key: "W-7", parentId: "id-OTHER", busy: true });
const wCycleA = tk({ key: "W-8", parentId: "id-W-9", busy: true });
const wCycleB = tk({ key: "W-9", parentId: "id-W-8" });

export const isWorkingCases = cases(
  ({ tickets, ticket }: { tickets: Record<string, Ticket>; ticket: Ticket }) => ({ working: isWorking(tickets, ticket), title: workingTitle(ticket) }),
  {
    "busy child": { tickets: rec(w1, wBusyKid), ticket: w1 },
    "busy grandchild": { tickets: rec(w1, w2, wBusyGrandkid), ticket: w1 },
    "busy grandchild, middle conductor": { tickets: rec(w1, w2, wBusyGrandkid), ticket: w2 },
    "children blocked or stopped": { tickets: rec(w1, wBlocked, wStopped, wElsewhere), ticket: w1 },
    "own run": { tickets: {}, ticket: tk({ key: "W-10", busy: true }) },
    "busy parent doesn't roll down": { tickets: rec({ ...w1, busy: true }, wBlocked), ticket: wBlocked },
    "parent cycle ends the walk": { tickets: rec(wCycleA, wCycleB), ticket: w1 },
    "parent cycle still finds its member": { tickets: rec(wCycleA, wCycleB), ticket: wCycleB },
    "empty-string parent ends the walk": { tickets: rec(tk({ key: "W-11", parentId: "", busy: true }), tk({ key: "W-12", id: "" } as Partial<Ticket> & { key: string })), ticket: w1 },
  },
);

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

const d1 = tk({ key: "D-1", status: "done" });
const d2 = tk({ key: "D-2", status: "in_progress" });
const d3 = tk({ key: "D-3", dependsOn: ["d-1", "D-2", "D-99"] });
const renamed = tk({ key: "NEW-1", status: "done" });
const renamedPending = tk({ key: "NEW-2", status: "blocked" });

type DepInput = { tickets: Record<string, Ticket>; ticket: Ticket; aliases?: Record<string, string> };
const depSummary = (deps: DepState[]) => ({
  deps: deps.map((d) => ({ key: d.key, done: d.done, state: d.state, ticketKey: d.ticket?.key ?? null, missing: d.missing ?? null })),
  waitingOn: waitingOn(deps),
  titles: deps.map(depChipTitle),
});

export const depStatesCases = cases(({ tickets, ticket, aliases }: DepInput) => depSummary(depStates(tickets, ticket, aliases)), {
  "case-insensitive, unloaded is unknown": { tickets: rec(d1, d2, d3), ticket: d3 },
  "through an alias": { tickets: rec(renamed), ticket: tk({ key: "X-1", dependsOn: ["old-1"] }), aliases: { "OLD-1": renamed.id } },
  "alias to a pending ticket": { tickets: rec(renamedPending), ticket: tk({ key: "X-2", dependsOn: ["OLD-2"] }), aliases: { "OLD-2": renamedPending.id } },
  "alias to an unloaded id is unknown": { tickets: rec(renamed), ticket: tk({ key: "X-3", dependsOn: ["OLD-3"] }), aliases: { "OLD-3": "id-gone" } },
  "alias with an empty id is ignored": { tickets: rec(renamed), ticket: tk({ key: "X-4", dependsOn: ["OLD-4"] }), aliases: { "OLD-4": "" } },
  "alias keys are upper-case only": { tickets: rec(renamed), ticket: tk({ key: "X-5", dependsOn: ["old-1"] }), aliases: { "old-1": renamed.id } },
  "a direct key wins over an alias": { tickets: rec(d2, renamed), ticket: tk({ key: "X-6", dependsOn: ["D-2"] }), aliases: { "D-2": renamed.id } },
  "keeps the dependency's spelling and order": { tickets: rec(d1, d2), ticket: tk({ key: "X-7", dependsOn: ["D-2", "d-1", "D-1"] }) },
  "no dependencies": { tickets: rec(d1), ticket: tk({ key: "X-8" }) },
});

export const depChipTitleCases = cases(depChipTitle, {
  done: { key: "D-1", done: true, state: "done" },
  pending: { key: "D-2", done: false, state: "pending" },
  "unknown, looking up": { key: "D-3", done: false, state: "unknown" },
  "unknown and missing": { key: "D-4", done: false, state: "unknown", missing: true },
  "unknown, missing false": { key: "D-5", done: false, state: "unknown", missing: false },
  "missing flag ignored when pending": { key: "D-6", done: false, state: "pending", missing: true },
} satisfies Record<string, DepState>);

type AutoStartInput = { tickets: Record<string, Ticket>; ticket: Ticket };
const a1 = tk({ key: "S-1", status: "in_progress" });
const a2 = tk({ key: "S-2", status: "done" });
const a3 = tk({ key: "S-3", status: "review" });
const waiter = tk({ key: "S-4", autoStart: true, dependsOn: ["S-1", "s-2", "S-3", "S-99"] });
export const autoStartCases = cases(
  ({ tickets, ticket }: AutoStartInput) => {
    const keys = autoStartWaitingOn(ticket, depStates(tickets, ticket));
    return { waitingOn: keys, title: keys.length ? autoStartTitle(keys) : null };
  },
  {
    "waiting on the open deps only": { tickets: rec(a1, a2, a3), ticket: waiter },
    "one open dep": { tickets: rec(a1, a2), ticket: tk({ key: "S-5", autoStart: true, dependsOn: ["S-1", "S-2"] }) },
    "all done or unloaded": { tickets: rec(a2), ticket: tk({ key: "S-6", autoStart: true, dependsOn: ["S-2", "S-99"] }) },
    "no autoStart": { tickets: rec(a1), ticket: tk({ key: "S-7", dependsOn: ["S-1"] }) },
    draft: { tickets: rec(a1), ticket: tk({ key: "S-8", autoStart: true, draft: true, dependsOn: ["S-1"] }) },
    "already in progress": { tickets: rec(a1), ticket: tk({ key: "S-9", autoStart: true, status: "in_progress", dependsOn: ["S-1"] }) },
    "no dependencies": { tickets: {}, ticket: tk({ key: "S-10", autoStart: true }) },
  },
);

export const autoStartTitleCases = cases(autoStartTitle, {
  none: [],
  one: ["A-1"],
  two: ["A-1", "A-2"],
  three: ["A-1", "A-2", "A-3"],
} satisfies Record<string, string[]>);

export const waitingOnCases = cases(waitingOn, {
  "unknown keys count": [
    { key: "A", done: true, state: "done" },
    { key: "B", done: false, state: "pending" },
    { key: "C", done: false, state: "unknown" },
  ],
  "all done": [{ key: "A", done: true, state: "done" }],
  "goes by done, not state": [{ key: "A", done: false, state: "done" }],
  none: [],
} satisfies Record<string, DepState[]>);

const g1 = tk({ key: "G-1", dependsOn: ["OUT-1"] });
const g2 = tk({ key: "G-2", dependsOn: ["G-1"] });
const g3 = tk({ key: "G-3", dependsOn: ["G-2", "G-1"] });
const g4 = tk({ key: "G-4", dependsOn: ["G-5"] });
const g5 = tk({ key: "G-5", dependsOn: ["G-4"] });
const g6 = tk({ key: "g-6", dependsOn: ["g-3"] });
const g7 = tk({ key: "G-7", dependsOn: ["G-7"] });
const g8 = tk({ key: "G-8", dependsOn: ["G-9"] });
const g9 = tk({ key: "G-9", dependsOn: ["G-10"] });
const g10 = tk({ key: "G-10", dependsOn: ["G-8"] });
const g11 = tk({ key: "G-11", dependsOn: ["G-8"] });

export const dependencyDepthsCases = cases((children: Ticket[]) => Object.fromEntries(dependencyDepths(children)), {
  "chains, outside deps and a two-cycle": [g3, g2, g1, g4, g5],
  "two-cycle from the other side": [g5, g4],
  "case-insensitive sibling keys": [g6, g3, g2, g1],
  "self-dependency": [g7],
  "three-cycle with a tail": [g11, g8, g9, g10],
  "three-cycle from its middle": [g9, g10, g8, g11],
  empty: [],
});

const lk = (o: Partial<Ticket> & { key: string }) => tk({ parentId: "id-L-0", ...o });
const l1 = lk({ key: "L-1", status: "planning", dependsOn: ["L-2"], createdAt: 1 });
const l2 = lk({ key: "L-2", status: "planning", createdAt: 2 });
const l3 = lk({ key: "L-3", status: "done" });
const l4 = lk({ key: "L-4", status: "review", humanReview: "approved", createdAt: 1 });
const l5 = lk({ key: "L-5", status: "review", humanReview: "pending", createdAt: 2 });
const l6 = lk({ key: "L-6", status: "in_progress", createdAt: 1 });
const l7 = lk({ key: "L-7", status: "in_progress", pendingApproval: approval, createdAt: 2 });
const l8 = lk({ key: "L-8", status: "blocked", createdAt: 5 });
const l9 = lk({ key: "L-9", status: "blocked", createdAt: 3 });
const l10 = lk({ key: "L-10", status: "planning", dependsOn: ["L-1"], createdAt: 0 });
const l11 = lk({ key: "L-11", status: "planning", pendingApproval: approval, dependsOn: ["L-10"], createdAt: 9 });
const l12 = lk({ key: "L-12", status: "planning", createdAt: 4 });
const l13 = lk({ key: "L-13", status: "planning", createdAt: 4 });

export const groupChildrenCases = cases((children: Ticket[]) => groupChildren(children).map((g) => ({ status: g.status, tickets: keys(g.tickets) })), {
  "lifecycle order, attention then dependency order": [l3, l1, l4, l2, l5, l6, l7],
  "blocked children by age": [l8, l9],
  "attention beats depth; depth beats age": [l10, l12, l1, l11, l2],
  "ties keep input order": [l13, l12],
  "ties keep input order, reversed": [l12, l13],
  empty: [],
});
