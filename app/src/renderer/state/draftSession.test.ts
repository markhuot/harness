import { describe, expect, test } from "bun:test";
import type { Attachment, AttachmentAnnotation, CreateTicketBody, Project, Ticket, UpdateTicketBody } from "@harness/shared";
import { annotateAttachment, applyTicketPatch, blankDraftTicket, attachmentFromInput, removeAttachment } from "@harness/shared/state";
import { DraftSession, dropDraftSession, paneDraftSession, rebase, releaseDraftSession, unloadDraftSessions, type DraftDeps } from "./draftSession";

const projects: Record<string, Project> = {
  p1: { id: "p1", key: "WEB", name: "web", path: "/w", nextSeq: 4, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null } as unknown as Project,
  p2: { id: "p2", key: "API", name: "api", path: "/a", nextSeq: 9, isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null } as unknown as Project,
};
const settings = { defaultDriver: "claude-code", defaultModels: {}, baseBranch: "main" };
const blank = () => blankDraftTicket(projects.p1!, settings, "WEB-4", 1);

/** A request the test answers by hand. */
interface Pending<T> {
  body: unknown;
  key?: string;
  resolve(v: T): void;
  reject(e: Error): void;
}

/** A fake service: every request waits until the test resolves it (or `auto` answers it). */
function fakeService(auto = false) {
  const creates: Pending<Ticket>[] = [];
  const patches: Pending<Ticket>[] = [];
  const submits: Pending<Ticket>[] = [];
  const deletes: string[] = [];
  const upserts: Ticket[] = [];
  const rekeys: [string | null, string][] = [];
  const errors: string[] = [];
  let server: Ticket | null = null;
  let seq = 4;
  const make = <T,>(list: Pending<T>[], body: unknown, key: string | undefined, answer: () => T) =>
    new Promise<T>((resolve, reject) => {
      const p = { body, key, resolve, reject };
      list.push(p);
      if (auto) queueMicrotask(() => p.resolve(answer()));
    });
  const createAnswer = (body: CreateTicketBody): Ticket => (server = { ...blank(), id: "t1", key: `${projects[body.projectId]!.key}-${seq}`, spec: body.spec, kind: body.kind ?? "task", model: body.model ?? null, draft: true, promptAttachments: body.promptAttachments?.map(attachmentFromInput) });
  const patchAnswer = (key: string, body: UpdateTicketBody): Ticket => {
    let t = applyTicketPatch(server!, body);
    if (body.projectId && body.projectId !== server!.projectId) t = { ...t, key: `${projects[body.projectId]!.key}-${++seq}` };
    return (server = { ...t, title: t.spec.slice(0, 20) });
  };
  const deps: DraftDeps = {
    client: {
      createTicket: (body) => make(creates, body, undefined, () => createAnswer(body)),
      updateTicket: (key, body) => make(patches, body, key, () => patchAnswer(key, body)),
      submitTicket: (key, body) => make(submits, body, key, () => (server = { ...server!, draft: false, status: body.start ? "in_progress" : "planning" })),
      deleteTicket: async (key) => void deletes.push(key),
    },
    project: (id) => projects[id],
    settings: () => settings,
    upsert: (t) => void upserts.push(t),
    rekeyed: (from, to) => void rekeys.push([from, to]),
    error: (m) => void errors.push(m),
  };
  return { deps, creates, patches, submits, deletes, upserts, rekeys, errors, createAnswer, patchAnswer, get server() { return server!; } };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("DraftSession: lazy creation", () => {
  test("nothing is sent while the draft is empty, not even a project change", async () => {
    const svc = fakeService(true);
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ projectId: "p2", branch: null, baseBranch: null, useWorktree: null });
    s.edit({ spec: "   " });
    await tick(20);
    expect(svc.creates.length).toBe(0);
    expect(s.key).toBeNull();
    expect(s.unsent).toBe(false);
  });

  test("the first edit worth keeping creates the draft once, and names its key", async () => {
    const svc = fakeService();
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ spec: "F" });
    s.edit({ spec: "Fi" });
    expect(svc.creates.length).toBe(1);
    expect((svc.creates[0]!.body as CreateTicketBody).draft).toBe(true);
    expect((svc.creates[0]!.body as CreateTicketBody).spec).toBe("F");
    svc.creates[0]!.resolve(svc.createAnswer(svc.creates[0]!.body as CreateTicketBody));
    await tick(20);
    expect(s.key).toBe("WEB-4");
    expect(svc.rekeys).toEqual([[null, "WEB-4"]]);
    // What was typed while the POST was out goes out as the first PATCH, and stays in the editor.
    expect(s.local.spec).toBe("Fi");
    expect(svc.patches.map((p) => p.body)).toEqual([{ spec: "Fi" }]);
    expect(svc.creates.length).toBe(1);
  });
});

