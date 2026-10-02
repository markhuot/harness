// The spec and Activity over HTTP, end to end with the dummy driver: plan, Start, the work's spec
// edits and submit, a review that asks for changes, the fix, the re-review that approves, and the
// human's approval. Plus the revision and diff endpoints, the PATCH conflict and message logging.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HarnessApiError, HarnessClient, specConflict, type HarnessEvent, type TicketDetail } from "@harness/shared";
import { parseDiff } from "@harness/shared/diff";
import { onTempCleanup } from "@harness/shared/testing";
import { createHarness, type Harness } from "../app";
import { DummyDriver } from "../drivers/dummy";
import { stubBrowser, tempHome } from "../testing/fakes";
import { git } from "../orchestrator/worktree";

let harness: Harness | null = null;
afterEach(async () => {
  await harness?.stop();
  harness = null;
});

async function boot() {
  const home = tempHome("harness-spec-");
  harness = await createHarness({ home, port: 0, drivers: [new DummyDriver({ delayMs: 0 })], browser: stubBrowser(), watchers: null, log: () => {} });
  const client = new HarnessClient({ baseUrl: harness.url, token: harness.token });
  await client.updateSettings({ defaultDriver: "dummy" });
  const dir = join(home, "work", "web");
  mkdirSync(dir, { recursive: true });
  await git(["init", "-q", "-b", "main"], dir);
  await git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], dir);
  const project = await client.createProject({ path: dir, key: "WEB", useWorktrees: false });
  const events: HarnessEvent[] = [];
  let up!: () => void;
  const ready = new Promise<void>((r) => (up = r));
  const socket = client.connect({ onEvent: (e) => events.push(e), onStatus: (s) => s && up() });
  onTempCleanup(() => socket.close());
  await ready;
  return { client, project, events };
}

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`condition not met in time: ${JSON.stringify(v ?? lastSeen)}`);
    await Bun.sleep(10);
  }
}

let lastSeen: unknown = null;
const idle = (client: HarnessClient, key: string, ok: (d: TicketDetail) => boolean) =>
  until(async () => {
    const d = await client.getTicket(key);
    lastSeen = { t: { status: d.ticket.status, rev: d.ticket.specRevision, busy: d.ticket.busy, blocked: d.ticket.blockedReason, ar: d.ticket.agentReview }, activity: d.activity.map((e) => [e.kind, e.body]), runs: d.runs.map((r) => [r.kind, r.status, r.error]) };
    return !d.ticket.busy && ok(d) ? d : null;
  });

