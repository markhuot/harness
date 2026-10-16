import { expect, test } from "bun:test";
import { CursorError } from "../../../service/src/store/search";
import { canonicalJson, grantKey } from "../../../service/src/store/tickets";
import { fakeClock } from "../../builders/clock";
import { addProject, makeStore } from "../../builders/store";
import { addTicketWith } from "../../builders/ticket-input";

const setup = () => {
  const clock = fakeClock(10_000);
  const store = makeStore({ now: clock });
  const project = addProject(store, { key: "AB" });
  return { clock, store, project };
};

test("create writes revision 1 of the spec, a position at the end of the board, and upper-cases the key", () => {
  const { store, project } = setup();
  const a = addTicketWith(store, project, { spec: "first" });
  const b = addTicketWith(store, project, { key: "ab-77" });
  expect(b.key).toBe("AB-77");
  expect(b.position).toBe(a.position + 1);
  expect(store.specs.list(a.id)).toMatchObject([{ rev: 1, author: "system", note: "Created" }]);
  expect(store.specs.current(a.id)).toEqual({ rev: 1, body: "first" });
});

test("update touches only named columns, stamps updated_at, and replaces dependencies as a whole list", () => {
  const { clock, store, project } = setup();
  const a = addTicketWith(store, project);
  const b = addTicketWith(store, project, { dependsOn: ["ab-1", "AB-9"] });
  expect(b.dependsOn).toEqual(["AB-1", "AB-9"]);
  clock.advance(100);
  const updated = store.tickets.update(b.id, { title: "New", dependsOn: ["AB-5"] })!;
  expect(updated).toMatchObject({ title: "New", dependsOn: ["AB-5"], updatedAt: 10_100, createdAt: 10_000, status: "planning" });
  expect(store.tickets.dependents("AB-5").map((t) => t.id)).toEqual([b.id]);
  expect(store.tickets.dependents(a.key)).toEqual([]);
  expect(store.tickets.update("missing", { title: "x" })).toBeNull();
});

test("a ticket is busy while its session has a queued or running run, and not once it finishes", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  expect(store.tickets.get(t.id)!.busy).toBe(false);
  const run = store.runs.create({ sessionId: t.sessionId, kind: "work", driver: "claude-code", prompt: "p" });
  expect(store.tickets.get(t.id)).toMatchObject({ busy: true, completing: false });
  store.runs.finish(run.id, "succeeded");
  expect(store.tickets.get(t.id)!.busy).toBe(false);
  store.runs.create({ sessionId: t.sessionId, kind: "complete", driver: "claude-code", prompt: "p" });
  expect(store.tickets.get(t.id)).toMatchObject({ busy: true, completing: true });
});

test("list filters by project, parent, status and draft, ordered by position", () => {
  const { store, project } = setup();
  const other = addProject(store, { key: "CD", path: "/other" });
  const parent = addTicketWith(store, project);
  const child = addTicketWith(store, project, { parentId: parent.id, status: "review" });
  const draft = addTicketWith(store, project, { draft: true });
  addTicketWith(store, other);
  expect(store.tickets.list({ projectId: project.id }).map((t) => t.id)).toEqual([parent.id, child.id, draft.id]);
  expect(store.tickets.list({ parentId: parent.id }).map((t) => t.id)).toEqual([child.id]);
  expect(store.tickets.list({ statuses: ["review"] }).map((t) => t.id)).toEqual([child.id]);
  expect(store.tickets.list({ statuses: [] })).toEqual([]);
  expect(store.tickets.list({ projectId: project.id, drafts: false }).map((t) => t.id)).toEqual([parent.id, child.id]);
  expect(store.tickets.get(parent.id)!.childCount).toBe(1);
});

test("page walks a column by keyset with no duplicates or gaps even when a ticket moves between fetches", () => {
  const { clock, store, project } = setup();
  const made = Array.from({ length: 5 }, () => {
    clock.advance(1);
    return addTicketWith(store, project);
  });
  const first = store.tickets.page({ status: "planning", limit: 2 });
  expect(first.tickets.map((t) => t.key)).toEqual(["AB-1", "AB-2"]);
  expect(first.total).toBe(5);
  // The first ticket leaves the column while the client holds a cursor.
  store.tickets.update(made[0]!.id, { status: "review" });
  const second = store.tickets.page({ status: "planning", limit: 2, cursor: first.nextCursor });
  expect(second.tickets.map((t) => t.key)).toEqual(["AB-3", "AB-4"]);
  const third = store.tickets.page({ status: "planning", limit: 2, cursor: second.nextCursor });
  expect(third.tickets.map((t) => t.key)).toEqual(["AB-5"]);
  expect(third.nextCursor).toBeNull();
});

