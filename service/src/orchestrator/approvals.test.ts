import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { HarnessEvent } from "@harness/shared";
import { FakeDriver, makeOrchestrator } from "../testing/fakes";
import { migrate, MIGRATIONS } from "../db";
import { APPROVAL_PENDING_MESSAGE, endsWithQuestion, summarizeToolInput } from "./orchestrator";
import { DEFAULT_SETTINGS, resolveSettings } from "./settings";

function setup(driver?: FakeDriver) {
  const h = makeOrchestrator({ driver });
  const dir = join(h.home, "acme");
  mkdirSync(dir, { recursive: true });
  const project = h.orch.createProject({ path: dir });
  const events: HarnessEvent[] = [];
  h.bus.on((e) => events.push(e));
  return { ...h, project, events };
}

const kinds = (h: ReturnType<typeof setup>, sessionId: string) => h.store.runs.listBySession(sessionId).map((r) => r.kind);

describe("tool permission approvals", () => {
  test("unapproved call blocks the ticket with a pending approval and never auto-submits", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: 'go /tool Bash {"command":"npm install"}' });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("Permission needed: Bash — npm install");
    expect(cur.pendingApproval).toMatchObject({ toolName: "Bash", input: { command: "npm install" } });
    expect(cur.pendingApproval!.runId).toBe(h.store.runs.listBySession(t.sessionId)[0]!.id);
    expect(h.driver.approvals).toEqual([{ name: "Bash", behavior: "deny" }]);
    expect(kinds(h, t.sessionId)).toEqual(["work"]); // no review: not auto-submitted
    expect(h.orch.summaries(t.key).some((s) => s.author === "system" && s.body.startsWith("Permission needed: Bash"))).toBe(true);
    expect(h.events.some((e) => e.kind === "ticket.upserted" && e.ticket.pendingApproval?.toolName === "Bash")).toBe(true);
    const denial = h.store.transcript.list(t.sessionId).find((e) => e.content.type === "text" && e.content.text.startsWith("Denied:"));
    expect((denial!.content as { text: string }).text).toBe(`Denied: ${APPROVAL_PENDING_MESSAGE}`);
  });

  test("allow_once grants exactly that call once (deep-equal input), then resumes work", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: 'go /tool Bash {"command":"ls","timeout":5}' });
    await h.orch.idle();
    const resumed = await h.orch.answerApproval(t.key, { decision: "allow_once" });
    expect(resumed.status).toBe("in_progress");
    expect(resumed.pendingApproval).toBeNull();
    expect(resumed.blockedReason).toBeNull();
    await h.orch.idle();
    const retry = h.driver.calls.filter((c) => c.kind === "work")[1]!;
    expect(retry.prompt).toBe("The human approved your request to use Bash (ls). Retry it now and continue.");
    expect(h.driver.approvals.map((a) => a.behavior)).toEqual(["deny", "allow"]);
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("review");
    // grant was consumed: the same call now needs approval again; key order doesn't matter for matching
    expect(h.store.tickets.consumeGrant(t.id, "Bash", { timeout: 5, command: "ls" })).toBe(false);
    h.store.tickets.addGrant(t.id, "Bash", { command: "ls", timeout: 5 });
    expect(h.store.tickets.consumeGrant(t.id, "Bash", { command: "ls", timeout: 6 })).toBe(false);
    expect(h.store.tickets.consumeGrant(t.id, "Bash", { timeout: 5, command: "ls" })).toBe(true);
  });

  test("allow_tool allows every later call of that tool on the ticket", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: 'go /tool WebFetch {"url":"https://a.test"}' });
    await h.orch.idle();
    await h.orch.answerApproval(t.key, { decision: "allow_tool" });
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work")[1]!.prompt).toContain("you may use WebFetch freely for the rest of this ticket");
    expect(h.orch.ticketDetail(t.key).ticket.allowedTools).toEqual(["WebFetch"]);
    await h.orch.sendMessage(t.key, 'again /tool WebFetch {"url":"https://b.test"}');
    await h.orch.idle();
    expect(h.driver.approvals.map((a) => a.behavior)).toEqual(["deny", "allow", "allow"]);
    expect(h.orch.ticketDetail(t.key).ticket.pendingApproval).toBeNull();
    // other tools still need approval
    await h.orch.sendMessage(t.key, 'more /tool Bash {"command":"rm -rf x"}');
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("blocked");
  });

  test("deny (explicit or via a human message) resumes work with the reason", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: 'go /tool Bash {"command":"curl evil"}' });
    await h.orch.idle();
    await h.orch.answerApproval(t.key, { decision: "deny", message: "No network access." });
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work")[1]!.prompt).toBe(
      "The human denied Bash (curl evil). No network access. Find another way or call block if you can't proceed.",
    );
    await expect(h.orch.answerApproval(t.key, { decision: "deny" })).rejects.toMatchObject({ status: 409 });

    const u = await h.orch.createTicket({ projectId: h.project.id, prompt: 'go /tool Bash {"command":"make"}' });
    await h.orch.idle();
    const replied = await h.orch.sendMessage(u.key, "use the Makefile target instead");
    expect(replied.status).toBe("in_progress");
    expect(replied.pendingApproval).toBeNull();
    await h.orch.idle();
    expect(h.driver.calls.filter((c) => c.kind === "work").at(-1)!.prompt).toBe(
      "The human denied Bash (make). use the Makefile target instead. Find another way or call block if you can't proceed.",
    );
  });

  test("review/plan runs are denied outright without touching the ticket", async () => {
    const h = setup();
    const results: unknown[] = [];
    h.driver.script = async function* (req) {
      if (req.kind === "plan") results.push(await req.toolContext.ops.requestApproval(req.toolContext, "Bash", { command: "ls" }));
    };
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.idle();
    expect(results).toEqual([
      { behavior: "deny", message: "No human is available to approve tools during a plan run; proceed without it and mention it in your notes." },
    ]);
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect([cur.status, cur.pendingApproval]).toEqual(["planning", null]);
  });

  test("a complete run needing approval resumes as a complete run", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    h.driver.script = async function* (req) {
      if (req.kind !== "complete") return;
      const r = await req.toolContext.ops.requestApproval(req.toolContext, "Bash", { command: "git merge" });
      if (r.behavior === "deny") return;
      yield { type: "text", text: "merged" };
    };
    await h.orch.completeTicket(t.key);
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("blocked"); // not "done"
    const resumed = await h.orch.answerApproval(t.key, { decision: "allow_once" });
    expect(resumed.status).toBe("review");
    await h.orch.idle();
    expect(h.orch.ticketDetail(t.key).ticket.status).toBe("done");
    expect(kinds(h, t.sessionId).slice(-2)).toEqual(["complete", "complete"]);
  });

  test("summarizeToolInput prefers command / file_path / url, else compact JSON", () => {
    expect(summarizeToolInput({ command: "npm  install\n--save" })).toBe("npm install --save");
    expect(summarizeToolInput({ file_path: "/a/b.ts", content: "..." })).toBe("/a/b.ts");
    expect(summarizeToolInput({ url: "https://x" })).toBe("https://x");
    expect(summarizeToolInput({ a: 1 })).toBe('{"a":1}');
    expect(summarizeToolInput({ command: "x".repeat(300) }).length).toBe(120);
  });
});

