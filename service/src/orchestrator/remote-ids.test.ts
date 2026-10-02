// Remote IDs (DESIGN.md "Remote IDs"): a ticket's key is its only identity; the remote item it's
// linked to (externalRef.key) is shown in its place but never looks a ticket up. Triage links new
// tickets to remote IDs and only reaches an existing ticket through ticket_key; get_ticket and
// GET /tickets/:key point from a remote ID to the tickets carrying it.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessEvent, RemoteKeyMatches, Ticket } from "@harness/shared";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { fakeContext, fakeSession } from "../tools/fakes";
import { allTools } from "../tools";
import type { HarnessOps, ToolContext } from "../tools/types";
import { RemoteIdError } from "../tools/util";

const jira = (key: string) => ({ source: "jira", key, url: `https://jira/${key}`, raw: null });

async function setup() {
  const h = makeOrchestrator({ driver: new FakeDriver() });
  const dir = join(h.home, "proj", "mh");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir, key: "MH" });
  const make = async (title: string, extra: { key?: string; remote?: string; draft?: boolean } = {}) => {
    const t = await h.orch.createTicket({
      projectId: project.id,
      spec: title,
      title,
      start: false,
      key: extra.key,
      draft: extra.draft,
      externalRef: extra.remote ? jira(extra.remote) : null,
    });
    await h.orch.idle();
    return h.store.tickets.get(t.id)!;
  };
  const ctx = (ticket: Ticket): ToolContext =>
    fakeContext({ runKind: "work", ticket, session: fakeSession({ id: ticket.sessionId, key: ticket.key, ticketId: ticket.id }), ops: h.orch.ops });
  /** Run one triage whose agent makes these dispatch calls; returns the outcome, errors, and the prompt it got. */
  const triage = async (text: string, calls: Parameters<HarnessOps["dispatchTicket"]>[1][]) => {
    const errors: string[] = [];
    let prompt = "";
    h.driver.script = async function* (req) {
      if (req.kind !== "triage") return;
      prompt = req.prompt;
      for (const c of calls) await req.toolContext.ops.dispatchTicket(req.toolContext, c).catch((e: Error) => errors.push(e.message));
      if (errors.length && errors.length === calls.length) await req.toolContext.ops.declineWork(req.toolContext, "failed");
    };
    const s = h.orch.triage({ source: "jira", output: { text, truncated: false }, prompt: "", driver: h.driver.id });
    await h.orch.idle();
    h.driver.script = null;
    return { outcome: h.orch.getSession(s.id).outcome, errors, prompt };
  };
  const byId = (t: Ticket) => h.store.tickets.get(t.id)!;
  return { ...h, project, make, ctx, triage, byId };
}

const dispatch = (extra: { key?: string; ticketKey?: string; url?: string }) => ({ projectKey: "MH", title: "Jira update", spec: "Handle the update", ...extra });

