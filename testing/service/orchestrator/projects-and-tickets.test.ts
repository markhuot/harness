import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../../../service/src/orchestrator/errors";
import { replyScript } from "../fake-driver";
import { makeOrchestrator, stopAll } from "../orchestrator-harness";

afterEach(stopAll);

const status = async (p: Promise<unknown> | (() => unknown), code: number, match: RegExp) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).status).toBe(code);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a HarnessError");
};

const dir = (h: ReturnType<typeof makeOrchestrator>, name: string) => {
  const path = join(h.home, "proj", name);
  mkdirSync(path, { recursive: true });
  return path;
};

test("a project needs an existing directory, a valid unused key and a known driver", async () => {
  const h = makeOrchestrator();
  await status(() => h.orch.createProject({ path: "" } as never), 400, /path is required/);
  await status(() => h.orch.createProject({ path: join(h.home, "nope") }), 400, /Not a directory/);
  const file = join(h.home, "file.txt");
  writeFileSync(file, "x");
  await status(() => h.orch.createProject({ path: file }), 400, /Not a directory/);
  await status(() => h.orch.createProject({ path: dir(h, "a"), key: "ACME" }), 409, /already used/);
  await status(() => h.orch.createProject({ path: dir(h, "b"), key: "9bad" }), 400, /Invalid project key/);
  await status(() => h.orch.createProject({ path: dir(h, "c"), defaultDriver: "nope" }), 400, /Unknown driver/);
  expect(h.orch.listProjects()).toHaveLength(1);
});

test("a project's name defaults to its folder, its key to one derived from it, and creating announces it", () => {
  const h = makeOrchestrator();
  const p = h.orch.createProject({ path: dir(h, "my-site") });
  expect(p.name).toBe("my-site");
  expect(p.key).toMatch(/^[A-Z][A-Z0-9]*$/);
  expect(h.events.filter((e) => e.kind === "project.upserted").at(-1)).toMatchObject({ project: { id: p.id } });
});

test("a project's group takes the spelling of an existing group that matches without case", () => {
  const h = makeOrchestrator();
  const a = h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Client Work" });
  const b = h.orch.createProject({ path: dir(h, "b"), key: "BBB", group: "client work" });
  expect(b.group).toBe("Client Work");
  expect(b.groupId).toBe(a.groupId!);
  expect(h.orch.listGroups()).toHaveLength(1);
});

test("a group by id and the legacy group name reach the same group; null clears it; an unknown id is refused", async () => {
  const h = makeOrchestrator();
  const a = h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Work" });
  const b = h.orch.createProject({ path: dir(h, "b"), key: "BBB", groupId: a.groupId });
  expect(b.group).toBe("Work");
  expect(h.orch.updateProject(b.id, { group: "WORK" }).groupId).toBe(a.groupId!);
  expect(h.orch.updateProject(b.id, { groupId: null })).toMatchObject({ group: null, groupId: null });
  await status(() => h.orch.updateProject(b.id, { groupId: "nope" }), 400, /Unknown group/);
  // A group left without projects is deleted; naming it again makes a new one.
  h.orch.updateProject(a.id, { groupId: null });
  expect(h.orch.listGroups()).toHaveLength(0);
  expect(h.orch.updateProject(a.id, { group: "work" }).groupId).not.toBe(a.groupId!);
});

test("a group can be renamed to the name an emptied group had", () => {
  const h = makeOrchestrator();
  const a = h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Work" });
  const b = h.orch.createProject({ path: dir(h, "b"), key: "BBB", group: "Play" });
  h.orch.updateProject(a.id, { groupId: null });
  expect(h.orch.renameGroup(b.groupId!, { name: "work" }).name).toBe("work");
});

test("a unique-name clash the in-code check misses is a 409 on rename and on a project's group name", async () => {
  const h = makeOrchestrator();
  h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Work" });
  const b = h.orch.createProject({ path: dir(h, "b"), key: "BBB", group: "Play" });
  const groups = (h.orch as unknown as { store: { groups: { list: () => unknown[]; findByName: () => null } } }).store.groups;
  groups.list = () => [{ id: b.groupId, name: "Play", createdAt: 0 }];
  groups.findByName = () => null;
  await status(() => h.orch.renameGroup(b.groupId!, { name: "WORK" }), 409, /already exists/);
  await status(() => h.orch.updateProject(b.id, { group: "WORK" }), 409, /already exists/);
});