describe("agent review ping-pong cap", () => {
  test("third consecutive agent request_changes blocks instead of starting more work; human action resets", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 10;
    const h = setup(driver);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    let cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("Agent review requested changes 3 times — needs a human decision");
    expect(kinds(h, t.sessionId)).toEqual(["work", "review", "work", "review", "work", "review"]);

    // human reply resets the counter: the loop gets a fresh budget of 3
    await h.orch.sendMessage(t.key, "keep going");
    await h.orch.idle();
    cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(kinds(h, t.sessionId).length).toBe(12);
  });

  test("an approval between rejections resets the count", async () => {
    const driver = new FakeDriver();
    driver.rejectsLeft = 2;
    const h = setup(driver);
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x" });
    await h.orch.idle();
    expect(h.store.tickets.reviewRejections(t.id)).toBe(2);
    h.orch.humanReview(t.key, { decision: "approve" });
    expect(h.store.tickets.reviewRejections(t.id)).toBe(0);
  });
});

describe("work run ending with a question", () => {
  test("blocks with the question instead of auto-submitting", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "choose /ask" });
    await h.orch.idle();
    const cur = h.orch.ticketDetail(t.key).ticket;
    expect(cur.status).toBe("blocked");
    expect(cur.blockedReason).toBe("Should I use Postgres or MySQL? 🤔**");
    expect(kinds(h, t.sessionId)).toEqual(["work"]);
  });

  test("endsWithQuestion ignores trailing emoji, punctuation and markdown", () => {
    for (const q of ["Ready?", "Ready? 🙂", "**Ready?**", "Ready?)", "Ready?\n\n", "Is it `a` or `b`?`", "Ship it? 👍🏽!"]) expect(endsWithQuestion(q)).toBe(true);
    for (const q of ["Done.", "Why? Because.", "", null, "Done! 🎉"]) expect(endsWithQuestion(q)).toBe(false);
  });
});

