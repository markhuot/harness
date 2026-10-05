// Message drafts (shared/src/state/messageDrafts.ts) for HarnessKit's State/MessageDrafts.swift.
import type { Attachment, MessageDraft } from "../../src/protocol";
import { adoptMessageDraft, messageDraftBody, type AdoptMessageDraftInput, type MessageDraftValue } from "../../src/state/messageDrafts";
import { cases } from "../case";

const shot: Attachment = { id: "a1", path: "/Users/me/.harness/uploads/u1/shot.png", name: "shot.png", source: "upload", kind: "image", mimeType: "image/png" };
const noted: Attachment = { ...shot, annotation: { width: 640, height: 480, marks: [{ n: 1, x: 10, y: 20, message: "here" }] } };
const saved = (text: string, origin: string | null, attachments: Attachment[] = []): MessageDraft => ({ text, attachments, origin, updatedAt: 1_759_190_000_000 });
const shown = (text: string, attachments: Attachment[] = []): MessageDraftValue => ({ text, attachments });
const idle = { origin: "me", focused: false, dirty: false };

export const adoptMessageDraftCases = cases((i: AdoptMessageDraftInput) => adoptMessageDraft(i), {
  "another device's draft replaces an idle composer's": { ...idle, saved: saved("from the phone", "phone"), shown: shown("") },
  "its own save coming back is skipped": { ...idle, saved: saved("hel", "me"), shown: shown("hello") },
  "nothing replaces the field while it has focus": { ...idle, focused: true, saved: saved("from the phone", "phone"), shown: shown("mine") },
  "unsaved edits aren't overwritten": { ...idle, dirty: true, saved: saved("from the phone", "phone"), shown: shown("mine") },
  "a cleared draft empties an idle composer": { ...idle, saved: null, shown: shown("half written", [shot]) },
  "a draft with no origin counts as another editor's": { ...idle, saved: saved("from the CLI", null), shown: shown("") },
  "the same text and files change nothing": { ...idle, saved: saved("same", "phone", [shot]), shown: shown("same", [shot]) },
  "nothing saved and nothing shown": { ...idle, saved: null, shown: shown("") },
  "a change to the files alone is adopted": { ...idle, saved: saved("same", "phone", [shot]), shown: shown("same") },
  "a change to a file's notes is adopted": { ...idle, saved: saved("same", "phone", [noted]), shown: shown("same", [shot]) },
});

export const messageDraftBodyCases = cases(({ value, origin }: { value: MessageDraftValue; origin: string }) => messageDraftBody(value, origin), {
  "text only": { value: shown("hi"), origin: "me" },
  "files with their notes": { value: shown("", [noted]), origin: "me" },
  "empty (clears it)": { value: shown(""), origin: "me" },
});
