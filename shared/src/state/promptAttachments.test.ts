import { describe, expect, test } from "bun:test";
import type { Attachment, AttachmentAnnotation } from "../protocol";
import { applyTicketPatch, blankDraftTicket, draftCreateBody, draftIsEmpty, draftPatch } from "./drafts";
import { addAttachments, annotateAttachment, attachmentFromInput, attachmentIsImage, sameAttachments } from "./promptAttachments";

const project = { id: "p1", path: "/w", isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null, skipAgentReview: false, skipHumanReview: false };
const shot: Attachment = { id: "a1", path: "/d/shot.png", name: "shot.png", source: "file", kind: "image", mimeType: "image/png" };
const notes: Attachment = { id: "a2", path: "/d/notes.pdf", name: "notes.pdf", source: "file", kind: "file", mimeType: "application/pdf" };
const spec: Attachment = { id: "att_1", path: "/h/attachments/att_1.png", name: "After", source: "spec", kind: "image", mimeType: "image/png", width: 640, height: 480 };
const note: AttachmentAnnotation = { width: 10, height: 10, marks: [{ n: 1, x: 1, y: 1, message: "here" }] };

describe("attachment lists", () => {
  test("adding stops at the limit and counts what it left out, ignoring a file already there", () => {
    const r = addAttachments([shot], [shot, notes, spec, notes], 2);
    expect(r.list.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(r.skipped).toBe(1);
  });

  test("files are the same by id once registered, even at different paths", () => {
    expect(addAttachments([shot], [{ ...shot, path: "/elsewhere.png" }]).list).toHaveLength(1);
    expect(addAttachments([shot], [{ ...shot, id: "a9" }]).list).toHaveLength(2);
  });

  test("an attachment alone makes a draft worth saving, and the create body carries it whole", () => {
    const blank = blankDraftTicket(project, null, "WEB-1");
    expect(draftIsEmpty(blank, project, null)).toBe(true);
    const withFile = applyTicketPatch(blank, { promptAttachments: [shot] });
    expect(withFile.promptAttachments).toEqual([shot]);
    expect(draftIsEmpty(withFile, project, null)).toBe(false);
    expect(draftCreateBody(withFile, project).promptAttachments).toEqual([shot]);
  });

  test("a bare path input gets the service's defaults until the service answers", () => {
    expect(attachmentFromInput({ path: "/a/b/clip.MOV" })).toEqual({ id: "", path: "/a/b/clip.MOV", name: "clip.MOV", source: "file", kind: "video", mimeType: "" });
    expect(attachmentFromInput({ path: "/a/report", name: "  Report " }).kind).toBe("file");
    expect(attachmentFromInput(spec)).toEqual(spec);
  });

  test("a draft patch sends the list only when it changed, an annotation counting as a change", () => {
    const a = { ...blankDraftTicket(project, null, "WEB-1"), promptAttachments: [shot] };
    expect(draftPatch(a, { ...a, promptAttachments: [{ ...shot }] })).toBeNull();
    expect(draftPatch(a, { ...a, promptAttachments: [] })).toEqual({ promptAttachments: [] });
    expect(draftPatch(a, { ...a, promptAttachments: [{ ...shot, annotation: note }] })).toEqual({ promptAttachments: [{ ...shot, annotation: note }] });
    expect(sameAttachments([shot], [{ ...shot, name: "renamed.png" }])).toBe(false);
  });

  test("annotating a file already in the list sets its annotation in place; another file is added", () => {
    const r = annotateAttachment([shot, spec], spec, note);
    expect(r.list.map((a) => [a.id, a.annotation ?? null])).toEqual([
      ["a1", null],
      ["att_1", note],
    ]);
    // Taking it off leaves the file.
    expect(annotateAttachment(r.list, spec, null).list[1]).toEqual(spec);
    expect(annotateAttachment([shot], spec, note).list).toEqual([shot, { ...spec, annotation: note }]);
    expect(annotateAttachment([shot, notes], spec, note, 2)).toEqual({ list: [shot, notes], skipped: true });
  });

  test("previews go by kind, not by name", () => {
    expect(attachmentIsImage(spec)).toBe(true);
    expect(attachmentIsImage({ kind: "file" })).toBe(false);
    expect(attachmentIsImage({ kind: "video" })).toBe(false);
  });
});