test("a ticket's completion time is when it last entered done, from the clock, and the done column pages newest first", () => {
  const { clock, store, project } = setup();
  const tickets = Array.from({ length: 3 }, () => addTicketWith(store, project));
  const finish = (i: number) => {
    clock.advance(10);
    store.tickets.update(tickets[i]!.id, { status: "done" });
  };
  finish(0);
  finish(2);
  finish(1);
  expect(store.tickets.get(tickets[2]!.id)!.completedAt).toBe(10_020);
  const page = store.tickets.page({ status: "done", limit: 2 });
  expect(page.tickets.map((t) => t.id)).toEqual([tickets[1]!.id, tickets[2]!.id]);
  expect(store.tickets.page({ status: "done", limit: 2, cursor: page.nextCursor }).tickets.map((t) => t.id)).toEqual([tickets[0]!.id]);
  // Leaving done clears it; coming back stamps the new time, so it jumps to the top.
  store.tickets.update(tickets[0]!.id, { status: "review" });
  expect(store.tickets.get(tickets[0]!.id)!.completedAt).toBeNull();
  clock.advance(10);
  store.tickets.update(tickets[0]!.id, { status: "done" });
  expect(store.tickets.page({ status: "done" }).tickets[0]!.id).toBe(tickets[0]!.id);
});

test("a cursor from another listing is refused", () => {
  const { store, project } = setup();
  for (let i = 0; i < 3; i++) addTicketWith(store, project, { status: "done" });
  const done = store.tickets.page({ status: "done", limit: 1 });
  expect(() => store.tickets.page({ status: "done", limit: 1, cursor: "garbage" })).toThrow(CursorError);
  expect(() => store.tickets.page({ status: "planning", cursor: done.nextCursor })).toThrow(CursorError);
  expect(() => store.tickets.search({ q: "x", cursor: done.nextCursor })).toThrow(CursorError);
});

test("search ranks an exact key above a key prefix, a remote ID, a title hit and a spec hit", () => {
  const { clock, store, project } = setup();
  const mk = (over: Parameters<typeof addTicketWith>[2]) => {
    clock.advance(1);
    return addTicketWith(store, project, over);
  };
  // Created best match first, so a newest-first order would be exactly backwards.
  const exact = mk({ key: "WIDGET", title: "other3" });
  const keyPrefix = mk({ key: "WIDGET-5", title: "other2" });
  const remote = mk({ key: "AB-102", title: "other", externalRef: { source: "jira", key: "widget", url: null, raw: {} } });
  const title = mk({ key: "AB-101", title: "widget polish" });
  const spec = mk({ key: "AB-100", title: "unrelated", spec: "mentions widget deep inside" });
  const hits = store.tickets.search({ q: "widget" });
  expect(hits.tickets.map((t) => t.id)).toEqual([exact.id, keyPrefix.id, remote.id, title.id, spec.id]);
  expect(hits.total).toBe(5);
});

test("search needs every term, finds an old key after a rename, and treats FTS operators as text", () => {
  const { store, project } = setup();
  const a = addTicketWith(store, project, { title: "login page", spec: "oauth flow" });
  addTicketWith(store, project, { title: "login only" });
  expect(store.tickets.search({ q: "login oauth" }).tickets.map((t) => t.id)).toEqual([a.id]);
  expect(store.tickets.search({ q: 'login" OR (' }).total).toBe(0);
  store.projects.rekey(project.id, "ZZ");
  expect(store.tickets.search({ q: "AB-1" }).tickets.map((t) => t.id)).toContain(a.id);
});

test("search honours the project filter and keeps drafts out when asked", () => {
  const { store, project } = setup();
  const other = addProject(store, { key: "CD", path: "/other" });
  addTicketWith(store, project, { title: "shared term" });
  addTicketWith(store, project, { title: "shared term draft", draft: true });
  addTicketWith(store, other, { title: "shared term elsewhere" });
  expect(store.tickets.search({ q: "shared", projectId: project.id }).total).toBe(2);
  expect(store.tickets.search({ q: "shared", projectId: project.id, drafts: false }).total).toBe(1);
});

