import { describe, expect, test } from "bun:test";
import { HarnessApiError, type RelatedTicket, type Ticket } from "@harness/shared";
import { liveRelatedTickets, remoteIdCheck, remoteKeyMatches } from "./remoteIds";

const ref = (key: string) => ({ source: "jira", key, url: null, raw: null });
const tk = (id: string, key: string, remote: string | null, extra: Partial<Ticket> = {}): Ticket =>
  ({ id, key, title: `${key} title`, status: "in_progress", projectId: "p", externalRef: remote ? ref(remote) : null, createdAt: 0, draft: false, ...extra }) as Ticket;
const store = (...ts: Ticket[]) => ({ tickets: Object.fromEntries(ts.map((t) => [t.id, t])), keyAliases: {} as Record<string, string> });
const rel = (key: string, externalKey: string, extra: Partial<RelatedTicket> = {}): RelatedTicket => ({ key, title: `${key} (fetched)`, status: "planning", projectId: "p", externalKey, ...extra });

describe("remoteKeyMatches", () => {
  const matches = { requested: "OPS-41", relatedTickets: [rel("MH-131", "OPS-41")] };

  test("a 404 carrying related tickets is a remote ID", () => {
    expect(remoteKeyMatches(new HarnessApiError(404, "OPS-41 is a remote ID", matches))).toEqual(matches);
  });

  test("anything else is a plain failure", () => {
    expect(remoteKeyMatches(new HarnessApiError(404, "Ticket NOPE-1 not found"))).toBeNull();
    expect(remoteKeyMatches(new HarnessApiError(404, "x", { requested: "OPS-41", relatedTickets: [] }))).toBeNull();
    expect(remoteKeyMatches(new HarnessApiError(404, "x", { requested: "OPS-41" }))).toBeNull();
    expect(remoteKeyMatches(new HarnessApiError(500, "x", matches))).toBeNull();
    expect(remoteKeyMatches(new Error("network down"))).toBeNull();
  });
});

describe("liveRelatedTickets", () => {
  test("a loaded ticket's live title and status replace the fetched ones", () => {
    const s = store(tk("1", "MH-124", "MH-62", { status: "review", title: "Renamed" }));
    expect(liveRelatedTickets(s, ["MH-130", "MH-62"], [rel("MH-124", "MH-62")])).toEqual([{ key: "MH-124", title: "Renamed", status: "review", projectId: "p", externalKey: "MH-62" }]);
  });

  test("a loaded ticket that has been unlinked since the fetch drops out", () => {
    const s = store(tk("1", "MH-124", null));
    expect(liveRelatedTickets(s, ["MH-62"], [rel("MH-124", "MH-62")])).toEqual([]);
  });

  test("a ticket linked since the fetch joins at the front; self and drafts stay out", () => {
    const self = tk("0", "MH-62", null);
    const s = store(self, tk("1", "MH-124", "mh-62", { createdAt: 5 }), tk("2", "MH-140", "MH-62", { draft: true }), tk("3", "MH-9", "OTHER-1"));
    const out = liveRelatedTickets(s, [self.key, null], [rel("MH-130", "MH-62")], self);
    expect(out.map((r) => r.key)).toEqual(["MH-124", "MH-130"]);
  });

  test("fetched tickets that aren't loaded stay, once each, in the service's order", () => {
    const out = liveRelatedTickets(store(), ["OPS-41"], [rel("MH-132", "OPS-41"), rel("MH-131", "OPS-41"), rel("MH-132", "OPS-41")]);
    expect(out.map((r) => r.key)).toEqual(["MH-132", "MH-131"]);
  });

  test("no identifiers, no related tickets", () => {
    expect(liveRelatedTickets(store(tk("1", "MH-124", "MH-62")), [null, undefined], [rel("MH-124", "MH-62")])).toEqual([]);
  });
});

describe("remoteIdCheck", () => {
  const linked = { key: "MH-62", url: "https://jira.example/MH-62" };

  test("a valid key is upper-cased and trimmed; a blank link is null", () => {
    expect(remoteIdCheck("  mh-62 ", "  ", null)).toEqual({ input: { key: "MH-62", url: null }, error: null, dirty: true });
  });

  test("a key that isn't FOO-123 shaped is refused, like Depends on", () => {
    const c = remoteIdCheck("MH62", "", null);
    expect(c.input).toBeNull();
    expect(c.error).toContain("MH62");
  });

  test("a link has to be http(s)", () => {
    expect(remoteIdCheck("MH-62", "jira.example/MH-62", null).error).toContain("http");
    expect(remoteIdCheck("MH-62", "HTTPS://jira.example/MH-62", null).input?.url).toBe("HTTPS://jira.example/MH-62");
  });

  test("the current link, however it's typed, isn't a change; a new URL is", () => {
    expect(remoteIdCheck("mh-62", linked.url, linked).dirty).toBe(false);
    expect(remoteIdCheck("MH-62", "", linked)).toEqual({ input: { key: "MH-62", url: null }, error: null, dirty: true });
  });

  test("an empty key is never a save: no error unless a link was typed for an unlinked ticket", () => {
    expect(remoteIdCheck("", "", linked)).toEqual({ input: null, error: null, dirty: false });
    expect(remoteIdCheck("", "", null)).toEqual({ input: null, error: null, dirty: false });
    expect(remoteIdCheck("", "https://x.example", null).error).toBeTruthy();
  });
});