describe("migrations and events", () => {
  test("v1 → latest: bypassPermissions → acceptEdits (v2) → ask (v4); the default mode is auto", () => {
    const db = new Database(":memory:");
    db.exec(MIGRATIONS[0]!);
    db.exec("PRAGMA user_version = 1");
    db.query("INSERT INTO settings (key, value) VALUES ('claudePermissionMode', '\"bypassPermissions\"')").run();
    migrate(db);
    expect(db.query("SELECT value FROM settings WHERE key = 'claudePermissionMode'").get()).toBeNull();
    expect((db.query("SELECT value FROM settings WHERE key = 'permissionMode'").get() as any).value).toBe('"ask"');
    expect(DEFAULT_SETTINGS.permissionMode).toBe("auto");
  });

  test("v3 → v4 maps each claude-code mode onto a harness mode and adds nullable overrides", () => {
    for (const [legacy, mode] of [["acceptEdits", "ask"], ["auto", "auto"], ["dontAsk", "read_only"], ["bypassPermissions", "ask"]] as const) {
      const db = new Database(":memory:");
      for (const m of MIGRATIONS.slice(0, 3)) db.exec(m);
      db.exec("PRAGMA user_version = 3");
      db.query("INSERT INTO settings (key, value) VALUES ('claudePermissionMode', $v)").run({ $v: JSON.stringify(legacy) });
      migrate(db);
      expect(resolveSettings({ permissionMode: JSON.parse((db.query("SELECT value FROM settings WHERE key = 'permissionMode'").get() as any).value) }).permissionMode).toBe(mode);
      const cols = (t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number }[]).find((c) => c.name === "permission_mode");
      expect(cols("tickets")?.notnull).toBe(0);
      expect(cols("projects")?.notnull).toBe(0);
    }
    // No stored mode (the old default acceptEdits was never written) → the new default, auto.
    const db = new Database(":memory:");
    migrate(db);
    expect(db.query("SELECT value FROM settings WHERE key = 'permissionMode'").get()).toBeNull();
  });

  test("deleting a ticket emits session.deleted", async () => {
    const h = setup();
    const t = await h.orch.createTicket({ projectId: h.project.id, prompt: "x", start: false });
    await h.orch.idle();
    await h.orch.deleteTicket(t.key);
    expect(h.events.some((e) => e.kind === "session.deleted" && e.id === t.sessionId)).toBe(true);
  });
});