test("search pages across rank boundaries without repeating a ticket", () => {
  const { clock, store, project } = setup();
  for (let i = 0; i < 5; i++) {
    clock.advance(1);
    addTicketWith(store, project, { title: `needle ${i}` });
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = store.tickets.search({ q: "needle", limit: 2, cursor });
    seen.push(...page.tickets.map((t) => t.key));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toHaveLength(5);
  expect(new Set(seen).size).toBe(5);
});

test("the LIKE fallback (no FTS index) matches the same tickets", () => {
  const { store, project } = setup();
  const a = addTicketWith(store, project, { title: "needle in title" });
  addTicketWith(store, project, { title: "other" });
  store.db.exec("DROP TABLE ticket_fts; DROP TRIGGER ticket_fts_insert; DROP TRIGGER ticket_fts_delete; DROP TRIGGER ticket_fts_update;");
  // A fresh repo notices the missing index (it caches the check).
  const fresh = new (store.tickets.constructor as new (db: typeof store.db) => typeof store.tickets)(store.db);
  expect(fresh.search({ q: "need" }).tickets.map((t) => t.id)).toEqual([a.id]);
  expect(fresh.search({ q: "100%_" }).total).toBe(0);
});

test("a remote link is indexed by upper-cased key, can be changed and removed, and finds tickets newest first", () => {
  const { clock, store, project } = setup();
  const older = addTicketWith(store, project);
  clock.advance(5);
  const newer = addTicketWith(store, project, { draft: true });
  store.tickets.setExternalRef(older.id, { source: "jira", key: " foo-1 ", url: null, raw: {} });
  store.tickets.setExternalRef(newer.id, { source: "jira", key: "FOO-1", url: null, raw: {} });
  expect(store.tickets.get(older.id)!.externalRef!.key).toBe("FOO-1");
  expect(store.tickets.byExternalKey(" foo-1 ").map((t) => t.id)).toEqual([newer.id, older.id]);
  expect(store.tickets.byExternalKey("FOO-1", { drafts: false }).map((t) => t.id)).toEqual([older.id]);
  expect(store.tickets.byExternalKey("  ")).toEqual([]);
  store.tickets.setExternalRef(older.id, null);
  expect(store.tickets.byExternalKey("FOO-1").map((t) => t.id)).toEqual([newer.id]);
});

test("pull request links keep their titles when the list is reordered, report what was added and removed, and a failed fetch keeps the old title", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  const a = "https://github.com/o/r/pull/1";
  const b = "https://github.com/o/r/pull/2";
  expect(store.tickets.setPullRequestUrls(t.id, [a, b])).toMatchObject({ added: [a, b], removed: [] });
  expect(store.tickets.unfetchedPullRequestUrls().map((r) => r.url).sort()).toEqual([a, b]);
  store.tickets.applyPullRequestTitles(t.id, new Map([[a, "Title A"], [b, null]]), 99);
  expect(store.tickets.unfetchedPullRequestUrls()).toEqual([]);
  const re = store.tickets.setPullRequestUrls(t.id, [b, a])!;
  expect(re).toMatchObject({ added: [], removed: [] });
  expect(re.ticket.pullRequests).toEqual([{ url: b, title: null }, { url: a, title: "Title A" }]);
  expect(re.ticket.pullRequestUrl).toBe(a);
  store.tickets.applyPullRequestTitles(t.id, new Map([[a, null]]), 200);
  expect(store.tickets.get(t.id)!.pullRequests[1]!.title).toBe("Title A");
  expect(store.tickets.setPullRequestUrls(t.id, [b])).toMatchObject({ added: [], removed: [a] });
  // A title that arrives for a link removed meanwhile is dropped, not resurrected.
  store.tickets.applyPullRequestTitles(t.id, new Map([[a, "late"]]), 300);
  expect(store.tickets.get(t.id)!.pullRequests.map((p) => p.url)).toEqual([b]);
  expect(store.tickets.setPullRequestUrls("missing", [])).toBeNull();
});