describe("DraftSession: saving edits", () => {
  const saved = async () => {
    const svc = fakeService(true);
    const s = new DraftSession(blank(), null, svc.deps, "n1", 30);
    s.edit({ spec: "Fix the header" });
    await tick(5);
    svc.patches.length = 0;
    return { svc, s };
  };

  test("edits are debounced into one PATCH of only what changed", async () => {
    const { svc, s } = await saved();
    s.edit({ spec: "Fix the header now" });
    s.edit({ permissionMode: "ask" });
    await tick(10);
    expect(svc.patches.length).toBe(0);
    await tick(40);
    expect(svc.patches.map((p) => p.body)).toEqual([{ spec: "Fix the header now", permissionMode: "ask" }]);
    expect(s.unsent).toBe(false);
  });

  test("while edits are unsent the service's copy is ignored; once they're sent it's taken", async () => {
    const { svc, s } = await saved();
    s.edit({ spec: "mine" });
    s.receive({ ...svc.server, spec: "theirs", updatedAt: 99 });
    expect(s.local.spec).toBe("mine");
    await s.flush();
    s.receive({ ...svc.server, spec: "theirs later", permissionMode: "read_only" });
    expect(s.local.spec).toBe("theirs later");
    expect(s.local.permissionMode).toBe("read_only");
    expect(s.unsent).toBe(false);
  });

  test("another ticket's upsert is never taken", async () => {
    const { svc, s } = await saved();
    s.receive({ ...svc.server, id: "other", spec: "nope" });
    expect(s.local.spec).toBe("Fix the header");
  });

  test("moving to another project PATCHes projectId and follows the new key", async () => {
    const { svc, s } = await saved();
    s.edit({ projectId: "p2", branch: null, baseBranch: null, useWorktree: null });
    await s.flush();
    expect(svc.patches.map((p) => [p.key, p.body])).toEqual([["WEB-4", { projectId: "p2" }]]);
    expect(s.key).toBe("API-5");
    expect(svc.rekeys.at(-1)).toEqual(["WEB-4", "API-5"]);
    s.edit({ spec: "next" });
    await s.flush();
    expect(svc.patches.at(-1)!.key).toBe("API-5");
  });

  test("a failed PATCH reports and leaves the edit unsent, to go with the next one", async () => {
    const svc = fakeService();
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ spec: "x" });
    svc.creates[0]!.resolve(svc.createAnswer(svc.creates[0]!.body as CreateTicketBody));
    await tick(1);
    s.edit({ spec: "xy" });
    const flushed = s.flush();
    await tick(1);
    svc.patches[0]!.reject(new Error("409 conflict"));
    expect(await flushed).toBe(false);
    expect(svc.errors).toEqual(["409 conflict"]);
    expect(s.unsent).toBe(true);
    expect(s.local.spec).toBe("xy");
  });
});

