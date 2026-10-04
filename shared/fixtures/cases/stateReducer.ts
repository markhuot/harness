// Reducer scenarios (shared/src/state/reducer.ts, every case in reducer.test.ts plus edge cases)
// for HarnessKit's BoardState / Reducer / Selectors. See ../board.ts for the scenario format.
import { initialState, isReady, mergeById, positionForDrop, transcriptKey, type State } from "../../src/state";
import type { Ticket } from "../../src/protocol";
import { cases } from "../case";
import { activity, detail, entry, ev, project, revision, run, scenario, session, settings, snapshot, sub, ticket, upsert, watcher, PROBE_NAMES } from "../board";

export const probeNames = PROBE_NAMES;

const delta = (text: string, runId = "r1", sessionId = "s1") => ev({ kind: "transcript.delta", sessionId, runId, text });
const appended = (e: Parameters<typeof entry>[0], seq: number, over: Parameters<typeof entry>[2] = {}) => ev({ kind: "transcript.appended", entry: entry(e, seq, over) });

const board = [
  upsert(ticket("a", { projectId: "p1", status: "planning", position: 2, createdAt: 1 })),
  upsert(ticket("b", { projectId: "p1", status: "planning", position: 1, createdAt: 2 })),
  upsert(ticket("c", { projectId: "p2", status: "planning", position: 1, createdAt: 0 })),
  upsert(ticket("d", { projectId: "p2", status: "done", updatedAt: 5 })),
  upsert(ticket("e", { projectId: "p1", status: "done", updatedAt: 9 })),
];

const withProjects = (...ps: ReturnType<typeof project>[]): State => ({ ...initialState, projects: Object.fromEntries(ps.map((p) => [p.id, p])) });
const withDriver = (p1Driver: string | null): State => ({ ...initialState, settings, projects: { p1: project("p1", "HAR", { defaultDriver: p1Driver }) } }) as State;

