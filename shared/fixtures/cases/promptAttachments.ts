// Attachment list helpers (shared/src/state/promptAttachments.ts) for HarnessKit's
// State/PromptAttachments.swift.
import type { Attachment, AttachmentAnnotation, AttachmentInput } from "../../src/protocol";
import {
  addAttachments,
  annotateAttachment,
  attachmentFromInput,
  attachmentInputs,
  attachmentIsImage,
  fileBaseName,
  pastedImageName,
  removeAttachment,
  sameAttachments,
} from "../../src/state/promptAttachments";
import { cases } from "../case";

const shot: Attachment = { id: "a1", path: "/Users/me/Desktop/shot.png", name: "shot.png", source: "file", kind: "image", mimeType: "image/png" };
const notes: Attachment = { id: "a2", path: "/Users/me/notes.pdf", name: "notes.pdf", source: "file", kind: "file", mimeType: "application/pdf", size: 912 };
const paste: Attachment = { id: "a3", path: "/Users/me/.harness/uploads/u1/Pasted image.png", name: "Pasted image.png", source: "upload", kind: "image", mimeType: "image/png", width: 800, height: 600 };
const spec: Attachment = { id: "att_1", path: "/Users/me/.harness/attachments/att_1.png", name: "After", source: "spec", kind: "image", mimeType: "image/png", width: 640, height: 480 };
const note: AttachmentAnnotation = { width: 640, height: 480, marks: [{ n: 1, x: 10, y: 20, tailX: 200, tailY: 120, message: "here" }] };

export const fileBaseNameCases = cases(fileBaseName, {
  "a file": "/a/b/shot.png",
  "a trailing slash": "/a/b/folder/",
  "no slash": "shot.png",
  "root": "/",
  "spaces": "/Users/me/My Notes/a b.txt",
});

export const attachmentFromInputCases = cases((i: AttachmentInput) => attachmentFromInput(i), {
  "a full attachment stays as it is": spec,
  "an annotated one keeps its notes": { ...paste, annotation: note },
  "a bare path: name and kind from it": { path: "/a/shot.PNG" },
  "a video": { path: "/a/flow.mov" },
  "another file": { path: "/a/report.pdf" },
  "a given name, trimmed": { path: "/a/shot.png", name: " After " },
  "a blank name falls back": { path: "/a/shot.png", name: "  " },
  "a bare id": { id: "att_9" },
});

export const attachmentInputsCases = cases((list: Attachment[]) => attachmentInputs(list), {
  none: [],
  "each whole, annotations included": [shot, { ...spec, annotation: note }],
});

export const sameAttachmentsCases = cases(({ x, y }: { x: Attachment[]; y: Attachment[] }) => sameAttachments(x, y), {
  "both empty": { x: [], y: [] },
  same: { x: [shot, paste], y: [shot, paste] },
  reordered: { x: [shot, paste], y: [paste, shot] },
  renamed: { x: [shot], y: [{ ...shot, name: "other.png" }] },
  "another id": { x: [shot], y: [{ ...shot, id: "a9" }] },
  "an annotation added": { x: [spec], y: [{ ...spec, annotation: note }] },
  "an annotation changed": { x: [{ ...spec, annotation: note }], y: [{ ...spec, annotation: { ...note, marks: [{ ...note.marks[0]!, message: "there" }] } }] },
  "size alone doesn't count": { x: [shot], y: [{ ...shot, size: 99 }] },
  longer: { x: [shot], y: [shot, paste] },
});

type AddInput = { list: Attachment[]; added: Attachment[]; max?: number };
export const addAttachmentsCases = cases(({ list, added, max }: AddInput) => addAttachments(list, added, max), {
  "appends in order": { list: [shot], added: [notes, paste] },
  "an id already attached is skipped": { list: [shot], added: [{ ...shot, name: "again" }] },
  "the same id at another path is the same file": { list: [shot], added: [{ ...shot, path: "/moved.png" }] },
  "twice in one add is attached once": { list: [], added: [paste, paste] },
  "the limit leaves the rest out": { list: [shot, notes], added: [paste, spec, { ...spec, id: "att_2" }], max: 3 },
  "a duplicate past the limit isn't counted as skipped": { list: [shot], added: [shot, paste], max: 1 },
  "nothing added": { list: [shot], added: [] },
});

type AnnotateInput = { list: Attachment[]; attachment: Attachment; annotation: AttachmentAnnotation | null; max?: number };
export const annotateAttachmentCases = cases(({ list, attachment, annotation, max }: AnnotateInput) => annotateAttachment(list, attachment, annotation, max), {
  "a file already there is annotated in place": { list: [shot, spec], attachment: spec, annotation: note },
  "null takes it off and keeps the file": { list: [shot, { ...spec, annotation: note }], attachment: spec, annotation: null },
  "another file is added with it": { list: [shot], attachment: spec, annotation: note },
  "a full list skips a new file": { list: [shot, notes], attachment: spec, annotation: note, max: 2 },
});

export const removeAttachmentCases = cases(({ list, index }: { list: Attachment[]; index: number }) => removeAttachment(list, index), {
  first: { list: [shot, notes, paste], index: 0 },
  last: { list: [shot, notes, paste], index: 2 },
  "out of range": { list: [shot], index: 4 },
  negative: { list: [shot], index: -1 },
});

export const attachmentIsImageCases = cases((x: Pick<Attachment, "kind">) => attachmentIsImage(x), {
  image: { kind: "image" },
  video: { kind: "video" },
  file: { kind: "file" },
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
