import { expect, test } from "bun:test";
import "../../../service/src/store/labels";
import type { LabelRepo } from "../../../service/src/store/labels";
import { fakeClock } from "../../builders/clock";
import { addProject, makeStore } from "../../builders/store";
import { addTicketWith } from "../../builders/ticket-input";

const setup = () => {
  const clock = fakeClock(10_000);
  const store = makeStore({ now: clock });
  const project = addProject(store, { key: "AB" });
  const other = addProject(store, { key: "CD" });
  return { clock, store, project, other };
};

const countOf = (labels: LabelRepo, name: string) => labels.list().find((l) => l.name === name)?.count;

const keys = (page: { tickets: { key: string }[] }) => page.tickets.map((t) => t.key).sort();

test("labels dedupe without regard to case, keep the first spelling, and keep a new label's color from its name", () => {
  const { store, project } = setup();
  const a = addTicketWith(store, project);
  const b = addTicketWith(store, project);
  store.labels.setForTicket(a.id, ["Bugfix", "bugfix ", "  Release   1.2.3 "]);
  store.labels.setForTicket(b.id, ["BUGFIX"]);
  expect(store.tickets.get(a.id)!.labels).toEqual(["Bugfix", "Release 1.2.3"]);
  expect(store.tickets.get(b.id)!.labels).toEqual(["Bugfix"]);
  expect(store.labels.list().map((l) => l.name).sort()).toEqual(["Bugfix", "Release 1.2.3"]);
});

test("setForTicket keeps the order of labels a ticket keeps, appends new ones, and says what changed", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  store.labels.setForTicket(t.id, ["A", "B", "C"]);
  const r = store.labels.setForTicket(t.id, ["C", "D", "A"]);
  expect(r).toMatchObject({ labels: ["A", "C", "D"], added: ["D"], removed: ["B"], changed: true });
  expect(store.labels.setForTicket(t.id, ["A", "C", "D"]).changed).toBe(false);
  expect(store.labels.setForTicket(t.id, []).labels).toEqual([]);
});

test("the collection is sorted by last use: adding a label to a ticket moves it to the front", () => {
  const { clock, store, project } = setup();
  const t = addTicketWith(store, project);
  store.labels.setForTicket(t.id, ["Old"]);
  clock.advance(100);
  store.labels.setForTicket(t.id, ["Old", "Newer"]);
  expect(store.labels.list().map((l) => l.name)).toEqual(["Newer", "Old"]);
  clock.advance(100);
  const u = addTicketWith(store, project);
  store.labels.setForTicket(u.id, ["Old"]);
  expect(store.labels.list().map((l) => l.name)).toEqual(["Old", "Newer"]);
});

test("a label's count is its tickets in every status, done included, across projects, never drafts", () => {
  const { store, project, other } = setup();
  const planning = addTicketWith(store, project);
  const working = addTicketWith(store, project, { status: "in_progress" });
  const blocked = addTicketWith(store, other, { status: "blocked" });
  const review = addTicketWith(store, other, { status: "review" });
  const done = addTicketWith(store, other, { status: "done" });
  const draft = addTicketWith(store, project, { draft: true });
  for (const t of [planning, working, blocked, review, done, draft]) store.labels.setForTicket(t.id, ["Shared"]);
  expect(countOf(store.labels, "Shared")).toBe(5);
  store.tickets.update(planning.id, { status: "done" });
  expect(countOf(store.labels, "Shared")).toBe(5);
});

test("a label with no tickets stays, so its color survives, and recoloring changes only that label", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  store.labels.setForTicket(t.id, ["Keep", "Other"]);
  const before = store.labels.list().find((l) => l.name === "Other")!.color;
  store.labels.setForTicket(t.id, []);
  expect(store.labels.list().map((l) => l.name).sort()).toEqual(["Keep", "Other"]);
  const color = before === "teal" ? "pink" : "teal";
  expect(store.labels.setColor("keep", color)).toMatchObject({ name: "Keep", color });
  expect(store.labels.list().find((l) => l.name === "Other")!.color).toBe(before);
  expect(store.labels.setColor("Missing", "teal")).toBeNull();
});

test("deleting a ticket removes its label links but not the label", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  store.labels.setForTicket(t.id, ["Gone"]);
  store.db.exec("PRAGMA foreign_keys = OFF");
  store.tickets.delete(t.id);
  expect(store.db.query("SELECT COUNT(*) AS n FROM ticket_labels").get()).toEqual({ n: 0 });
  expect(store.labels.list()).toHaveLength(1);
});

test("plain text search finds label names and follows adds and removes", () => {
  const { store, project } = setup();
  const a = addTicketWith(store, project, { title: "Fix login" });
  const b = addTicketWith(store, project, { title: "Fix logout" });
  store.labels.setForTicket(a.id, ["Bugfix"]);
  expect(keys(store.tickets.search({ q: "bugfix" }))).toEqual([a.key]);
  expect(keys(store.tickets.search({ q: "bug" }))).toEqual([a.key]);
  store.labels.setForTicket(b.id, ["Bugfix"]);
  store.labels.setForTicket(a.id, []);
  expect(keys(store.tickets.search({ q: "bugfix" }))).toEqual([b.key]);
});

