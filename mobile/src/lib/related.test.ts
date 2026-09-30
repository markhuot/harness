import { expect, test } from "bun:test";
import { HarnessApiError, isTicketKey, type RelatedTicket, type Ticket } from "@harness/shared";
import { relatedLabel, relatedOf, remoteIdPatch, remoteMatchesOf } from "./related";

let n = 0;
const tk = (key: string, remote: string | null, extra: Partial<Ticket> = {}): Ticket =>
  ({
    id: `id-${key}`,
    key,
    title: key,
    status: "in_progress",
    projectId: "p",
    createdAt: ++n,
    externalRef: remote ? { source: "jira", key: remote, url: null, raw: null } : null,
    ...extra,
  }) as Ticket;
const rel = (key: string, externalKey: string, extra: Partial<RelatedTicket> = {}): RelatedTicket => ({ key, title: key, status: "done", projectId: "p", externalKey, ...extra });
const byId = (...ts: Ticket[]) => Object.fromEntries(ts.map((t) => [t.id, t]));

test("a native MH-62 lists the tickets linked to Jira MH-62, newest first, and not itself", () => {
  const native = tk("MH-62", null);
  const a = tk("MH-124", "MH-62");
  const b = tk("MH-130", "mh-62");
  const other = tk("MH-131", "MH-99");
  expect(relatedOf(byId(native, a, b, other), native, []).map((r) => r.key)).toEqual(["MH-130", "MH-124"]);
});

test("a linked ticket lists the other tickets on its remote ID, skipping drafts", () => {
  const a = tk("MH-124", "MH-62");
  const b = tk("MH-130", "MH-62");
  const draft = tk("MH-131", "MH-62", { draft: true });
  expect(relatedOf(byId(a, b, draft), a, undefined).map((r) => r.key)).toEqual(["MH-130"]);
});

test("a fetched (unloaded) entry stays; a loaded one that was unlinked since drops out", () => {
  const a = tk("MH-124", "MH-62");
  const unlinked = tk("MH-130", null);
  const fetched = [rel("MH-130", "MH-62"), rel("MH-12", "MH-62", { status: "done" }), rel("MH-124", "MH-62")];
  expect(relatedOf(byId(a, unlinked), a, fetched).map((r) => r.key)).toEqual(["MH-12"]);
});

test("a loaded ticket's live status replaces the fetched one", () => {
  const a = tk("MH-124", "MH-62");
  const b = tk("MH-130", "MH-62", { status: "review", title: "Stage 2" });
  const [only] = relatedOf(byId(a, b), a, [rel("MH-130", "MH-62", { status: "planning", title: "old" })]);
  expect(only).toMatchObject({ key: "MH-130", status: "review", title: "Stage 2" });
});

test("relatedLabel shows the remote ID first and the local key after it", () => {
  expect(relatedLabel(rel("MH-124", "MH-62"))).toBe("MH-62 · MH-124");
  // A legacy mirror (key == remote ID) shows once.
  expect(relatedLabel(rel("JIRA-9", "JIRA-9"))).toBe("JIRA-9");
});

test("remoteMatchesOf reads a 404's RemoteKeyMatches and ignores other errors", () => {
  const data = { requested: "JIRA-9", relatedTickets: [rel("MH-124", "JIRA-9")] };
  expect(remoteMatchesOf(new HarnessApiError(404, "Unknown ticket", data))).toEqual(data);
  expect(remoteMatchesOf(new HarnessApiError(404, "Unknown ticket"))).toBeNull();
  expect(remoteMatchesOf(new HarnessApiError(404, "Unknown ticket", { requested: "JIRA-9", relatedTickets: [] }))).toBeNull();
  expect(remoteMatchesOf(new HarnessApiError(500, "boom", data))).toBeNull();
  expect(remoteMatchesOf(new Error("offline"))).toBeNull();
});

test("remoteIdPatch links, relinks, unlinks and refuses bad input", () => {
  const none = null;
  const linked = { key: "MH-62", url: "https://jira/MH-62" };
  expect(remoteIdPatch(none, { key: " mh-62 ", url: "" }, isTicketKey)).toEqual({ externalRef: { key: "MH-62", url: null } });
  expect(remoteIdPatch(linked, { key: "MH-62", url: "https://jira/MH-62" }, isTicketKey)).toBeUndefined();
  expect(remoteIdPatch(linked, { key: "MH-62", url: "" }, isTicketKey)).toEqual({ externalRef: { key: "MH-62", url: null } });
  expect(remoteIdPatch(linked, { key: "MH-63", url: "https://jira/MH-62" }, isTicketKey)).toEqual({ externalRef: { key: "MH-63", url: "https://jira/MH-62" } });
  expect(remoteIdPatch(linked, { key: "", url: "" }, isTicketKey)).toEqual({ externalRef: null });
  expect(remoteIdPatch(none, { key: "", url: "" }, isTicketKey)).toBeUndefined();
  expect(remoteIdPatch(none, { key: "", url: "https://x" }, isTicketKey)).toHaveProperty("error");
  expect(remoteIdPatch(none, { key: "not a key", url: "" }, isTicketKey)).toEqual({ error: "Not a ticket key: NOT A KEY" });
  expect(remoteIdPatch(none, { key: "MH-62", url: "jira/MH-62" }, isTicketKey)).toHaveProperty("error");
});
