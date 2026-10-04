import { describe, expect, test } from "bun:test";
import type { AttachmentAnnotation, PromptAttachment } from "../protocol";
import { applyTicketPatch, blankDraftTicket, draftCreateBody, draftIsEmpty, draftPatch } from "./drafts";
import { addPromptAttachments, annotatePromptAttachment, promptAttachmentIsImage, specAttachmentIdOf, specAttachmentPath } from "./promptAttachments";

const project = { id: "p1", path: "/w", isGit: true, useWorktrees: true, defaultDriver: null, defaultModels: {}, baseBranch: null, skipAgentReview: false, skipHumanReview: false };
const shot: PromptAttachment = { path: "/d/shot.png", name: "shot.png", source: "file" };

describe("prompt attachments", () => {
  test("adding stops at the limit and counts what it left out, ignoring duplicates", () => {
    const r = addPromptAttachments([shot], [{ path: shot.path }, { path: "/a" }, { path: "/b" }, { path: "/a" }], 2);
    expect(r.list.map((a) => a.path)).toEqual([shot.path, "/a"]);
    expect(r.skipped).toBe(1);
  });

  test("an attachment alone makes a draft worth saving, and the create body carries it", () => {
    const blank = blankDraftTicket(project, null, "WEB-1");
    expect(draftIsEmpty(blank, project, null)).toBe(true);
    const withFile = applyTicketPatch(blank, { promptAttachments: [{ path: "/d/x.png", source: "upload" }] });
    expect(withFile.promptAttachments).toEqual([{ path: "/d/x.png", name: "x.png", source: "upload" }]);
    expect(draftIsEmpty(withFile, project, null)).toBe(false);
    expect(draftCreateBody(withFile, project).promptAttachments).toEqual([{ path: "/d/x.png", name: "x.png" }]);
  });

  test("a draft patch sends the list only when it changed", () => {
    const a = { ...blankDraftTicket(project, null, "WEB-1"), promptAttachments: [shot] };
    expect(draftPatch(a, { ...a, promptAttachments: [{ ...shot }] })).toBeNull();
    expect(draftPatch(a, { ...a, promptAttachments: [] })).toEqual({ promptAttachments: [] });
  });

  const note: AttachmentAnnotation = { width: 10, height: 10, marks: [{ n: 1, x: 1, y: 1, message: "here" }] };

  test("annotating a file already in the list sets its annotation in place; another file is added", () => {
    const list: PromptAttachment[] = [shot, { path: "/d/b.png", name: "b.png", source: "file" }];
    const r = annotatePromptAttachment(list, { path: "/d/b.png" }, note);
    expect(r.list.map((a) => [a.path, a.annotation ?? null])).toEqual([
      [shot.path, null],
      ["/d/b.png", note],
    ]);
    // Taking it off leaves the file.
    expect(annotatePromptAttachment(r.list, { path: "/d/b.png" }, null).list[1]).toEqual({ path: "/d/b.png", name: "b.png", source: "file" });
    const added = annotatePromptAttachment(list, { path: specAttachmentPath("att_1"), name: "after.png" }, note);
    expect(added.list[2]).toEqual({ path: "attachment:att_1", name: "after.png", source: "file", annotation: note });
    expect(annotatePromptAttachment(list, { path: "/d/c.png" }, note, 2)).toEqual({ list, skipped: true });
  });

  test("an annotation change is a change: the draft patch sends the list with it", () => {
    const a = { ...blankDraftTicket(project, null, "WEB-1"), promptAttachments: [shot] };
    const b = { ...a, promptAttachments: [{ ...shot, annotation: note }] };
    expect(draftPatch(a, b)).toEqual({ promptAttachments: [{ path: shot.path, name: shot.name, annotation: note }] });
    expect(draftCreateBody(b, project).promptAttachments).toEqual([{ path: shot.path, name: shot.name, annotation: note }]);
    expect(applyTicketPatch(a, { promptAttachments: [{ path: shot.path, annotation: note }] }).promptAttachments).toEqual([{ ...shot, annotation: note }]);
  });

  test("spec images are referenced as attachment:<id> until the service resolves them", () => {
    expect(specAttachmentIdOf(specAttachmentPath("att_9"))).toBe("att_9");
    expect(specAttachmentIdOf("/Users/me/attachment:x.png")).toBeNull();
    expect(specAttachmentIdOf("attachment:")).toBeNull();
  });

  test("previews go by extension, then the path", () => {
    expect(promptAttachmentIsImage({ name: "Notes", path: "/a/b.JPG" })).toBe(true);
    expect(promptAttachmentIsImage({ name: "b.pdf", path: "/a/b.png" })).toBe(false);
  });
});
