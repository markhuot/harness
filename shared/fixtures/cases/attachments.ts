// Ticket attachment layout for HarnessKit's Attachments.swift. The shared/src/state/attachments.ts
// cases (lightbox stepping) are computed; the viewer's sizing, paging and dismiss rules (from the
// retired RN app, now only in Swift) are frozen.
import { stepAttachment } from "../../src/state/attachments";
import { cases, frozen } from "../case";

// shared/src/state/attachments.ts

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

// Frozen: the viewer (Attachments.swift is the only implementation).

export const constants = frozen("attachments", "constants");
export const fitSizeCases = frozen("attachments", "fitSizeCases");
export const clampPageCases = frozen("attachments", "clampPageCases");
export const pageAtCases = frozen("attachments", "pageAtCases");
export const shouldDismissCases = frozen("attachments", "shouldDismissCases");
export const pullOfCases = frozen("attachments", "pullOfCases");
export const dismissOnReleaseCases = frozen("attachments", "dismissOnReleaseCases");
export const formatSizeCases = frozen("attachments", "formatSizeCases");
