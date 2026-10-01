// mobile/src/lib/boardColumns.ts (every case in boardColumns.test.ts) for HarnessKit's
// BoardColumns.swift. Columns are given as tickets and come back as ids.
import { boardColumns, initialState, reducer, type Action, type Columns } from "../../src/state";
import type { Ticket, TicketPage, TicketStatus } from "../../src/protocol";
import { columnCount, moveBody, visibleColumns } from "../../../mobile/src/lib/boardColumns";
import { cases } from "../case";
import { snapshot, tk as base } from "../board";

let seq = 0;
const tk = (id: string, extra: Partial<Ticket> = {}): Ticket => base(id, { key: `T-${id}`, status: "in_progress", createdAt: ++seq, updatedAt: seq, ...extra });
const ids = (c: Columns) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.map((t) => t.id)]));

// A conductor with a done child, a quiet in-progress child and a blocked one, plus 40 done tickets
// on the server of which the first page (3 newest) is loaded.
const conductor = tk("c", { kind: "conductor" });
const quietKid = tk("k1", { parentId: "c" });
const blockedKid = tk("k2", { parentId: "c", status: "blocked" });
const approvalKid = tk("k4", { parentId: "c", status: "in_progress", pendingApproval: { id: "ap", runId: "r", toolName: "Bash", input: {}, requestedAt: 1 } });
const reviewKid = tk("k5", { parentId: "c", status: "review" });
const doneKid = tk("k3", { parentId: "c", status: "done", completedAt: 900 });
const d1 = tk("d1", { status: "done", completedAt: 800 });
const d2 = tk("d2", { status: "done", completedAt: 700 });
const page: TicketPage = { tickets: [doneKid, d1, d2], nextCursor: "c3", total: 40 };
const paged: Action[] = [snapshot([conductor, quietKid, blockedKid, approvalKid, reviewKid], { scope: "p1", page })];
const legacy: Action[] = [snapshot([d1, d2])];
const board = (actions: Action[]) => boardColumns(actions.reduce(reducer, initialState), "p1");

export const visibleColumnsCases = cases(({ actions, hideChildren }: { actions: Action[]; hideChildren: boolean }) => ids(visibleColumns(board(actions), hideChildren)), {
  "hides quiet children, keeps ones the human has to act on": { actions: paged, hideChildren: true },
  "Show child tickets puts them all back": { actions: paged, hideChildren: false },
});

export const columnCountCases = cases(
  ({ actions, projectId, status, searching, hideChildren }: { actions: Action[]; projectId: string | null; status: TicketStatus; searching: boolean; hideChildren: boolean }) => {
    const state = actions.reduce(reducer, initialState);
    return columnCount(state, projectId, visibleColumns(boardColumns(state, projectId), hideChildren), status, searching);
  },
  {
    "Done counts the server total even while children are hidden": { actions: paged, projectId: "p1", status: "done", searching: false, hideChildren: true },
    "a live column counts what's shown": { actions: paged, projectId: "p1", status: "in_progress", searching: false, hideChildren: true },
    "search results count what's shown, Done included": { actions: paged, projectId: "p1", status: "done", searching: true, hideChildren: true },
    "without paging (an older service) Done counts what's loaded": { actions: legacy, projectId: "p1", status: "done", searching: false, hideChildren: true },
    "another scope without paging counts what's loaded": { actions: paged, projectId: null, status: "done", searching: false, hideChildren: false },
  },
);

const a = tk("a", { status: "planning", position: 1 });
const b = tk("b", { status: "planning", position: 2 });
const c = tk("c2", { status: "in_progress", position: 5 });
const old = tk("o", { status: "done", completedAt: 50 });
const cols: Columns = { ...boardColumns(initialState, null), planning: [a, b], in_progress: [c] };
const mv = (t: Ticket, status: TicketStatus, where: "top" | "bottom", now = 1234) => ({ t, status, where, cols, now });

export const moveBodyCases = cases(({ t, status, where, cols, now }: ReturnType<typeof mv>) => moveBody(t, status, where, cols, now), {
  "into Done: the status only, and it's the newest completion": mv(c, "done", "bottom"),
  "out of Done to the top clears completedAt": mv(old, "planning", "top"),
  "out of Done to the bottom takes a position after the others": mv(old, "planning", "bottom"),
  "within a column to the top, not counting the card itself": mv(b, "planning", "top"),
  "within a column to the bottom": mv(a, "planning", "bottom"),
  "into an empty column": mv(a, "review", "top"),
  "a done card moved within Done changes nothing": mv(d1, "done", "top"),
  "a done card without completedAt moved within Done": mv(tk("x", { status: "done", completedAt: undefined }), "done", "bottom"),
  "a done card without completedAt moved out": mv(tk("y", { status: "done", completedAt: undefined }), "blocked", "top"),
});