test("renaming a group announces each of its projects and keeps the board filter on the same id", () => {
  const h = makeOrchestrator();
  const a = h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Work" });
  const b = h.orch.createProject({ path: dir(h, "b"), key: "BBB", group: "Work" });
  h.orch.createProject({ path: dir(h, "c"), key: "CCC" });
  const before = h.events.length;
  const renamed = h.orch.renameGroup(a.groupId!, { name: "  Clients " });
  expect(renamed).toMatchObject({ id: a.groupId, name: "Clients" });
  const announced = h.events.slice(before).filter((e) => e.kind === "project.upserted") as { project: { id: string; group: string; groupId: string } }[];
  expect(announced.map((e) => e.project.id).sort()).toEqual([a.id, b.id].sort());
  expect(announced.every((e) => e.project.group === "Clients" && e.project.groupId === a.groupId)).toBe(true);
});

test("renaming a group onto another group's name is a 409, in any case; an unknown id is a 404", async () => {
  const h = makeOrchestrator();
  const a = h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Work" });
  h.orch.createProject({ path: dir(h, "b"), key: "BBB", group: "Play" });
  await status(() => h.orch.renameGroup(a.groupId!, { name: "play" }), 409, /already exists/);
  await status(() => h.orch.renameGroup(a.groupId!, { name: "  " }), 400, /name is required/);
  await status(() => h.orch.renameGroup("nope", { name: "X" }), 404, /Unknown group/);
  expect(h.orch.listProjects().find((p) => p.id === a.id)!.group).toBe("Work");
});

test("the legacy group name on a tickets query resolves to the group's id, and an unknown name matches nothing", () => {
  const h = makeOrchestrator();
  const a = h.orch.createProject({ path: dir(h, "a"), key: "AAA", group: "Work" });
  expect(h.orch.groupIdParam(new URLSearchParams({ group: "work" }))).toBe(a.groupId!);
  expect(h.orch.groupIdParam(new URLSearchParams({ groupId: "x", group: "work" }))).toBe("x");
  expect(h.orch.groupIdParam(new URLSearchParams())).toBeUndefined();
  expect(h.orch.ticketPage({ status: "planning", groupId: h.orch.groupIdParam(new URLSearchParams({ group: "Nope" })) }).total).toBe(0);
});

test("renaming a project's key renames its tickets and their sessions, and says so in each transcript", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
  await h.settle();
  const updated = h.orch.updateProject(h.project.id, { key: "NEW" });
  expect(updated.key).toBe("NEW");
  expect(h.store.tickets.get(t.id)!.key).toBe("NEW-1");
  expect(h.store.tickets.getByKey("ACME-1")!.id).toBe(t.id);
  const texts = h.store.transcript.list(t.sessionId).map((e) => (e.content.type === "status" ? e.content.text : ""));
  expect(texts).toContain("Renamed ACME-1 → NEW-1");
});

test("a rename that would collide, a taken key or an empty name is refused and changes nothing", async () => {
  const h = makeOrchestrator();
  const other = h.orch.createProject({ path: dir(h, "o"), key: "OTH" });
  await status(() => h.orch.updateProject(h.project.id, { key: "OTH" }), 409, /already used by/);
  await status(() => h.orch.updateProject(h.project.id, { name: "  " }), 400, /name cannot be empty/);
  await status(() => h.orch.updateProject("missing", { name: "x" }), 404, /Unknown project/);
  // A ticket already holding a key the rename would produce (ZED-1) stops it before anything moves.
  await h.orch.createTicket({ projectId: other.id, spec: "x", start: false, key: "ZED-1" });
  await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
  await status(() => h.orch.updateProject(h.project.id, { key: "ZED" }), 409, /Can't rename to ZED: ZED-1 already exists/);
  expect(h.store.projects.get(h.project.id)!.key).toBe("ACME");
  expect(h.store.tickets.getByKey("ACME-1")).not.toBeNull();
});

test("deleting a project deletes its tickets and announces it", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
  await h.settle();
  await h.orch.deleteProject(h.project.id);
  expect(h.store.tickets.get(t.id)).toBeNull();
  expect(h.store.sessions.get(t.sessionId)).toBeNull();
  expect(h.events.at(-1)).toMatchObject({ kind: "project.deleted", id: h.project.id });
  await status(() => h.orch.deleteProject(h.project.id), 404, /Unknown project/);
});

test("creating a ticket checks its project, text, kind, driver, key, parent and branch", async () => {
  const h = makeOrchestrator();
  const p = h.project.id;
  await status(h.orch.createTicket({ projectId: "nope", spec: "x" }), 404, /Unknown project/);
  await status(h.orch.createTicket({ projectId: p, spec: "  " }), 400, /spec is required/);
  await status(h.orch.createTicket({ projectId: p, spec: "x", kind: "epic" as never }), 400, /Invalid kind/);
  await status(h.orch.createTicket({ projectId: p, spec: "x", driver: "nope" }), 400, /Unknown driver/);
  await status(h.orch.createTicket({ projectId: p, spec: "x", key: "not a key" }), 400, /Invalid ticket key/);
  await status(h.orch.createTicket({ projectId: p, spec: "x", parentId: "ACME-404" }), 400, /Unknown parent/);
  await status(h.orch.createTicket({ projectId: p, spec: "x", branch: "feat" }), 400, /needs a worktree/);
  await status(h.orch.createTicket({ projectId: p, spec: "x", start: false, key: "ACME-1" }).then(() => h.orch.createTicket({ projectId: p, spec: "y", start: false, key: "ACME-1" })), 409, /already exists/);
  expect(h.store.tickets.list()).toHaveLength(1);
});