test("label: qualifiers AND together, match any case, and combine with project: and text", () => {
  const { store, project, other } = setup();
  const a = addTicketWith(store, project, { title: "alpha crash" });
  const b = addTicketWith(store, project, { title: "beta crash" });
  const c = addTicketWith(store, other, { title: "gamma crash" });
  store.labels.setForTicket(a.id, ["Release 1.2.3", "Bugfix"]);
  store.labels.setForTicket(b.id, ["Release 1.2.3"]);
  store.labels.setForTicket(c.id, ["Bugfix", "Reference"]);
  const q = (text: string) => keys(store.tickets.search({ q: text }));
  expect(q('label:"Release 1.2.3"')).toEqual([a.key, b.key]);
  expect(q('label:"release 1.2.3" label:bugfix')).toEqual([a.key]);
  expect(q("label:Bugfix project:cd")).toEqual([c.key]);
  expect(q("project:AB project:CD label:Bugfix")).toEqual([a.key, c.key]);
  expect(q("project:AB project:CD")).toEqual([a.key, b.key, c.key]);
  expect(q("label:Bugfix gamma")).toEqual([c.key]);
  expect(q("label:Bugfix zzz")).toEqual([]);
  expect(q("label:Nope")).toEqual([]);
});

test("a bare, unclosed or unknown qualifier never reaches the text search as syntax", () => {
  const { store, project } = setup();
  const a = addTicketWith(store, project, { title: "needle" });
  store.labels.setForTicket(a.id, ["Bugfix"]);
  const total = (q: string) => store.tickets.search({ q }).total;
  expect(total("label:")).toBe(1); // still typing: filters nothing
  expect(total('label:"Bug')).toBe(0); // an unclosed quote is the value so far, and no label is named Bug
  expect(total('label:"Bugfix')).toBe(1);
  expect(total("needle label:")).toBe(1);
  expect(total("foo:bar")).toBe(0); // an unknown qualifier is plain text
  expect(total('title:needle "')).toBe(0);
});

test("a qualifier-only search lists by last change and pages without repeats", () => {
  const { clock, store, project } = setup();
  const made = [0, 1, 2, 3, 4].map(() => {
    clock.advance(10);
    const t = addTicketWith(store, project);
    store.labels.setForTicket(t.id, ["Page"]);
    return t;
  });
  clock.advance(10);
  store.tickets.update(made[0]!.id, { title: "touched" }); // moves to the front
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = store.tickets.search({ q: "label:Page", limit: 2, cursor });
    seen.push(...page.tickets.map((t) => t.key));
    expect(page.total).toBe(5);
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual([made[0], made[4], made[3], made[2], made[1]].map((t) => t!.key));
});

test("page narrows a column by qualifiers too", () => {
  const { store, project, other } = setup();
  const a = addTicketWith(store, project);
  const b = addTicketWith(store, other);
  store.labels.setForTicket(a.id, ["X"]);
  store.labels.setForTicket(b.id, ["X"]);
  const page = store.tickets.page({ status: "planning", q: "label:X project:CD" });
  expect(page.tickets.map((t) => t.key)).toEqual([b.key]);
  expect(page.total).toBe(1);
});

test("remove deletes the label, drops it from every ticket, returns who carried it, and leaves search clean", () => {
  const { store, project, other } = setup();
  const a = addTicketWith(store, project);
  const b = addTicketWith(store, other, { status: "done" });
  const c = addTicketWith(store, project);
  store.labels.setForTicket(a.id, ["Bugfix", "Docs"]);
  store.labels.setForTicket(b.id, ["bugfix"]);
  store.labels.setForTicket(c.id, ["Docs"]);
  expect(keys(store.tickets.search({ q: "label:bugfix" }))).toEqual([a.key, b.key].sort());

  const ids = store.labels.remove("BUGFIX");
  expect(ids?.sort()).toEqual([a.id, b.id].sort());
  expect(store.labels.list().map((l) => l.name)).toEqual(["Docs"]);
  expect(store.tickets.get(a.id)!.labels).toEqual(["Docs"]);
  expect(store.tickets.get(b.id)!.labels).toEqual([]);
  expect(keys(store.tickets.search({ q: "label:bugfix" }))).toEqual([]);
  expect(keys(store.tickets.search({ q: "bugfix" }))).toEqual([]);
  expect(keys(store.tickets.search({ q: "label:docs" }))).toEqual([a.key, c.key].sort());
});

test("remove of an unused label returns no tickets, and of an unknown one returns null", () => {
  const { store, project } = setup();
  const t = addTicketWith(store, project);
  store.labels.setForTicket(t.id, ["Idle"]);
  store.labels.setForTicket(t.id, []);
  expect(store.labels.remove("Idle")).toEqual([]);
  expect(store.labels.list()).toEqual([]);
  expect(store.labels.remove("Idle")).toBeNull();
});

test("a deleted label can be created again, as a fresh label", () => {
  const { clock, store, project } = setup();
  const t = addTicketWith(store, project);
  store.labels.setForTicket(t.id, ["Bugfix"]);
  store.labels.remove("Bugfix");
  clock.advance(5);
  store.labels.setForTicket(t.id, ["bugfix"]);
  expect(store.labels.list()).toMatchObject([{ name: "bugfix", count: 1 }]);
});