test("one-time grants match on tool and canonical input, are consumed once, and a Bash description doesn't count", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  store.tickets.addGrant(t.id, "Bash", { command: "ls", description: "list" });
  store.tickets.addGrant(t.id, "Edit", { b: 2, a: { y: 1, x: undefined } });
  expect(store.tickets.consumeGrant(t.id, "Bash", { command: "ls", timeout: 5 })).toBe(true);
  expect(store.tickets.consumeGrant(t.id, "Bash", { command: "ls" })).toBe(false);
  expect(store.tickets.consumeGrant(t.id, "Edit", { a: { y: 1 }, b: 2 })).toBe(true);
  expect(store.tickets.consumeGrant(t.id, "Edit", { a: { y: 2 }, b: 2 })).toBe(false);
  expect(store.tickets.listGrants(t.id)).toEqual([]);
});

test("a Bash grant for a different command or sandbox flag doesn't match; dropGrants ignores used ones", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  store.tickets.addGrant(t.id, "Bash", { command: "ls" });
  store.tickets.addGrant(t.id, "Bash", { command: "pwd" });
  const [first, second] = store.tickets.listGrants(t.id);
  expect(store.tickets.consumeGrant(t.id, "Bash", { command: "ls", dangerouslyDisableSandbox: true })).toBe(false);
  store.tickets.dropGrants(t.id, [first!.id, 999]);
  expect(store.tickets.listGrants(t.id).map((g) => g.id)).toEqual([second!.id]);
  expect(grantKey("Bash", { command: "x", description: "d" })).toBe(grantKey("Bash", { command: "x" }));
  expect(grantKey("Read", { description: "d" })).not.toBe(grantKey("Read", {}));
  expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: undefined })).toBe('{"b":[{"c":2,"d":1}]}');
});

test("moveToProject renames the ticket and session, resets branch choices, aliases the old key and rewrites dependents", () => {
  const { store, project } = setup();
  const dest = addProject(store, { key: "CD", path: "/dest" });
  const t = addTicketWith(store, project, { draft: true, baseBranch: "dev", requestedBranch: "feat", useWorktree: false });
  const dependent = addTicketWith(store, project, { dependsOn: [t.key] });
  addTicketWith(store, dest);
  const out = store.tickets.moveToProject(t.id, dest.id, "cd-9");
  expect(out).toEqual({ from: "AB-1", to: "CD-9" });
  const moved = store.tickets.get(t.id)!;
  expect(moved).toMatchObject({ key: "CD-9", projectId: dest.id, baseBranch: null, useWorktree: null });
  expect(moved.position).toBe(2);
  expect(store.sessions.get(t.sessionId)!.key).toBe("CD-9");
  expect(store.tickets.getByKey("AB-1")!.id).toBe(t.id);
  expect(store.tickets.get(dependent.id)!.dependsOn).toEqual(["CD-9"]);
  expect(() => store.tickets.moveToProject("missing", dest.id, "X-1")).toThrow(/Unknown ticket/);
});

test("saving a message draft doesn't count as editing the ticket", () => {
  const { clock, store, project } = setup();
  const t = addTicketWith(store, project);
  clock.advance(50);
  const withDraft = store.tickets.setMessageDraft(t.id, { text: "hi", attachments: [] } as never)!;
  expect(withDraft.messageDraft).toMatchObject({ text: "hi" });
  expect(withDraft.updatedAt).toBe(t.updatedAt);
  expect(store.tickets.setMessageDraft(t.id, null)!.messageDraft).toBeNull();
});

test("a ticket's legacy driver follows its project's Work choice, then the settings'", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  expect(store.tickets.get(t.id)!.driver).toBe("claude-code");
  store.projects.update(project.id, { phaseModels: { work: { driver: "dummy", model: null } } });
  expect(store.tickets.get(t.id)!.driver).toBe("dummy");
  store.tickets.update(t.id, { phaseModels: { work: { driver: "copilot", model: "m" } } });
  expect(store.tickets.get(t.id)).toMatchObject({ driver: "copilot", model: "m" });
});

test("deleting a ticket removes its dependencies and grants; getBySession finds it by its session", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project, { dependsOn: ["AB-9"] });
  store.tickets.addGrant(t.id, "Bash", { command: "ls" });
  expect(store.tickets.getBySession(t.sessionId)!.id).toBe(t.id);
  store.tickets.delete(t.id);
  expect(store.tickets.get(t.id)).toBeNull();
  expect(store.tickets.listGrants(t.id)).toEqual([]);
  expect(store.tickets.dependents("AB-9")).toEqual([]);
  expect(store.tickets.reviewRejections(t.id)).toBe(0);
});