export const scenarios = [
  // transcript
  scenario("out-of-order live entries are kept sorted by seq", [
    { actions: [appended("c", 3), appended("a", 1), appended("b", 2)], probes: [["transcript", "s1"]] },
  ]),
  scenario("REST backfill overlapping live events dedupes by id and marks loaded", [
    { actions: [appended("b", 2), appended("c", 3)], probes: [["transcript", "s1"]] },
    { actions: [{ type: "transcript", sessionId: "s1", entries: [entry("a", 1), entry("b", 2), entry("c", 3)] }], probes: [["transcript", "s1"]] },
  ]),
  scenario("a later version of the same entry id replaces the earlier one", [
    { actions: [appended("a", 1), appended("a", 1, { content: { type: "text", text: "edited" } })] },
  ]),
  scenario("sessions are isolated", [
    { actions: [appended("a", 1), appended("x", 1, { sessionId: "s2" })], probes: [["transcript", "s1"], ["transcript", "s2"]] },
  ]),
  scenario("equal seqs tie-break by id", [{ actions: [appended("b", 1), appended("a", 1), appended("c", 0)], probes: [["transcript", "s1"]] }]),

  // streaming deltas
  scenario("deltas accumulate per session and run", [
    { actions: [delta("Hel"), delta("lo"), delta("other", "r2"), delta("x", "r1", "s2")], probes: [["liveDelta", "s1"], ["liveDelta", "s2"], ["liveDelta", "none"]] },
  ]),
  scenario("deltas are cleared by the matching assistant text entry only", [
    { actions: [delta("Hello"), delta("Other", "r2")] },
    // A tool call from the same run doesn't end the streamed text block.
    { actions: [appended("t", 1, { role: "tool", content: { type: "tool_call", callId: "c", name: "bash", input: {} } })], full: true },
    // User text on the same run id doesn't either.
    { actions: [appended("u", 2, { role: "user" })], probes: [["liveDelta", "s1"]] },
    // Nor does assistant thinking.
    { actions: [appended("th", 3, { content: { type: "thinking", text: "hm" } })], probes: [["liveDelta", "s1"]] },
    { actions: [appended("a", 4, { runId: "r1" })], probes: [["liveDelta", "s1"]], full: true },
    { actions: [appended("b", 5, { runId: "r2" })], probes: [["liveDelta", "s1"]] },
  ]),
  scenario("assistant text with a null runId clears every run of the session", [
    { actions: [delta("one"), delta("two", "r2"), appended("n", 1, { runId: null })], probes: [["liveDelta", "s1"]] },
  ]),
  scenario("assistant text for a run without a delta leaves the others", [
    { actions: [delta("one"), appended("n", 1, { runId: "r9" })], probes: [["liveDelta", "s1"]] },
  ]),
  scenario("a new delta after the clear starts a fresh block", [{ actions: [delta("first"), appended("a", 1), delta("second")] }]),
  scenario("a run ending (cancelled mid-stream) drops its dangling delta", [
    { actions: [delta("partial"), ev({ kind: "run.upserted", run: run("r1", "running") })], probes: [["liveDelta", "s1"]] },
    { actions: [ev({ kind: "run.upserted", run: run("r1", "cancelled") })], probes: [["liveDelta", "s1"]] },
  ]),
  scenario("succeeded and failed runs drop their deltas; queued ones don't", [
    { actions: [delta("a"), delta("b", "r2"), delta("c", "r3"), ev({ kind: "run.upserted", run: run("r3", "queued") })], probes: [["liveDelta", "s1"]] },
    { actions: [ev({ kind: "run.upserted", run: run("r1", "succeeded") }), ev({ kind: "run.upserted", run: run("r2", "failed") })], probes: [["liveDelta", "s1"]] },
  ]),

  // activity
  scenario("activity ordered by createdAt and deduped when detail backfill overlaps live events", [
    { actions: [ev({ kind: "activity.added", entry: activity("b", 20) })], probes: [["latestActivity", "s1"]] },
    {
      actions: [{ type: "detail", detail: { ...detail(ticket("t1", { sessionId: "s1" })), activity: [activity("a", 10), activity("b", 20)] } }],
      probes: [["latestActivity", "s1"]],
    },
    { actions: [ev({ kind: "activity.added", entry: activity("c", 30) })], probes: [["latestActivity", "s1"], ["latestActivity", "nope"]] },
  ]),
  scenario("activity backfill action merges by id", [
    { actions: [{ type: "activity", sessionId: "s1", activity: [activity("z", 5), activity("y", 1)] }, { type: "activity", sessionId: "s1", activity: [activity("z", 5, { body: "edited" })] }] },
  ]),
  scenario("activity.added replaces an entry in place and sorts a late one by createdAt", [
    {
      actions: [
        { type: "activity", sessionId: "s1", activity: [activity("a", 10), activity("c", 30)] },
        ev({ kind: "activity.added", entry: activity("a", 10, { body: "edited" }) }),
        ev({ kind: "activity.added", entry: activity("b", 20, { kind: "submitted", meta: { specRevision: 2 } }) }),
        ev({ kind: "activity.added", entry: activity("x", 5, { sessionId: "s2" }) }),
      ],
    },
  ]),
  scenario("latestActivity filtered by kind", [
    {
      actions: [
        {
          type: "activity",
          sessionId: "s1",
          activity: [
            activity("n1", 10),
            activity("sub", 20, { kind: "submitted" }),
            activity("n2", 30),
            activity("m", 40, { kind: "message", author: "human" }),
          ],
        },
      ],
      probes: [["latestActivity", "s1"], ["latestActivity", "s1", ["note"]], ["latestActivity", "s1", ["submitted", "blocked"]], ["latestActivity", "s1", ["failed"]], ["latestActivity", "s1", []]],
    },
  ]),

  // spec revisions
  scenario("spec.revised appends to a loaded revision list only", [
    { actions: [ev({ kind: "spec.revised", ticketId: "t1", rev: 2, author: "agent", note: "unloaded" })], probes: [["specRevisions", "t1"]], full: true },
    {
      actions: [
        { type: "specRevisions", ticketId: "t1", revisions: [revision(1), revision(3)] },
        ev({ kind: "spec.revised", ticketId: "t1", rev: 2, author: "agent", note: "Plan", runId: "r1", runKind: "plan", createdAt: 15 }),
        ev({ kind: "spec.revised", ticketId: "t1", rev: 4, author: "human", note: "Edited by hand" }),
        ev({ kind: "spec.revised", ticketId: "t1", rev: 3, author: "agent", note: "again" }),
      ],
      probes: [["specRevisions", "t1"]],
    },
  ]),
  scenario("the ticket's specBaselineRevision decides which revision is approved", [
    { actions: [{ type: "specRevisions", ticketId: "t1", revisions: [revision(2), revision(1, { approvedBaseline: true })] }], probes: [["specRevisions", "t1"]] },
    { actions: [upsert(ticket("t1", { specRevision: 3, specBaselineRevision: 2 }))], probes: [["specRevisions", "t1"]] },
    { actions: [{ type: "specRevisions", ticketId: "t1", revisions: [revision(1, { approvedBaseline: true }), revision(2), revision(3)] }], probes: [["specRevisions", "t1"]] },
    { actions: [upsert(ticket("t1", { specRevision: 3, specBaselineRevision: null }))], probes: [["specRevisions", "t1"]] },
    { actions: [upsert(ticket("t1", { specRevision: 3, specBaselineRevision: 3 })), upsert(ticket("t1", { specRevision: 3 }))], probes: [["specRevisions", "t1"]] },
    { actions: [upsert(ticket("t2", { specBaselineRevision: 1 }))], probes: [["specRevisions", "t2"]] },
  ]),
  scenario("specRevision stores bodies; specBody reads the current one from the ticket", [
    {
      actions: [
        upsert(ticket("t1", { spec: "current body", specRevision: 3 })),
        upsert(ticket("t2", { spec: "rev one" })),
        { type: "specRevision", ticketId: "t1", revision: { ...revision(1), body: "first body" } },
      ],
      probes: [["specBody", "t1", 1], ["specBody", "t1", 2], ["specBody", "t1", 3], ["specBody", "t2", 1], ["specBody", "t2", 2], ["specBody", "nope", 1], ["specRevisions", "t1"]],
      full: true,
    },
    {
      actions: [
        { type: "specRevisions", ticketId: "t1", revisions: [revision(1)] },
        { type: "specRevision", ticketId: "t1", revision: { ...revision(2, { note: "from GET" }), body: "second body" } },
        { type: "specRevision", ticketId: "t1", revision: { ...revision(3), body: "stale" } },
      ],
      probes: [["specBody", "t1", 2], ["specBody", "t1", 3], ["specRevisions", "t1"]],
    },
  ]),

  // entities
  scenario("ticket upsert replaces, delete removes, and unknown deletes are no-ops", [
    { actions: [upsert(ticket("t1")), upsert(ticket("t1", { status: "review", busy: true }))], full: true },
    { actions: [ev({ kind: "ticket.deleted", id: "nope" })], full: true },
    { actions: [ev({ kind: "ticket.deleted", id: "t1" })] },
  ]),
  scenario("deleting a project drops its tickets", [
    {
      actions: [
        ev({ kind: "project.upserted", project: project("p1", "A") }),
        ev({ kind: "project.upserted", project: project("p2", "B") }),
        upsert(ticket("t1", { projectId: "p1" })),
        upsert(ticket("t2", { projectId: "p2" })),
        ev({ kind: "project.deleted", id: "p1" }),
      ],
    },
  ]),
  scenario("watchers upsert and delete", [
    { actions: [ev({ kind: "watcher.upserted", watcher: watcher("w1") })], full: true },
    { actions: [ev({ kind: "watcher.deleted", id: "w1" }), ev({ kind: "watcher.deleted", id: "never" })] },
  ]),
  scenario("sessions, settings, drivers and connection", [
    {
      actions: [
        ev({ kind: "session.upserted", session: session("s1") }),
        ev({ kind: "settings.updated", settings }),
        { type: "drivers", drivers: [{ id: "dummy", name: "Dummy", description: "Test driver", available: true, authenticated: true, detail: "", supportsLogin: false }] },
        { type: "connected", connected: true },
      ],
      full: true,
    },
    { actions: [{ type: "connected", connected: true }, { type: "connected", connected: false }] },
  ]),
  scenario("events the reducer ignores leave state alone", [
    {
      actions: [
        ev({ kind: "browser.frame", sessionId: "s1", data: "AAAA", width: 1, height: 1 }),
        ev({ kind: "browser.state", sessionId: "s1", state: { sessionId: "s1", url: "about:blank", title: "", loading: false } }),
        ev({ kind: "session.deleted", id: "s1" }),
        ev({ kind: "service.status", status: { build: null, stale: true } }),
      ],
    },
  ]),
  scenario("snapshot replaces entity lists (stale tickets vanish after a reconnect refetch)", [
    { actions: [upsert(ticket("gone"))] },
    { actions: [snapshot([ticket("t1")])] },
  ]),
  scenario("snapshot doesn't clobber a newer live update that raced the REST request", [
    { actions: [upsert(ticket("t1", { status: "review", updatedAt: 20 }))] },
    { actions: [snapshot([ticket("t1", { status: "in_progress", updatedAt: 10 })])], full: true },
    // Equal or newer snapshot data wins.
    { actions: [snapshot([ticket("t1", { status: "done", updatedAt: 20 })])] },
  ]),
  scenario("snapshot keeps transcripts, activity, runs and a busy session's deltas; prefers newer projects and sessions", [
    {
      actions: [
        appended("a", 1),
        ev({ kind: "activity.added", entry: activity("x", 1) }),
        delta("streaming"),
        ev({ kind: "project.upserted", project: project("p1", "LIVE", { updatedAt: 50 }) }),
        ev({ kind: "session.upserted", session: session("s1", { title: "live", busy: true, updatedAt: 50 }) }),
        ev({ kind: "watcher.upserted", watcher: watcher("w-old") }),
        { type: "missingKeys", keys: ["gone-1"] },
      ],
    },
    {
      actions: [
        snapshot([ticket("t1", { createdAt: 7 }), ticket("t2", { createdAt: 3 })], undefined, {
          projects: [project("p1", "SNAP", { updatedAt: 10 }), project("p2", "B")],
          sessions: [session("s1", { title: "snap", updatedAt: 10 })],
          watchers: [watcher("w1")],
          settings,
        }),
      ],
    },
  ]),

  scenario("snapshot drops the deltas of idle sessions (their end was missed, e.g. while suspended)", [
    { actions: [delta("half a plan"), delta("live", "r2", "s2"), delta("unknown", "r3", "s3")] },
    {
      actions: [snapshot([], undefined, { sessions: [session("s1", { busy: false }), session("s2", { busy: true })] })],
      probes: [["liveDelta", "s1"], ["liveDelta", "s2"], ["liveDelta", "s3"]],
    },
  ]),
  scenario("snapshot keeps a delta when a newer live session says it's busy", [
    { actions: [ev({ kind: "session.upserted", session: session("s1", { busy: true, updatedAt: 9 }) }), delta("live")] },
    { actions: [snapshot([], undefined, { sessions: [session("s1", { busy: false, updatedAt: 1 })] })], probes: [["liveDelta", "s1"]] },
  ]),
  scenario("detail drops the deltas of runs it reports ended and keeps the running one's", [
    { actions: [delta("stale plan", "r-plan", "s-t"), delta("streaming", "r-work", "s-t"), delta("other", "r-x", "s2")] },
    {
      actions: [
        {
          type: "detail",
          detail: detail(ticket("t", { sessionId: "s-t" }), {
            runs: [run("r-plan", "succeeded", { sessionId: "s-t" }), run("r-work", "running", { sessionId: "s-t" }), run("r-x", "queued", { sessionId: "s2" })],
          }),
        },
      ],
      probes: [["liveDelta", "s-t"], ["liveDelta", "s2"]],
    },
  ]),

  // details
  scenario("detail merges children, parent, runs, session, sub-agents and dependents", [
    { actions: [snapshot([ticket("kid", { parentId: "cond", status: "in_progress" })])] },
    {
      actions: [
        {
          type: "detail",
          detail: detail(ticket("cond", { kind: "conductor", status: "in_progress", updatedAt: 3 }), {
            children: [ticket("kid", { parentId: "cond", status: "in_progress" }), ticket("k2", { parentId: "cond", status: "done", createdAt: 1, updatedAt: 4 })],
            runs: [run("r1", "running", { sessionId: "s-cond" })],
            dependents: ["X-1"],
            subagents: [sub("sa", { sessionId: "s-cond" })],
          }),
        },
      ],
      probes: [["childrenOf", "cond"], ["conductorsNeedingChildren"], ["subagentsOf", "s-cond"]],
    },
  ]),
  scenario("detail by an old key records an alias; the current key records none", [
    { actions: [{ type: "missingKeys", keys: ["old-7", "Other-1"] }], full: true },
    { actions: [{ type: "detail", detail: detail(ticket("r", { key: "NEW-7" })), requestedKey: "old-7" }], probes: [["ticketByKey", "OLD-7"], ["ticketByKey", "new-7"], ["ticketByKey", "missing-1"]], full: true },
    { actions: [{ type: "detail", detail: detail(ticket("q", { key: "Q-1" })), requestedKey: "q-1" }] },
  ]),
  scenario("resolvedFrom wins over requestedKey for the alias", [
    { actions: [{ type: "detail", detail: detail(ticket("r", { key: "NEW-7" }), { resolvedFrom: "OLD-7" }), requestedKey: "something-else" }], probes: [["ticketByKey", "old-7"], ["ticketByKey", "something-else"]] },
  ]),
  scenario("a stale detail doesn't replace a newer live ticket", [
    { actions: [upsert(ticket("t1", { title: "live", updatedAt: 9 })), { type: "detail", detail: detail(ticket("t1", { title: "stale", updatedAt: 2 })) }] },
  ]),

  // tickets action
  scenario("tickets action merges, newer live versions win", [
    { actions: [upsert(ticket("a", { title: "live", updatedAt: 5 })), { type: "tickets", tickets: [ticket("a", { title: "fetched", updatedAt: 4 }), ticket("b")] }] },
    { actions: [{ type: "tickets", tickets: [ticket("a", { title: "same time", updatedAt: 5 })] }, { type: "tickets", tickets: [] }] },
  ]),

  // sub-agent transcripts
  scenario("sub-agent transcript backfill is keyed by session/sub-agent", [
    { actions: [{ type: "transcript", sessionId: "s1", subagentId: "a", entries: [entry("e1", 1, { subagentId: "a" })] }, { type: "transcript", sessionId: "s1", subagentId: null, entries: [] }] },
  ]),

  // board selectors
  scenario("boardColumns filters by project; null means all projects; position ties fall back to creation order", [
    { actions: board, probes: [["boardColumns", "p1"], ["boardColumns", "p2"], ["boardColumns", null], ["boardColumns", "missing"], ["ticketsForProject", "p1"], ["ticketsForProject", null]] },
  ]),
  scenario("dependency chips are done only when the named ticket is done; unknown keys stay unknown", [
    { actions: [...board, upsert(ticket("f", { dependsOn: ["E", "a", "ZZZ-9"] }))], probes: [["dependencyStates", "f"]] },
  ]),
  scenario("hasCustomDriver: the global default counts when the project has none", [
    { probes: [["hasCustomDriver", ticket("a", { driver: "claude-code" })], ["hasCustomDriver", ticket("a", { driver: "codex" })], ["defaultDriverOf", "p1"], ["defaultDriverOf", "nope"]] },
  ], withDriver(null)),
  scenario("hasCustomDriver: a project's own default overrides the global one", [
    { probes: [["hasCustomDriver", ticket("a", { driver: "codex" })], ["hasCustomDriver", ticket("a", { driver: "claude-code" })], ["defaultDriverOf", "p1"]] },
  ], withDriver("codex")),
  scenario("hasCustomDriver stays quiet until settings load", [{ probes: [["hasCustomDriver", ticket("a", { driver: "codex" })], ["defaultDriverOf", "p1"]] }]),
  scenario("composerProject resolves to a real project when the modal mounted before projects loaded", [
    { probes: [["composerProject", "", [null, null]]] },
  ]),
  scenario("composerProject with projects", [
    { probes: [["composerProject", "", [null, null]], ["composerProject", "p2", ["p1", null]], ["composerProject", "gone", ["p2", "p1"]], ["composerProject", "gone", ["missing", "p1"]], ["composerProject", "gone", ["", "p1"]], ["sortedProjects"]] },
  ], withProjects(project("p1", "ZED"), project("p2", "ALPHA"))),
  scenario("sortedProjects is case-insensitive by name", [
    { probes: [["sortedProjects"]] },
  ], withProjects(project("a", "A", { name: "beta" }), project("b", "B", { name: "Alpha" }), project("c", "C", { name: "alpha" }), project("d", "D", { name: "Gamma 10" }), project("e", "E", { name: "gamma 9" }))),
  scenario("ticketLinkable: loaded, project prefix, 404'd, look-alikes", [
    {
      actions: [ev({ kind: "project.upserted", project: project("p1", "FOO") }), upsert(ticket("t1", { key: "BAR-1" })), { type: "missingKeys", keys: ["foo-99"] }],
      probes: [["ticketLinkable", "bar-1"], ["ticketLinkable", "FOO-12"], ["ticketLinkable", "foo-99"], ["ticketLinkable", "UTF-8"], ["ticketLinkable", "FOO"], ["ticketLinkable", "FOOX"], ["ticketLinkable", "-1"]],
    },
  ]),
  scenario("triage sessions newest first", [
    {
      actions: [
        ev({ kind: "session.upserted", session: session("t-old", { kind: "triage", createdAt: 1 }) }),
        ev({ kind: "session.upserted", session: session("t-new", { kind: "triage", createdAt: 9 }) }),
        ev({ kind: "session.upserted", session: session("work", { kind: "ticket", createdAt: 5 }) }),
      ],
      probes: [["triageSessions"]],
    },
  ]),
  scenario("childrenOf sorts by createdAt", [
    { actions: [upsert(ticket("k2", { parentId: "c", createdAt: 5 })), upsert(ticket("k1", { parentId: "c", createdAt: 1 })), upsert(ticket("x", { parentId: "other" }))], probes: [["childrenOf", "c"], ["childrenOf", "none"]] },
  ]),
];

