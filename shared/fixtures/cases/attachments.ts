// Summary attachment layout for HarnessKit's Attachments.swift. The shared/src/state/attachments.ts
// cases are computed; the viewer's sizing, paging and dismiss rules (from the retired RN app, now
// only in Swift) are frozen.
import { attachmentsLabel, stepAttachment, thumbnailBox } from "../../src/state/attachments";
import { cases, frozen } from "../case";

type Dims = { kind?: "image" | "video" | "other"; width?: number; height?: number };

// shared/src/state/attachments.ts

export const thumbnailBoxCases = cases(({ a, height }: { a: Dims; height: number }) => thumbnailBox(a, height), {
  // attachments.test.ts
  "keeps aspect": { a: { width: 1600, height: 900 }, height: 90 },
  "clamps wide": { a: { width: 4000, height: 400 }, height: 100 },
  "clamps tall": { a: { width: 390, height: 2400 }, height: 100 },
  unknown: { a: {}, height: 90 },
  "width only": { a: { width: 800 }, height: 90 },
  "zero height": { a: { width: 800, height: 0 }, height: 90 },
  // more
  "negative width": { a: { width: -800, height: 600 }, height: 90 },
  "exactly 5:2": { a: { width: 500, height: 200 }, height: 100 },
  "exactly 1:2": { a: { width: 100, height: 200 }, height: 100 },
  "rounds half up": { a: { width: 3, height: 2 }, height: 5 },
  "fractional height": { a: { width: 1, height: 1 }, height: 33.3 },
  "zero box height": { a: { width: 4, height: 3 }, height: 0 },
});

export const stepAttachmentCases = cases(({ index, delta, count }: { index: number; delta: number; count: number }) => stepAttachment(index, delta, count), {
  // attachments.test.ts
  forward: { index: 1, delta: 1, count: 4 },
  back: { index: 2, delta: -1, count: 4 },
  "wraps forward": { index: 3, delta: 1, count: 4 },
  "wraps back": { index: 0, delta: -1, count: 4 },
  "single forward": { index: 0, delta: 1, count: 1 },
  "single back": { index: 0, delta: -1, count: 1 },
  none: { index: 0, delta: 1, count: 0 },
  // more
  "negative count": { index: 2, delta: 1, count: -3 },
  "big jump back": { index: 1, delta: -10, count: 4 },
  "big jump forward": { index: 1, delta: 10, count: 4 },
  "index out of range": { index: 9, delta: 0, count: 4 },
});

export const attachmentsLabelCases = cases((kinds: string[]) => attachmentsLabel(kinds.map((kind) => ({ kind }) as { kind: "image" | "video" })), {
  // attachments.test.ts
  "one image": ["image"],
  "two videos": ["video", "video"],
  mixed: ["video", "image", "image"],
  none: [],
  // more
  "one of each": ["image", "video"],
  "unknown kinds count as videos": ["image", "audio"],
  "many images": ["image", "image", "image", "image", "image", "image", "image", "image", "image", "image", "image"],
});

// Frozen: the viewer (Attachments.swift is the only implementation).

export const constants = frozen("attachments", "constants");
export const thumbSizeCases = frozen("attachments", "thumbSizeCases");
export const thumbSizeCustomCases = frozen("attachments", "thumbSizeCustomCases");
export const fitSizeCases = frozen("attachments", "fitSizeCases");
export const clampPageCases = frozen("attachments", "clampPageCases");
export const pageAtCases = frozen("attachments", "pageAtCases");
export const shouldDismissCases = frozen("attachments", "shouldDismissCases");
export const pullOfCases = frozen("attachments", "pullOfCases");
export const dismissOnReleaseCases = frozen("attachments", "dismissOnReleaseCases");
export const formatSizeCases = frozen("attachments", "formatSizeCases");