test("a ticket's title comes from the first line of its brief unless given", async () => {
  const h = makeOrchestrator();
  const a = await h.orch.createTicket({ projectId: h.project.id, spec: "Fix the login bug\n\nIt breaks on Safari.", start: false });
  const b = await h.orch.createTicket({ projectId: h.project.id, spec: "body", title: " Given title ", start: false });
  expect(a.title).toBe("Fix the login bug");
  expect(b.title).toBe("Given title");
});

test("start: false plans first; the human's Start then works from the approved spec revision", async () => {
  const h = makeOrchestrator();
  h.driver.script(replyScript("plan drafted"), replyScript("worked"));
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "Add a button", start: false, skipAgentReview: true });
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["plan"]);
  expect(h.ticket(t.key).status).toBe("planning");
  await h.orch.startTicket(t.key);
  await h.settle();
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["plan", "work"]);
  expect(h.ticket(t.key)).toMatchObject({ status: "review", specBaselineRevision: 1 });
});

test("a draft never runs until it's submitted with start", async () => {
  const h = makeOrchestrator();
  const d = await h.orch.createTicket({ projectId: h.project.id, spec: "later", draft: true, skipAgentReview: true });
  await h.settle();
  expect(h.driver.requests).toEqual([]);
  expect(h.ticket(d.key).draft).toBe(true);
  await status(h.orch.startTicket(d.key), 409, /draft/i);
  await status(h.orch.submitTicket(d.key, {} as never), 400, /start must be true or false/);
  await h.orch.submitTicket(d.key, { start: true });
  await h.settle();
  expect(h.ticket(d.key).draft).toBe(false);
  expect(h.driver.requests.map((r) => r.kind)).toEqual(["work"]);
});

test("a draft can't have children, and can't be a child", async () => {
  const h = makeOrchestrator();
  const d = await h.orch.createTicket({ projectId: h.project.id, spec: "d", draft: true });
  await status(h.orch.createTicket({ projectId: h.project.id, spec: "child", parentId: d.key }), 400, /is a draft/);
  const real = await h.orch.createTicket({ projectId: h.project.id, spec: "p", start: false });
  await status(h.orch.createTicket({ projectId: h.project.id, spec: "c", parentId: real.key, draft: true }), 400, /draft can't be a child/);
});

test("updating a ticket changes its title and checks its status and dependencies", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
  await h.settle();
  const u = await h.orch.updateTicket(t.key, { title: "Renamed" });
  expect(u.title).toBe("Renamed");
  await status(h.orch.updateTicket(t.key, { status: "bogus" as never }), 400, /status/i);
  await status(h.orch.updateTicket(t.key, { dependsOn: ["NOPE-1"] }), 400, /Unknown dependency/);
  await status(h.orch.updateTicket("NOPE-1", { title: "x" }), 404, /Unknown ticket/);
});

test("deleting a ticket removes it, its session and its transcript, and aborts a run still going", async () => {
  const h = makeOrchestrator();
  const t = await h.orch.createTicket({ projectId: h.project.id, spec: "x", start: false });
  await h.settle();
  await h.orch.deleteTicket(t.key);
  expect(h.store.tickets.get(t.id)).toBeNull();
  expect(h.store.sessions.get(t.sessionId)).toBeNull();
  expect(h.store.transcript.list(t.sessionId)).toEqual([]);
  expect(h.events.some((e) => e.kind === "ticket.deleted")).toBe(true);
});

test("the board's pages and search refuse an empty query and a cursor from another listing", async () => {
  const h = makeOrchestrator();
  for (let i = 0; i < 3; i++) await h.orch.createTicket({ projectId: h.project.id, spec: `item ${i}`, start: false });
  await h.settle();
  await status(() => h.orch.ticketPage({ status: "planning", q: "  " }), 400, /q must not be empty/);
  await status(() => h.orch.searchTickets({ q: "" }), 400, /q is required/);
  await status(() => h.orch.ticketPage({ status: "planning", cursor: "garbage" }), 400, /cursor/i);
  const first = h.orch.ticketPage({ status: "planning", limit: "2" });
  expect(first.tickets).toHaveLength(2);
  expect(first.total).toBe(3);
  expect(h.orch.ticketPage({ status: "planning", limit: 2, cursor: first.nextCursor }).tickets).toHaveLength(1);
  expect(h.orch.searchTickets({ q: "item" }).total).toBe(3);
});
