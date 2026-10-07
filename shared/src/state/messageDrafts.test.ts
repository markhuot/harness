import { describe, expect, test } from "bun:test";
import type { Attachment, MessageDraft } from "../protocol";
import { adoptMessageDraft, EMPTY_MESSAGE_DRAFT, hasMessageDraft, messageDraftBody, newDraftOrigin, type MessageDraftValue } from "./messageDrafts";

const file: Attachment = { id: "a1", path: "/u/a.png", name: "a.png", source: "upload", kind: "image", mimeType: "image/png" };
const saved = (text: string, origin: string | null, attachments: Attachment[] = []): MessageDraft => ({ text, attachments, origin, updatedAt: 1 });
const shown = (text: string, attachments: Attachment[] = []): MessageDraftValue => ({ text, attachments });
const base = { origin: "me", focused: false, dirty: false };

describe("hasMessageDraft", () => {
  test("none, or only blank text, isn't a draft", () => {
    expect(hasMessageDraft(null)).toBe(false);
    expect(hasMessageDraft(undefined)).toBe(false);
    expect(hasMessageDraft(saved(" \n\t", "me"))).toBe(false);
  });

  test("text or files are", () => {
    expect(hasMessageDraft(saved("hi", "me"))).toBe(true);
    expect(hasMessageDraft(saved("", "me", [file]))).toBe(true);
  });
});

describe("adoptMessageDraft", () => {
  test("another device's draft replaces what an idle composer shows", () => {
    expect(adoptMessageDraft({ ...base, saved: saved("from the phone", "phone"), shown: shown("") })).toEqual(shown("from the phone"));
  });

  test("its own save coming back is skipped, even a stale one", () => {
    expect(adoptMessageDraft({ ...base, saved: saved("hel", "me"), shown: shown("hello") })).toBeNull();
  });

  test("nothing replaces the field while it has focus (uncontrolled while typing)", () => {
    expect(adoptMessageDraft({ ...base, focused: true, saved: saved("from the phone", "phone"), shown: shown("mine") })).toBeNull();
  });

  test("unsaved edits aren't overwritten", () => {
    expect(adoptMessageDraft({ ...base, dirty: true, saved: saved("from the phone", "phone"), shown: shown("mine") })).toBeNull();
  });

  test("a cleared draft (sent from another device) empties an idle composer", () => {
    expect(adoptMessageDraft({ ...base, saved: null, shown: shown("half written", [file]) })).toEqual(EMPTY_MESSAGE_DRAFT);
  });

  test("a draft with no origin counts as another editor's", () => {
    expect(adoptMessageDraft({ ...base, saved: saved("from the CLI", null), shown: shown("") })).toEqual(shown("from the CLI"));
  });

  test("the same text and files: nothing to change", () => {
    expect(adoptMessageDraft({ ...base, saved: saved("same", "phone", [file]), shown: shown("same", [{ ...file }]) })).toBeNull();
    expect(adoptMessageDraft({ ...base, saved: null, shown: shown("") })).toBeNull();
  });

  test("a change to the files alone is adopted", () => {
    expect(adoptMessageDraft({ ...base, saved: saved("same", "phone", [file]), shown: shown("same") })).toEqual(shown("same", [file]));
  });
});

test("messageDraftBody carries the origin and the files as inputs", () => {
  expect(messageDraftBody(shown("hi", [file]), "me")).toEqual({ text: "hi", attachments: [{ ...file }], origin: "me" });
});

test("newDraftOrigin is unique per editor", () => {
  const a = newDraftOrigin();
  expect(a).toMatch(/^[0-9a-f]{16}$/);
  expect(newDraftOrigin()).not.toBe(a);
});