export const isReadyCases = cases(
  ({ agentReview, humanReview, status }: { agentReview: Ticket["agentReview"]; humanReview: Ticket["humanReview"]; status: Ticket["status"] }) =>
    isReady(ticket("t", { status, agentReview, humanReview })),
  {
    approved: { agentReview: "approved", humanReview: "approved", status: "review" },
    skipped: { agentReview: "skipped", humanReview: "approved", status: "review" },
    pending: { agentReview: "pending", humanReview: "approved", status: "review" },
    "changes requested": { agentReview: "changes_requested", humanReview: "approved", status: "review" },
    "human pending": { agentReview: "skipped", humanReview: "pending", status: "review" },
    "not in review": { agentReview: "skipped", humanReview: "approved", status: "in_progress" },
  },
);

const col = [1, 2, 4];
export const positionForDropCases = cases(({ column, index }: { column: number[]; index: number }) => positionForDrop(column.map((position) => ({ position })), index), {
  "between neighbours (1)": { column: col, index: 1 },
  "between neighbours (2)": { column: col, index: 2 },
  top: { column: col, index: 0 },
  bottom: { column: col, index: 3 },
  "index past the end clamps": { column: col, index: 99 },
  "negative index clamps": { column: col, index: -3 },
  "empty column": { column: [], index: 0 },
  "equal neighbours nudge above the earlier": { column: [2, 2], index: 1 },
  "descending neighbours (legacy)": { column: [5, 3], index: 1 },
  "negative positions": { column: [-4, -1], index: 1 },
});

