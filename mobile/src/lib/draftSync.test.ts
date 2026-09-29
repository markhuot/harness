import { describe, expect, test } from "bun:test";
import type { CreateTicketBody, Project, Ticket, UpdateTicketBody } from "@harness/shared";
import { applyTicketPatch, blankDraftTicket } from "@harness/shared/state";
import { DraftSync, type DraftApi } from "./draftSync";

const projects: Record<string, Project> = {
  p1: { id: "p1", key: "WEB", name: "web", path: "/w", nextSeq: 4, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null } as unknown as Project,
  p2: { id: "p2", key: "API", name: "api", path: "/a", nextSeq: 9, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null } as unknown as Project,
};
const settings = { defaultDriver: "claude-code", defaultModels: {}, baseBranch: "main" };
const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake service: records calls; each answer can be held back until released. */
function fakeApi(opts: { hold?: boolean; fail?: boolean } = {}) {
  const calls: { op: string; key?: string; body?: CreateTicketBody | UpdateTicketBody }[] = [];
  const held: (() => void)[] = [];
  let server: Ticket | null = null;
  let n = 4;
  let now = 10;
  const answer = <T,>(fn: () => T) =>
    new Promise<T>((resolve, reject) => {
      const go = () => (opts.fail ? reject(new Error("boom")) : resolve(fn()));
      if (opts.hold) held.push(go);
      else go();
    });
  const api: DraftApi = {
    create: (body) => {
      calls.push({ op: "create", body });
      return answer(() => (server = { ...blankDraftTicket(projects[body.projectId]!, settings, `${projects[body.projectId]!.key}-${n++}`), id: "t1", description: body.prompt, kind: body.kind ?? "task", updatedAt: now++ }));
    },
    update: (key, body) => {
      calls.push({ op: "update", key, body });
      return answer(() => {
        let t = applyTicketPatch(server!, body);
        if (body.projectId) t = { ...t, key: `${projects[body.projectId]!.key}-${n++}` };
        return (server = { ...t, updatedAt: now++ });
      });
    },
    remove: (key) => (calls.push({ op: "remove", key }), answer(() => ({ ok: true }))),
    submit: (key, start) => (calls.push({ op: start ? "start" : "plan", key }), answer(() => ({ ...server!, draft: false, status: start ? "in_progress" : "planning" }) as Ticket)),
  };
  return { api, calls, release: () => held.splice(0).forEach((go) => go()), get server() { return server; } };
}

function setup(api: DraftApi, extra: { saved?: Ticket } = {}) {
  const changes: Ticket[] = [];
  const errors: unknown[] = [];
  const local = extra.saved ?? blankDraftTicket(projects.p1!, settings, "WEB-4", 1);
  const sync = new DraftSync({ api, local, saved: extra.saved, project: (id) => projects[id], settings: () => settings, onChange: (t) => changes.push(t), onError: (e) => errors.push(e), delayMs: 20 });
  const edit = (patch: UpdateTicketBody) => sync.edit(applyTicketPatch(sync.local, patch));
  return { sync, edit, changes, errors };
}

