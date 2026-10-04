// Prompt attachment helpers (shared/src/state/promptAttachments.ts) for HarnessKit's
// State/PromptAttachments.swift.
import type { PromptAttachment, PromptAttachmentInput } from "../../src/protocol";
import {
  addPromptAttachments,
  annotatePromptAttachment,
  specAttachmentIdOf,
  specAttachmentPath,
  fileBaseName,
  pastedImageName,
  promptAttachmentFromInput,
  promptAttachmentInputs,
  promptAttachmentIsImage,
  removePromptAttachment,
  samePromptAttachments,
} from "../../src/state/promptAttachments";
import { cases } from "../case";

const a = (path: string, name = fileBaseName(path), source: PromptAttachment["source"] = "file"): PromptAttachment => ({ path, name, source });
const shot = a("/Users/me/Desktop/shot.png");
const notes = a("/Users/me/notes.pdf");
const paste = a("/Users/me/.harness/uploads/u1/Pasted image.png", "Pasted image.png", "upload");

export const fileBaseNameCases = cases(fileBaseName, {
  "a file": "/a/b/shot.png",
  "a trailing slash": "/a/b/folder/",
  "no slash": "shot.png",
  "root": "/",
  "spaces": "/Users/me/My Notes/a b.txt",
});

export const promptAttachmentFromInputCases = cases((i: PromptAttachmentInput) => promptAttachmentFromInput(i), {
  "name from the path": { path: "/a/shot.png" },
  "a given name": { path: "/a/shot.png", name: "After" },
  "a blank name falls back": { path: "/a/shot.png", name: "  " },
  "a name is trimmed": { path: "/a/shot.png", name: " After " },
  "an upload keeps its source": { path: "/u/x.png", source: "upload" },
});

export const promptAttachmentInputsCases = cases((list: PromptAttachment[]) => promptAttachmentInputs(list), {
  none: [],
  "path and name only": [shot, paste],
});

export const samePromptAttachmentsCases = cases(({ x, y }: { x: PromptAttachment[]; y: PromptAttachment[] }) => samePromptAttachments(x, y), {
  "both empty": { x: [], y: [] },
  same: { x: [shot, paste], y: [shot, paste] },
  reordered: { x: [shot, paste], y: [paste, shot] },
  renamed: { x: [shot], y: [{ ...shot, name: "other.png" }] },
  "source alone doesn't count": { x: [shot], y: [{ ...shot, source: "upload" }] },
  longer: { x: [shot], y: [shot, paste] },
});

type AddInput = { list: PromptAttachment[]; added: PromptAttachmentInput[]; max?: number };
export const addPromptAttachmentsCases = cases(({ list, added, max }: AddInput) => addPromptAttachments(list, added, max), {
  "appends in order": { list: [shot], added: [{ path: notes.path }, { path: paste.path, name: paste.name, source: "upload" }] },
  "a path already attached is skipped": { list: [shot], added: [{ path: shot.path, name: "again" }] },
  "a path twice in one add is attached once": { list: [], added: [{ path: "/x.png" }, { path: "/x.png" }] },
  "the limit leaves the rest out": { list: [shot, notes], added: [{ path: "/1.png" }, { path: "/2.png" }, { path: "/3.png" }], max: 3 },
  "a duplicate past the limit isn't counted as skipped": { list: [shot], added: [{ path: shot.path }, { path: "/2.png" }], max: 1 },
  "nothing added": { list: [shot], added: [] },
});

export const removePromptAttachmentCases = cases(({ list, index }: { list: PromptAttachment[]; index: number }) => removePromptAttachment(list, index), {
  first: { list: [shot, notes, paste], index: 0 },
  last: { list: [shot, notes, paste], index: 2 },
  "out of range": { list: [shot], index: 4 },
  negative: { list: [shot], index: -1 },
});

export const promptAttachmentIsImageCases = cases((x: { name: string; path: string }) => promptAttachmentIsImage(x), {
  png: { name: "shot.png", path: "/a/shot.png" },
  "upper-case JPG": { name: "IMG.JPG", path: "/a/IMG.JPG" },
  jpeg: { name: "a.jpeg", path: "/a/a.jpeg" },
  webp: { name: "a.webp", path: "/a/a.webp" },
  gif: { name: "a.gif", path: "/a/a.gif" },
  bmp: { name: "a.bmp", path: "/a/a.bmp" },
  pdf: { name: "notes.pdf", path: "/a/notes.pdf" },
  heic: { name: "IMG.heic", path: "/a/IMG.heic" },
  "no extension": { name: "Makefile", path: "/a/Makefile" },
  "a name without one falls back to the path": { name: "After", path: "/a/shot.png" },
  "a dot folder isn't an extension": { name: "file", path: "/a.png/file" },
});

export const pastedImageNameCases = cases((m: string | null) => pastedImageName(m), {
  png: "image/png",
  jpeg: "image/jpeg",
  "upper case": "IMAGE/WEBP",
  gif: "image/gif",
  tiff: "image/tiff",
  unknown: "image/x-foo",
  empty: "",
  none: null,
});

const note = { width: 10, height: 10, marks: [{ n: 1, x: 1, y: 1, message: "here" }] };
export const annotatePromptAttachmentCases = cases(
  ({ list, input, annotation, max }: { list: PromptAttachment[]; input: PromptAttachmentInput; annotation: typeof note | null; max?: number }) => annotatePromptAttachment(list, input, annotation, max),
  {
    "a file already there gets the annotation in place": { list: [shot, notes], input: { path: shot.path }, annotation: note },
    "null takes it off": { list: [{ ...shot, annotation: note }, notes], input: { path: shot.path }, annotation: null },
    "a new file is added with it": { list: [shot], input: { path: specAttachmentPath("att_1"), name: "after.png" }, annotation: note },
    "a full list skips a new file": { list: [shot, notes], input: { path: "/x.png" }, annotation: note, max: 2 },
  },
);

export const specAttachmentIdOfCases = cases(specAttachmentIdOf, {
  "a reference": specAttachmentPath("att_9"),
  "a path": "/Users/me/attachment:x.png",
  "no id": "attachment:",
});