describe("DraftSession: submit and discard", () => {
  test("submit saves what's waiting (creating it) before launching", async () => {
    const svc = fakeService(true);
    const s = new DraftSession(blank(), null, svc.deps, "n1", 1000);
    s.edit({ spec: "Ship it" });
    s.edit({ skipAgentReview: true });
    const t = await s.submit(true);
    expect(svc.creates.length).toBe(1);
    expect(svc.submits.map((p) => [p.key, p.body])).toEqual([["WEB-4", { start: true }]]);
    expect(t?.draft).toBe(false);
    expect(t?.status).toBe("in_progress");
    expect(svc.server.skipAgentReview).toBe(true);
  });

  test("a failed save means no submit", async () => {
    const svc = fakeService();
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ spec: "x" });
    const sub = s.submit(false);
    svc.creates[0]!.reject(new Error("offline"));
    expect(await sub).toBeNull();
    expect(svc.submits.length).toBe(0);
  });

  test("discard deletes a saved draft (after its create lands) and sends nothing else", async () => {
    const svc = fakeService();
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ spec: "x" });
    const gone = s.discard();
    svc.creates[0]!.resolve(svc.createAnswer(svc.creates[0]!.body as CreateTicketBody));
    expect(await gone).toBe(true);
    expect(svc.deletes).toEqual(["WEB-4"]);
    const unsaved = new DraftSession(blank(), null, svc.deps, "n2", 5);
    expect(await unsaved.discard()).toBe(true);
    expect(svc.deletes).toEqual(["WEB-4"]);
  });
});

/** An attachment as the service registered it. */
const file = (id: string, name: string, extra: Partial<Attachment> = {}): Attachment => ({ id, path: `/u/${name}`, name, source: "file", kind: name.endsWith(".png") ? "image" : "file", mimeType: "", ...extra });

describe("rebase", () => {
  test("keeps what the editor changed since the request, takes the rest from the service", () => {
    const sent = { ...blank(), spec: "a", permissionMode: null };
    const local = { ...sent, spec: "ab" };
    const server = { ...sent, id: "t1", key: "WEB-4", title: "a", permissionMode: "ask" as const };
    const out = rebase(server, sent, local);
    expect([out.id, out.key, out.title, out.spec, out.permissionMode]).toEqual(["t1", "WEB-4", "a", "ab", "ask"]);
  });

  test("an attachment added while the request was out is kept; an unchanged list takes the service's copy", () => {
    const shot = file("a1", "shot.png");
    const sent = { ...blank(), spec: "a", promptAttachments: [shot] };
    const server = { ...sent, id: "t1", key: "WEB-4", promptAttachments: [{ ...shot, mimeType: "image/png", width: 4, height: 3 }] };
    // Same files (new objects, as applyTicketPatch makes them): the service's copy, with what it knows of the file.
    expect(rebase(server, sent, { ...sent, promptAttachments: [{ ...shot }] }).promptAttachments).toEqual(server.promptAttachments);
    const added = [shot, file("a2", "notes.txt")];
    expect(rebase(server, sent, { ...sent, promptAttachments: added }).promptAttachments).toEqual(added);
  });
});

describe("DraftSession: prompt attachments", () => {
  test("attaching a file to an empty New session saves it, with the file in the create body", async () => {
    const svc = fakeService();
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    const shot = file("a1", "shot.png");
    s.edit({ promptAttachments: [shot] });
    expect(svc.creates.length).toBe(1);
    expect((svc.creates[0]!.body as CreateTicketBody).promptAttachments).toEqual([shot]);
  });

  test("removing one PATCHes the whole remaining list", async () => {
    const svc = fakeService(true);
    const a = file("a1", "a.png");
    const b = file("a2", "b.txt");
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ spec: "x", promptAttachments: [a, b] });
    await tick(20);
    s.edit({ promptAttachments: [b] });
    await tick(20);
    expect(svc.patches.map((p) => p.body)).toEqual([{ promptAttachments: [b] }]);
    expect(s.unsent).toBe(false);
  });

  test("annotating a waiting image in place PATCHes the list with its notes, which stay on it when a file before it goes", async () => {
    const svc = fakeService(true);
    const a = file("a1", "a.png");
    const b = file("a2", "b.png");
    const note: AttachmentAnnotation = { width: 10, height: 10, marks: [{ n: 1, x: 1, y: 1, message: "here" }] };
    const s = new DraftSession(blank(), null, svc.deps, "n1", 5);
    s.edit({ spec: "x", promptAttachments: [a, b] });
    await tick(20);
    // Only the notes changed: still a change worth saving.
    // By id: the service's copy of b (its own object) is the same file.
    s.edit({ promptAttachments: annotateAttachment(s.local.promptAttachments ?? [], { ...b, path: "" }, note).list });
    await tick(20);
    s.edit({ promptAttachments: removeAttachment(s.local.promptAttachments ?? [], 0) });
    await tick(20);
    expect(svc.patches.map((p) => p.body)).toEqual([{ promptAttachments: [a, { ...b, annotation: note }] }, { promptAttachments: [{ ...b, annotation: note }] }]);
    expect(s.local.promptAttachments?.[0]?.annotation).toEqual(note);
  });

  test("notes edited while a save is out are kept over the service's answer", () => {
    const shot = file("a1", "shot.png");
    const note: AttachmentAnnotation = { width: 10, height: 10, marks: [{ n: 1, x: 1, y: 1, message: "here" }] };
    const sent = { ...blank(), spec: "a", promptAttachments: [shot] };
    const server = { ...sent, id: "t1", key: "WEB-4" };
    const local = { ...sent, promptAttachments: [{ ...shot, annotation: note }] };
    expect(rebase(server, sent, local).promptAttachments).toEqual([{ ...shot, annotation: note }]);
  });
});