describe("triage with remote IDs", () => {
  test("key alone creates a new native-keyed ticket linked to the remote ID, even when a local ticket has that key", async () => {
    const h = await setup();
    const native = await h.make("Native sixty-two", { key: "MH-62" });
    const runsBefore = h.orch.ticketDetail("MH-62").runs.length;
    const { outcome, errors } = await h.triage('{"key":"MH-62"}', [dispatch({ key: "mh-62", url: "https://jira/MH-62" })]);
    expect(errors).toEqual([]);
    const created = h.orch.listTickets().find((t) => t.id !== native.id)!;
    expect(created.key).toMatch(/^MH-\d+$/);
    expect(created.key).not.toBe("MH-62");
    expect(created.externalRef).toMatchObject({ source: "jira", key: "MH-62", url: "https://jira/MH-62" });
    expect(outcome).toBe(`Dispatched to ${created.key} (MH-62) in MH`);
    // The native MH-62 got nothing: no message, no run.
    expect(h.orch.ticketDetail("MH-62").runs.length).toBe(runsBefore);
    expect(h.store.transcript.tail(native.sessionId, 50, ["text"]).filter((e) => e.content.type === "text" && e.content.text === "Handle the update")).toEqual([]);
  });

  test("a second dispatch with the same key makes another linked ticket; ticket_key messages the existing one", async () => {
    const h = await setup();
    await h.triage("MH-62 stage 1", [dispatch({ key: "MH-62" })]);
    await h.triage("MH-62 stage 2", [dispatch({ key: "MH-62" })]);
    const linked = h.store.tickets.byExternalKey("MH-62");
    expect(linked.map((t) => t.key).sort()).toEqual(["MH-1", "MH-2"]);

    const runsBefore = h.orch.ticketDetail("MH-1").runs.length;
    const { outcome } = await h.triage("MH-62 comment", [dispatch({ key: "MH-62", ticketKey: "mh-1" })]);
    expect(outcome).toBe("Sent update to existing MH-1");
    expect(h.orch.listTickets().length).toBe(2);
    expect(h.orch.ticketDetail("MH-1").runs.length).toBeGreaterThan(runsBefore);
    expect(h.driver.calls.at(-1)!.prompt).toBe("Handle the update");
  });

  test("ticket_key with key links an unlinked ticket; the same remote ID again is fine, a different one is refused", async () => {
    const h = await setup();
    const t = await h.make("Local work");
    const first = await h.triage("MH-62 is this", [dispatch({ key: "MH-62", ticketKey: t.key, url: "https://jira/MH-62" })]);
    expect(first.outcome).toBe(`Linked ${t.key} to MH-62 and sent update`);
    expect(h.byId(t).externalRef).toMatchObject({ source: "jira", key: "MH-62", url: "https://jira/MH-62" });

    const again = await h.triage("MH-62 again", [dispatch({ key: "MH-62", ticketKey: t.key })]);
    expect(again.errors).toEqual([]);
    expect(again.outcome).toBe(`Sent update to existing ${t.key}`);

    const clash = await h.triage("MH-99 now", [dispatch({ key: "MH-99", ticketKey: t.key })]);
    expect(clash.errors).toEqual([`${t.key} is already linked to MH-62, so it can't carry MH-99 too. Leave ticket_key out to create a new ticket linked to MH-99.`]);
    expect(h.byId(t).externalRef?.key).toBe("MH-62");
    expect(h.orch.listTickets().length).toBe(1);
  });

  test("ticket_key must be a local key: a remote ID or an unknown key is refused; key must look like a ticket key", async () => {
    const h = await setup();
    await h.make("Linked", { remote: "JIRA-9" });
    const { errors } = await h.triage("JIRA-9", [
      dispatch({ ticketKey: "JIRA-9" }),
      dispatch({ ticketKey: "NOPE-1" }),
      dispatch({ key: "not a key" }),
    ]);
    expect(errors[0]).toContain("JIRA-9 is a remote ID, not a local ticket key. Tickets linked to it: MH-1.");
    expect(errors[1]).toStartWith("Unknown ticket: NOPE-1.");
    expect(errors[2]).toStartWith("Invalid remote ID: not a key.");
    expect(h.orch.listTickets().length).toBe(1);
  });

  test("the Existing tickets section lists the local match and every ticket linked to the output's keys", async () => {
    const h = await setup();
    await h.make("Native", { key: "MH-62" });
    await h.make("Stage one", { remote: "MH-62" });
    await h.make("Stage two", { remote: "MH-62" });
    await h.make("Hidden draft", { remote: "MH-62", draft: true });
    const { prompt } = await h.triage("Update on MH-62", []);
    const section = prompt.slice(prompt.indexOf("## Existing tickets"), prompt.indexOf("## Output"));
    expect(section).toContain('* MH-62 "Native", status planning, no remote ID');
    expect(section).toMatch(/\* MH-\d+ "Stage one", status planning, remote ID MH-62/);
    expect(section).toMatch(/\* MH-\d+ "Stage two", status planning, remote ID MH-62/);
    expect(section).not.toContain("Hidden draft");
  });
});