describe("spec + Activity end to end (dummy driver)", () => {
  test("plan → Start → spec edits → submit → changes requested → fix → re-review approves → approve", async () => {
    const { client, project, events } = await boot();
    const created = await client.createTicket({ projectId: project.id, spec: "Make the header blue [dummy:reject-once]", title: "Blue header", start: false });
    // Planning: the dummy reads the spec and replaces it with its plan.
    await idle(client, created.key, (d) => d.ticket.specRevision === 2);

    await client.startTicket(created.key);
    const done = await idle(client, created.key, (d) => d.ticket.status === "review" && d.ticket.agentReview === "approved");
    const t = done.ticket;
    expect(t.specBaselineRevision).toBe(2);

    // Every revision says who wrote it and why.
    const revisions = await client.specRevisions(t.key);
    expect(revisions.map(({ rev, author, runKind, note, approvedBaseline }) => ({ rev, author, runKind, note, approvedBaseline }))).toEqual([
      { rev: 1, author: "system", runKind: null, note: "Created", approvedBaseline: false },
      { rev: 2, author: "agent", runKind: "plan", note: "Plan drafted", approvedBaseline: true },
      { rev: 3, author: "agent", runKind: "work", note: "Status: The dummy driver finished the work.", approvedBaseline: false },
      { rev: 4, author: "agent", runKind: "work", note: "Status: The dummy driver addressed the review notes.", approvedBaseline: false },
    ]);
    // Each round replaced the Status section rather than appending to it.
    expect(t.spec).toContain("## Status\n* The dummy driver addressed the review notes.");
    expect(t.spec.match(/^## Status$/gm)).toHaveLength(1);
    expect(t.spec.match(/addressed the review notes/g)).toHaveLength(1);
    expect(t.spec).not.toContain("finished the work");

    // Activity: typed entries, each review with its round and the commit it saw.
    const kinds = done.activity.map((e) => e.kind);
    expect(kinds).toEqual(["note", "submitted", "changes_requested", "note", "submitted", "review_approved"]);
    const [round1, round2] = done.activity.filter((e) => e.kind === "changes_requested" || e.kind === "review_approved");
    expect(round1!.meta).toMatchObject({ by: "agent", round: 1 });
    expect(round2!.meta).toMatchObject({ by: "agent", round: 2 });
    expect(round1!.meta.commit).toMatch(/^[0-9a-f]{40}$/);
    // The fix round's submit note covers just that round.
    expect(done.activity.filter((e) => e.kind === "submitted").map((e) => e.body)).toEqual(["The dummy driver finished the work.", "The dummy driver addressed the review notes."]);

    // The second review is the delta prompt: round 1's commit and notes, diff from that commit.
    const reviews = done.runs.filter((r) => r.kind === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.prompt).not.toContain("## Earlier review rounds");
    expect(reviews[1]!.prompt).toContain("round 2, a re-review");
    expect(reviews[1]!.prompt).toContain(`Round 1: changes requested at commit ${round1!.meta.commit}.`);
    expect(reviews[1]!.prompt).toContain(`git diff ${round1!.meta.commit}..HEAD`);
    // Both carry the spec's changes since the approved baseline (rev 2).
    expect(reviews[1]!.prompt).toContain("Revision 2 is what the human approved by pressing Start:");

    expect(events.filter((e) => e.kind === "spec.revised").map((e) => (e as { rev: number }).rev)).toEqual([2, 3, 4]);
    expect(events.some((e) => e.kind === "activity.added" && e.entry.kind === "review_approved")).toBe(true);

    // The human approves: it lands (no branch, so the completion only wraps up) and says so.
    await client.humanReview(t.key, { decision: "approve", notes: "" });
    const landed = await idle(client, t.key, (d) => d.ticket.status === "done");
    expect(landed.activity.slice(-2).map((e) => [e.kind, e.body])).toEqual([
      ["approved", "Approved."],
      ["note", "Completed."],
    ]);
  }, 30_000);
});

describe("spec endpoints", () => {
  async function ticketWithRevisions() {
    const { client, project, events } = await boot();
    const t = await client.createTicket({ projectId: project.id, spec: "a\nb\nc", title: "Revs", draft: true });
    await client.submitTicket(t.key, { start: false });
    await client.cancelTicket(t.key);
    let cur = await client.getTicket(t.key);
    // Change, insert and delete across three human revisions.
    for (const body of ["a\nB\nc", "a\nB\nc\nd", "B\nc\nd"]) {
      await client.updateTicket(t.key, { spec: body, baseRevision: cur.ticket.specRevision });
      cur = await client.getTicket(t.key);
    }
    return { client, t: cur.ticket, events };
  }

  test("revisions list, one revision's body, and a unified diff parseDiff reads", async () => {
    const { client, t } = await ticketWithRevisions();
    expect((await client.specRevisions(t.key)).map((r) => [r.rev, r.author, r.note])).toEqual([
      [1, "system", "Created"],
      [2, "human", "Edited by hand"],
      [3, "human", "Edited by hand"],
      [4, "human", "Edited by hand"],
    ]);
    expect((await client.specRevision(t.key, 2)).body).toBe("a\nB\nc");
    const changed = (from: number, to: number) =>
      client.specDiff(t.key, from, to).then((d) => parseDiff(d.diff).lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => l.text));
    expect(await changed(1, 2)).toEqual(["-b", "+B"]);
    expect(await changed(2, 3)).toEqual(["+d"]);
    expect(await changed(3, 4)).toEqual(["-a"]);
    expect(await changed(4, 1)).toEqual(["-B", "+a", "+b", "-d"]);
    expect((await client.specDiff(t.key, 2, 2)).diff).toBe("");
    expect(await client.specDiff(t.key, 1, 4)).toMatchObject({ from: 1, to: 4 });
  });

  test("unknown revisions are 404s and bad numbers 400s", async () => {
    const { client, t } = await ticketWithRevisions();
    await expect(client.specRevision(t.key, 9)).rejects.toMatchObject({ status: 404 });
    await expect(client.request("GET", `/tickets/${t.key}/spec/revisions/x`)).rejects.toMatchObject({ status: 400 });
    await expect(client.specDiff(t.key, 9, 1)).rejects.toMatchObject({ status: 404 });
  });

  test("a stale PATCH is a 409 carrying the current spec; a missing baseRevision a 400", async () => {
    const { client, t } = await ticketWithRevisions();
    const err = await client.updateTicket(t.key, { spec: "mine", baseRevision: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessApiError);
    expect(specConflict(err)).toEqual({ currentRevision: 4, spec: "B\nc\nd" });
    await expect(client.updateTicket(t.key, { spec: "mine" })).rejects.toMatchObject({ status: 400 });
    expect((await client.getTicket(t.key)).ticket.spec).toBe("B\nc\nd");
  });
});

describe("POST /tickets/:key/messages log", () => {
  async function blocked() {
    const { client, project } = await boot();
    const t = await client.createTicket({ projectId: project.id, spec: "/block Which color?", title: "Ask", start: true });
    await idle(client, t.key, (d) => d.ticket.status === "blocked");
    return { client, t };
  }

  test("log: true puts the message and the answer in Activity", async () => {
    const { client, t } = await blocked();
    await client.sendMessage(t.key, "Blue, please", { log: true });
    const d = await idle(client, t.key, (x) => x.activity.some((e) => e.kind === "answer"));
    expect(d.activity.slice(-2).map((e) => [e.kind, e.author, e.body])).toEqual([
      ["message", "human", "Blue, please"],
      ["answer", "agent", '(dummy chat) You said: "Blue, please"'],
    ]);
  });

  test("without log, neither goes into Activity", async () => {
    const { client, t } = await blocked();
    const before = (await client.getTicket(t.key)).activity.length;
    await client.sendMessage(t.key, "Blue, please");
    const d = await idle(client, t.key, (x) => x.runs.some((r) => r.kind === "chat" && r.status === "succeeded"));
    expect(d.activity).toHaveLength(before);
  });

  test("log must be a boolean", async () => {
    const { client, t } = await blocked();
    await expect(client.request("POST", `/tickets/${t.key}/messages`, { text: "hi", log: "yes" })).rejects.toMatchObject({ status: 400 });
  });
});