export const mergeByIdCases = cases(
  ({ existing, incoming }: { existing: { id: string; n: number }[]; incoming: { id: string; n: number }[] }) => mergeById(existing, incoming, (x) => x.n),
  {
    "stable for equal sort keys": { existing: [{ id: "b", n: 1 }], incoming: [{ id: "a", n: 1 }] },
    "incoming replaces by id": { existing: [{ id: "a", n: 1 }, { id: "b", n: 2 }], incoming: [{ id: "a", n: 3 }] },
    "empty incoming keeps existing as is": { existing: [{ id: "b", n: 2 }, { id: "a", n: 1 }], incoming: [] },
    "ids compare as JS strings": { existing: [{ id: "a", n: 0 }, { id: "B", n: 0 }, { id: "_", n: 0 }], incoming: [{ id: "10", n: 0 }, { id: "9", n: 0 }] },
  },
);

export const transcriptKeyCases = cases(({ sessionId, subagentId }: { sessionId: string; subagentId?: string | null }) => transcriptKey(sessionId, subagentId), {
  session: { sessionId: "s1" },
  "null sub-agent": { sessionId: "s1", subagentId: null },
  "empty sub-agent": { sessionId: "s1", subagentId: "" },
  "sub-agent": { sessionId: "s1", subagentId: "toolu_1" },
});