describe("DraftSync", () => {
  test("nothing is sent while the draft is empty; the first real edit creates it at once", async () => {
    const f = fakeApi();
    const { sync, edit } = setup(f.api);
    edit({ description: "   " });
    await wait(40);
    expect(f.calls).toEqual([]);
    edit({ description: "Fix it" });
    await tick();
    expect(f.calls.map((c) => c.op)).toEqual(["create"]);
    expect(f.calls[0]!.body).toMatchObject({ draft: true, prompt: "Fix it", projectId: "p1" });
    expect(sync.key).toBe("WEB-4");
  });

  test("edits before the create goes out ride along in it", async () => {
    const f = fakeApi();
    const { sync, edit } = setup(f.api);
    edit({ description: "Fix" });
    edit({ description: "Fix it" });
    await sync.flush();
    expect(f.calls.map((c) => c.op)).toEqual(["create"]);
    expect(f.calls[0]!.body).toMatchObject({ prompt: "Fix it" });
  });

  test("later edits are debounced into one PATCH of only what changed", async () => {
    const f = fakeApi();
    const { edit } = setup(f.api);
    edit({ description: "Fix" });
    await tick();
    edit({ description: "Fix it" });
    edit({ description: "Fix it now" });
    edit({ skipAgentReview: true });
    await tick();
    expect(f.calls.length).toBe(1);
    await wait(40);
    expect(f.calls.map((c) => c.op)).toEqual(["create", "update"]);
    expect(f.calls[1]!.body).toEqual({ description: "Fix it now", skipAgentReview: true });
  });

  test("edits made while the create is out follow it as a PATCH, never a second create", async () => {
    const f = fakeApi({ hold: true });
    const { edit } = setup(f.api);
    edit({ description: "Fix" });
    await tick();
    edit({ description: "Fix it" });
    await wait(40);
    expect(f.calls.map((c) => c.op)).toEqual(["create"]);
    f.release();
    await wait(40);
    f.release();
    await tick();
    expect(f.calls.map((c) => c.op)).toEqual(["create", "update"]);
    expect(f.calls[1]!.body).toEqual({ description: "Fix it" });
  });

  test("moving to another project adopts the key the service answers with", async () => {
    const f = fakeApi();
    const { sync, edit, changes } = setup(f.api);
    edit({ description: "Fix it" });
    await tick();
    edit({ projectId: "p2", branch: null, baseBranch: null, useWorktree: null });
    await sync.flush();
    expect(f.calls[1]).toMatchObject({ op: "update", key: "WEB-4", body: { projectId: "p2" } });
    expect(sync.key).toBe("API-5");
    expect(sync.local.key).toBe("API-5");
    expect(changes.at(-1)?.key).toBe("API-5");
    // The next PATCH goes to the new key.
    edit({ description: "Fix it there" });
    await sync.flush();
    expect(f.calls[2]).toMatchObject({ key: "API-5", body: { description: "Fix it there" } });
  });

  test("another device's change applies only while nothing is unsent, and never an older copy", async () => {
    const f = fakeApi();
    const { sync, edit } = setup(f.api);
    edit({ description: "Fix it" });
    await tick();
    const theirs = { ...f.server!, description: "Their words", updatedAt: 100 };
    edit({ description: "Mine" });
    expect(sync.incoming(theirs)).toBe(false);
    expect(sync.local.description).toBe("Mine");
    await sync.flush();
    expect(sync.incoming({ ...theirs, updatedAt: 1 })).toBe(false);
    expect(sync.incoming(theirs)).toBe(true);
    expect(sync.local.description).toBe("Their words");
  });

  test("submit saves what's pending first, then launches the saved key", async () => {
    const f = fakeApi();
    const { sync, edit } = setup(f.api);
    edit({ description: "Fix" });
    await tick();
    edit({ description: "Fix it" });
    const t = await sync.submit(false);
    expect(f.calls.map((c) => c.op)).toEqual(["create", "update", "plan"]);
    expect(t.status).toBe("planning");
    edit({ description: "after" });
    await wait(40);
    expect(f.calls.length).toBe(3);
  });

  test("submit refuses when a save failed instead of launching stale settings", async () => {
    const f = fakeApi({ fail: true });
    const { sync, edit, errors } = setup(f.api);
    edit({ description: "Fix it" });
    await expect(sync.submit(true)).rejects.toThrow("couldn't be saved");
    expect(errors.length).toBeGreaterThan(0);
    expect(f.calls.some((c) => c.op === "start")).toBe(false);
  });

  test("closing saves pending edits; a saved draft emptied again is deleted instead", async () => {
    const f = fakeApi();
    const a = setup(f.api);
    a.edit({ description: "Fix" });
    await tick();
    a.edit({ description: "Fix it" });
    await a.sync.close();
    expect(f.calls.map((c) => c.op)).toEqual(["create", "update"]);

    const g = fakeApi();
    const b = setup(g.api);
    b.edit({ description: "Fix" });
    await tick();
    b.edit({ description: "" });
    await b.sync.close();
    expect(g.calls.map((c) => c.op)).toEqual(["create", "remove"]);
  });

  test("discarding an unsaved draft sends nothing; a reopened one is deleted by its key", async () => {
    const f = fakeApi();
    await setup(f.api).sync.discard();
    expect(f.calls).toEqual([]);
    const saved = { ...blankDraftTicket(projects.p1!, settings, "WEB-2", 1), description: "Old" };
    const r = setup(f.api, { saved });
    r.edit({ description: "Old, edited" });
    await r.sync.discard();
    expect(f.calls).toEqual([{ op: "remove", key: "WEB-2" }]);
  });
});

describe("DraftSync closing twice", () => {
  test("Save draft then the sheet's unmount close share one save", async () => {
    const f = fakeApi();
    const { sync, edit } = setup(f.api);
    edit({ description: "Fix" });
    await tick();
    edit({ description: "Fix it" });
    await Promise.all([sync.close(), sync.close()]);
    expect(f.calls.map((c) => c.op)).toEqual(["create", "update"]);
    expect(sync.isClosed).toBe(true);
  });
});
