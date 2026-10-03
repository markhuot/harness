import { describe, expect, test } from "bun:test";
import type { PromptAttachment } from "../protocol";
import { applyTicketPatch, blankDraftTicket, draftCreateBody, draftIsEmpty, draftPatch } from "./drafts";
import { addPromptAttachments, promptAttachmentIsImage } from "./promptAttachments";

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

  test("previews go by extension, then the path", () => {
    expect(promptAttachmentIsImage({ name: "Notes", path: "/a/b.JPG" })).toBe(true);
    expect(promptAttachmentIsImage({ name: "b.pdf", path: "/a/b.png" })).toBe(false);
  });
});
