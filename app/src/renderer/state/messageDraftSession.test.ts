import { describe, expect, test } from "bun:test";
import type { Attachment, MessageDraft, MessageDraftBody, Ticket } from "@harness/shared";
import { MessageDraftSession, type MessageDraftDeps } from "./messageDraftSession";

const file: Attachment = { id: "a1", path: "/u/a.png", name: "a.png", source: "upload", kind: "image", mimeType: "image/png" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake service: each PUT waits until the test answers it (or answers at once with `auto`). */
function fakeService(auto = true) {
  const puts: { key: string; body: MessageDraftBody; resolve(): void; reject(e: Error): void }[] = [];
  const upserts: Ticket[] = [];
  const errors: string[] = [];
  const keepalives: [string, unknown][] = [];
  const deps: MessageDraftDeps = {
    save: (key, body) =>
      new Promise<Ticket>((resolve, reject) => {
        const t = { id: "t1", key, messageDraft: body.text ? { text: body.text, attachments: [], origin: body.origin ?? null, updatedAt: 1 } : null } as Ticket;
        const p = { key, body, resolve: () => resolve(t), reject };
        puts.push(p);
        if (auto) queueMicrotask(p.resolve);
      }),
    upsert: (t) => void upserts.push(t),
    error: (m) => void errors.push(m),
  };
  return { deps, puts, upserts, errors, keepalives };
}

const draft = (text: string, origin: string | null): MessageDraft => ({ text, attachments: [], origin, updatedAt: 1 });

describe("MessageDraftSession", () => {
  test("starts from the ticket's saved draft", () => {
    const s = new MessageDraftSession("WEB-1", draft("from the phone", "phone"), fakeService().deps, 5);
    expect(s.value.text).toBe("from the phone");
    expect(s.dirty).toBe(false);
  });

  test("typing is debounced into one PUT of the whole draft, tagged with its origin", async () => {
    const svc = fakeService();
    const s = new MessageDraftSession("WEB-1", null, svc.deps, 5);
    s.edit({ text: "h" });
    s.edit({ text: "hi" });
    s.edit({ attachments: [file] });
    expect(svc.puts).toHaveLength(0);
    await tick(15);
    expect(svc.puts.map((p) => [p.key, p.body])).toEqual([["WEB-1", { text: "hi", attachments: [{ ...file }], origin: s.origin }]]);
    expect(s.dirty).toBe(false);
    expect(svc.upserts).toHaveLength(1);
  });

  test("one PUT at a time: an edit made while one is out goes after it", async () => {
    const svc = fakeService(false);
    const s = new MessageDraftSession("WEB-1", null, svc.deps, 1);
    s.edit({ text: "a" });
    await tick(5);
    expect(svc.puts).toHaveLength(1);
    s.edit({ text: "ab" });
    await tick(5);
    expect(svc.puts).toHaveLength(1);
    svc.puts[0]!.resolve();
    await tick(5);
    expect(svc.puts.map((p) => p.body.text)).toEqual(["a", "ab"]);
    svc.puts[1]!.resolve();
    await tick();
    expect(s.dirty).toBe(false);
  });

  test("its own echo never rewrites the field, even after a later edit", async () => {
    const svc = fakeService();
    const s = new MessageDraftSession("WEB-1", null, svc.deps, 1);
    s.edit({ text: "hel" });
    await tick(5);
    s.edit({ text: "hello" });
    await tick(5);
    s.sync(draft("hel", s.origin));
    expect(s.value.text).toBe("hello");
  });

  test("another device's edit shows only while the field doesn't have focus, and catches up on blur", () => {
    const s = new MessageDraftSession("WEB-1", null, fakeService().deps, 1);
    s.focus(true, null);
    s.sync(draft("from the phone", "phone"));
    expect(s.value.text).toBe("");
    s.focus(false, draft("from the phone", "phone"));
    expect(s.value.text).toBe("from the phone");
    // What it took counts as saved: nothing to send back.
    expect(s.dirty).toBe(false);
  });

  test("a failed save keeps the edit and says so", async () => {
    const svc = fakeService(false);
    const s = new MessageDraftSession("WEB-1", null, svc.deps, 1);
    s.edit({ text: "keep" });
    await tick(5);
    svc.puts[0]!.reject(new Error("offline"));
    await tick();
    expect(s.value.text).toBe("keep");
    expect(s.dirty).toBe(true);
    expect(svc.errors).toEqual(["Couldn't save the message draft: offline"]);
    // Another device's copy doesn't replace it either.
    s.sync(draft("theirs", "phone"));
    expect(s.value.text).toBe("keep");
  });

  test("beforeSend cancels the waiting save and waits for the one on its way; sent() clears it and keeps files added meanwhile", async () => {
    const svc = fakeService(false);
    const s = new MessageDraftSession("WEB-1", null, svc.deps, 1);
    s.edit({ text: "go" });
    await tick(5);
    s.edit({ text: "go!", attachments: [file] });
    const waiting = s.beforeSend();
    svc.puts[0]!.resolve();
    await waiting;
    await tick(5);
    // The debounced "go!" never went out: the message carries it.
    expect(svc.puts).toHaveLength(1);
    const late: Attachment = { ...file, id: "a2", path: "/u/b.png" };
    s.edit({ attachments: [file, late] });
    s.sent([file]);
    expect(s.value).toEqual({ text: "", attachments: [late] });
    await tick(5);
    expect(svc.puts.at(-1)!.body).toEqual({ text: "", attachments: [{ ...late }], origin: s.origin });
  });

  test("a send with nothing added meanwhile leaves it clean and empty", async () => {
    const svc = fakeService();
    const s = new MessageDraftSession("WEB-1", draft("hi", "phone"), svc.deps, 1);
    await s.beforeSend();
    s.sent([]);
    expect(s.value).toEqual({ text: "", attachments: [] });
    expect(s.dirty).toBe(false);
    await tick(5);
    expect(svc.puts).toHaveLength(0);
  });

  test("unload sends what's waiting as a keepalive PUT, once", () => {
    const svc = fakeService();
    const sent: [string, unknown][] = [];
    const s = new MessageDraftSession("WEB-1", null, { ...svc.deps, keepalive: (path, body) => void sent.push([path, body]) }, 1000);
    s.edit({ text: "closing" });
    expect(s.unload()).toBe(true);
    expect(s.unload()).toBe(false);
    expect(sent).toEqual([["/tickets/WEB-1/message-draft", { text: "closing", attachments: [], origin: s.origin }]]);
  });
});

test("a failed send picks saving back up with what's in the field", async () => {
  const svc = fakeService();
  const s = new MessageDraftSession("WEB-1", null, svc.deps, 1);
  s.edit({ text: "retry me" });
  await s.beforeSend();
  s.edit({ text: "retry me!" });
  await tick(5);
  expect(svc.puts).toHaveLength(0);
  s.sendFailed();
  await tick(5);
  expect(svc.puts.map((p) => p.body.text)).toEqual(["retry me!"]);
});