describe("get_ticket and search with remote IDs", () => {
  async function trio() {
    const h = await setup();
    const native = await h.make("Native", { key: "MH-62" });
    const a = await h.make("Stage one", { remote: "MH-62" });
    const b = await h.make("Stage two", { remote: "MH-62" });
    const draft = await h.make("Draft stage", { remote: "MH-62", draft: true });
    return { ...h, native, a, b, draft };
  }
  const tool = (name: string) => allTools.find((t) => t.name === name)!;
  const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

  test("a local key returns that ticket with the tickets linked to it as a remote ID (drafts left out)", async () => {
    const h = await trio();
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "MH-62" }, h.ctx(h.a))));
    expect(r.key).toBe("MH-62");
    expect(r.externalKey).toBeNull();
    // Newest first.
    expect(r.relatedTickets).toEqual([
      { key: h.b.key, title: "Stage two", status: "planning", project: "MH", externalKey: "MH-62" },
      { key: h.a.key, title: "Stage one", status: "planning", project: "MH", externalKey: "MH-62" },
    ]);
  });

  test("a linked ticket lists the others sharing its remote ID, not itself", async () => {
    const h = await trio();
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: h.a.key }, h.ctx(h.native))));
    expect(r).toMatchObject({ key: h.a.key, externalKey: "MH-62", externalUrl: "https://jira/MH-62" });
    expect(r.relatedTickets.map((x: { key: string }) => x.key)).toEqual([h.b.key]);
    const unlinked = await h.make("Loner");
    expect(JSON.parse(text(await tool("get_ticket").execute({ key: unlinked.key }, h.ctx(h.native)))).relatedTickets).toEqual([]);
  });

  test("a key only remote IDs carry gives ticket null with the linked tickets; an unknown key still errors", async () => {
    const h = await setup();
    const x = await h.make("One", { remote: "JIRA-9" });
    const y = await h.make("Two", { remote: "JIRA-9" });
    const r = JSON.parse(text(await tool("get_ticket").execute({ key: "jira-9" }, h.ctx(x))));
    expect(r).toEqual({
      ticket: null,
      requested: "JIRA-9",
      relatedTickets: [
        { key: y.key, title: "Two", status: "planning", project: "MH", externalKey: "JIRA-9" },
        { key: x.key, title: "One", status: "planning", project: "MH", externalKey: "JIRA-9" },
      ],
    });
    await expect(h.orch.ops.getTicket(h.ctx(x), "JIRA-9")).rejects.toBeInstanceOf(RemoteIdError);
    await expect(tool("get_ticket").execute({ key: "NOPE-1" }, h.ctx(x))).rejects.toThrow("Unknown ticket: NOPE-1");
  });

  test("ticketDetail (GET /tickets/:key) carries relatedTickets, drafts included; a remote-only key is a 404 with the matches", async () => {
    const h = await trio();
    const d = h.orch.ticketDetail("MH-62");
    expect(d.relatedTickets!.map((t) => t.key)).toEqual([h.draft.key, h.b.key, h.a.key]);
    expect(d.relatedTickets![0]).toEqual({ key: h.draft.key, title: "Draft stage", status: "planning", projectId: h.project.id, externalKey: "MH-62" });
    expect(h.orch.ticketDetail(h.a.key).relatedTickets!.map((t) => t.key)).toEqual([h.draft.key, h.b.key]);

    const elsewhere = await h.make("Elsewhere", { remote: "JIRA-9" });
    let err: any;
    try {
      h.orch.ticketDetail("JIRA-9");
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(404);
    expect(err.message).toBe(`JIRA-9 is a remote ID, not a local ticket key. Tickets linked to it: ${elsewhere.key}.`);
    expect(err.data).toEqual({
      requested: "JIRA-9",
      relatedTickets: [{ key: elsewhere.key, title: "Elsewhere", status: "planning", projectId: h.project.id, externalKey: "JIRA-9" }],
    } satisfies RemoteKeyMatches);
    expect(() => h.orch.ticketDetail("NOPE-1")).toThrow(expect.objectContaining({ status: 404, data: undefined }));
  });

  test("search_tickets finds the local key first, then the tickets linked to it, with their remote IDs", async () => {
    const h = await trio();
    const r = JSON.parse(text(await tool("search_tickets").execute({ query: "MH-62" }, h.ctx(h.native))));
    expect(r.hits.map((x: { key: string }) => x.key)).toEqual(["MH-62", h.b.key, h.a.key]);
    expect(r.hits[0].externalKey).toBeUndefined();
    expect(r.hits[1].externalKey).toBe("MH-62");
  });
});

describe("linking by hand (PATCH /tickets/:key externalRef)", () => {
  test("links with source manual, keeps a watcher link's origin when only its URL changes, unlinks with null", async () => {
    const h = await setup();
    const t = await h.make("Local");
    const events: HarnessEvent[] = [];
    h.bus.on((e) => events.push(e));
    const linked = await h.orch.updateTicket(t.key, { externalRef: { key: " mh-62 ", url: "https://jira/MH-62" } });
    expect(linked.externalRef).toEqual({ source: "manual", key: "MH-62", url: "https://jira/MH-62", raw: null });
    expect(h.store.tickets.byExternalKey("MH-62").map((x) => x.id)).toEqual([t.id]);
    expect(events.some((e) => e.kind === "ticket.upserted" && e.ticket.id === t.id && e.ticket.externalRef?.key === "MH-62")).toBe(true);

    const watched = await h.make("From jira", { remote: "JIRA-1" });
    const relinked = await h.orch.updateTicket(watched.key, { externalRef: { key: "JIRA-1", url: null } });
    expect(relinked.externalRef).toEqual({ source: "jira", key: "JIRA-1", url: null, raw: null });

    const unlinked = await h.orch.updateTicket(t.key, { externalRef: null });
    expect(unlinked.externalRef).toBeNull();
    expect(h.store.tickets.byExternalKey("MH-62")).toEqual([]);
    expect(h.store.transcript.tail(t.sessionId, 50, ["status"]).map((e) => (e.content as { text: string }).text)).toEqual(
      expect.arrayContaining(["Linked to MH-62", "Unlinked from MH-62"]),
    );
  });

  test("rejects a key that isn't FOO-123, a non-http URL, and a malformed body without changing anything", async () => {
    const h = await setup();
    const t = await h.make("Local", { remote: "MH-1" });
    for (const bad of [{ key: "nope" }, { key: "MH-2", url: "ftp://x" }, { key: 5 }, "MH-2", { key: "MH-2", url: 3 }]) {
      await expect(h.orch.updateTicket(t.key, { externalRef: bad as never })).rejects.toMatchObject({ status: 400 });
    }
    expect(h.byId(t).externalRef?.key).toBe("MH-1");
  });
});