describe("paneDraftSession", () => {
  test("a pane keeps its session while it shows the same draft, and gets a new one for another", () => {
    const svc = fakeService(true);
    const a = paneDraftSession("p9", () => false, () => new DraftSession(blank(), null, svc.deps, "n1"));
    expect(paneDraftSession("p9", (s) => s === a, () => new DraftSession(blank(), null, svc.deps))).toBe(a);
    const b = paneDraftSession("p9", () => false, () => new DraftSession(blank(), null, svc.deps));
    expect(b).not.toBe(a);
    releaseDraftSession("p9", a, false); // not the pane's any more: no effect
    expect(paneDraftSession("p9", (s) => s === b, () => new DraftSession(blank(), null, svc.deps))).toBe(b);
    releaseDraftSession("p9", b, true);
    expect(paneDraftSession("p9", (s) => s === b, () => new DraftSession(blank(), null, svc.deps))).toBe(b);
    dropDraftSession("p9", b);
    expect(paneDraftSession("p9", (s) => s === b, () => a)).toBe(a);
  });
});

describe("unloading the page mid-debounce", () => {
  test("a pending edit goes out at once as a keepalive PATCH, only once, and the debounce never fires", async () => {
    const svc = fakeService(true);
    const sent: [string, string, unknown][] = [];
    svc.deps.keepalive = (method, path, body) => void sent.push([method, path, body]);
    const s = paneDraftSession("u1", () => false, () => new DraftSession(blank(), null, svc.deps, "n1", 30));
    s.edit({ spec: "Fix the header" });
    await tick(5);
    s.edit({ spec: "Fix the header and footer", permissionMode: "ask" });
    expect(unloadDraftSessions()).toBe(1);
    expect(sent).toEqual([["PATCH", "/tickets/WEB-4", { spec: "Fix the header and footer", permissionMode: "ask" }]]);
    // pagehide after beforeunload: nothing left to send.
    expect(unloadDraftSessions()).toBe(0);
    await tick(50);
    expect(svc.patches.length).toBe(0);
    dropDraftSession("u1", s);
  });

  test("an unsaved New session with a spec is created; an empty one, or one whose create is out, isn't", async () => {
    const svc = fakeService();
    const sent: [string, string, unknown][] = [];
    svc.deps.keepalive = (method, path, body) => void sent.push([method, path, body]);
    const empty = new DraftSession(blank(), null, svc.deps, "n1");
    expect(empty.unload()).toBe(false);
    const creating = new DraftSession(blank(), null, svc.deps, "n2");
    creating.edit({ spec: "x" }); // its POST is out (unanswered)
    expect(creating.unload()).toBe(false);
    const typed = new DraftSession({ ...blank(), spec: "Typed, never saved" }, null, svc.deps, "n3");
    expect(typed.unload()).toBe(true);
    expect(sent.map(([m, p, b]) => [m, p, (b as CreateTicketBody).spec, (b as CreateTicketBody).draft])).toEqual([["POST", "/tickets", "Typed, never saved", true]]);
  });
});
