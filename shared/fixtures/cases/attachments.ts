// Summary attachment layout (shared/src/state/attachments.ts and mobile/src/lib/attachments.ts)
// for HarnessKit's Attachments.swift.
import { clampPage, DISMISS, dismissOnRelease, fitSize, formatSize, pageAt, pullOf, shouldDismiss, THUMB, thumbSize } from "../../../mobile/src/lib/attachments";
import { attachmentsLabel, stepAttachment, thumbnailBox } from "../../src/state/attachments";
import { cases } from "../case";

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

// mobile/src/lib/attachments.ts

export const constants = { THUMB, DISMISS };

export const thumbSizeCases = cases((a: Dims) => thumbSize(a as never), {
  // attachments.test.ts
  "4:3": { kind: "image", width: 1600, height: 1200 },
  square: { kind: "image", width: 1000, height: 1000 },
  panorama: { kind: "image", width: 4000, height: 500 },
  "tall phone shot": { kind: "image", width: 1179, height: 2556 },
  unknown: { kind: "image" },
  zero: { kind: "image", width: 0, height: 0 },
  "width only": { kind: "image", width: 800 },
  video: { kind: "video" },
  // more
  "video with dimensions": { kind: "video", width: 1000, height: 1000 },
  "unknown kind defaults to 4:3": { kind: "other" },
  "negative height": { kind: "video", width: 100, height: -100 },
  "at max": { kind: "image", width: 2000, height: 1000 },
  "at min": { kind: "image", width: 600, height: 1000 },
});

export const thumbSizeCustomCases = cases(({ a, t }: { a: Dims; t: { height: number; minWidth: number; maxWidth: number } }) => thumbSize(a as never, t), {
  "custom row": { a: { kind: "image", width: 300, height: 100 }, t: { height: 50, minWidth: 10, maxWidth: 1000 } },
  "custom clamp": { a: { kind: "image", width: 300, height: 100 }, t: { height: 50, minWidth: 10, maxWidth: 100 } },
  "rounds half up": { a: { kind: "image", width: 3, height: 2 }, t: { height: 5, minWidth: 0, maxWidth: 100 } },
});

const screen = { width: 390, height: 700 };

export const fitSizeCases = cases(({ a, box }: { a: Dims; box: { width: number; height: number } }) => fitSize(a as never, box), {
  // attachments.test.ts
  wide: { a: { kind: "image", width: 2000, height: 1000 }, box: screen },
  tall: { a: { kind: "image", width: 1000, height: 4000 }, box: screen },
  "no upscale": { a: { kind: "image", width: 200, height: 100 }, box: screen },
  unknown: { a: { kind: "image" }, box: screen },
  "empty box": { a: { kind: "image", width: 200, height: 100 }, box: { width: 0, height: 700 } },
  // more
  "zero-height box": { a: { kind: "image", width: 200, height: 100 }, box: { width: 390, height: 0 } },
  "negative box": { a: { kind: "image" }, box: { width: -1, height: 700 } },
  "unknown video": { a: { kind: "video" }, box: screen },
  "exact fit": { a: { kind: "image", width: 390, height: 700 }, box: screen },
  "rounding height from unrounded width": { a: { kind: "image", width: 3000, height: 2000 }, box: { width: 100.5, height: 700 } },
  "fractional box": { a: { kind: "image" }, box: { width: 333.3, height: 99.9 } },
});

export const clampPageCases = cases(({ index, count }: { index: number; count: number }) => clampPage(index, count), {
  // attachments.test.ts
  below: { index: -1, count: 3 },
  above: { index: 5, count: 3 },
  inside: { index: 1, count: 3 },
  empty: { index: 2, count: 0 },
  // more
  "rounds half up": { index: 1.5, count: 3 },
  "rounds down": { index: 1.49, count: 3 },
  "negative half": { index: -0.5, count: 3 },
  "negative count": { index: 1, count: -2 },
  "one page": { index: 7, count: 1 },
});

export const pageAtCases = cases(({ offsetX, pageWidth, count }: { offsetX: number; pageWidth: number; count: number }) => pageAt(offsetX, pageWidth, count), {
  // attachments.test.ts
  start: { offsetX: 0, pageWidth: 390, count: 3 },
  "just under halfway": { offsetX: 390 * 1.49, pageWidth: 390, count: 3 },
  "just over halfway": { offsetX: 390 * 1.51, pageWidth: 390, count: 3 },
  "bounce past the end": { offsetX: 390 * 2 + 80, pageWidth: 390, count: 3 },
  "bounce before the start": { offsetX: -60, pageWidth: 390, count: 3 },
  "before layout": { offsetX: 500, pageWidth: 0, count: 3 },
  // more
  "exactly halfway": { offsetX: 195, pageWidth: 390, count: 3 },
  "negative width": { offsetX: 500, pageWidth: -390, count: 3 },
  "no pages": { offsetX: 500, pageWidth: 390, count: 0 },
});

export const shouldDismissCases = cases(({ dy, vy }: { dy: number; vy: number }) => shouldDismiss(dy, vy), {
  // attachments.test.ts
  "long drag": { dy: 130, vy: 0 },
  "short slow": { dy: 60, vy: 0.2 },
  "short flick": { dy: 60, vy: 1.2 },
  jitter: { dy: 20, vy: 3 },
  upward: { dy: -200, vy: -3 },
  // boundaries
  "exactly the distance": { dy: 120, vy: 0 },
  "just under the distance": { dy: 119.9, vy: 0 },
  "exactly the flick": { dy: 40, vy: 0.8 },
  "flick distance short": { dy: 39.9, vy: 0.8 },
  "flick velocity short": { dy: 40, vy: 0.79 },
});

export const pullOfCases = cases(({ offsetY, zoomScale }: { offsetY: number; zoomScale?: number }) => pullOf(offsetY, zoomScale), {
  // attachments.test.ts
  pulled: { offsetY: -80 },
  "scrolled up": { offsetY: 40 },
  zoomed: { offsetY: -80, zoomScale: 2 },
  // boundaries
  "zoom at threshold isn't zoomed": { offsetY: -80, zoomScale: 1.01 },
  "zoom just over threshold": { offsetY: -80, zoomScale: 1.0101 },
  "zoomed out": { offsetY: -80, zoomScale: 0.5 },
  "at rest": { offsetY: 0 },
});

export const dismissOnReleaseCases = cases(
  ({ offsetY, velocityY, zoomScale }: { offsetY: number; velocityY: number; zoomScale?: number }) => dismissOnRelease(offsetY, velocityY, zoomScale),
  {
    // attachments.test.ts
    "long pull": { offsetY: -150, velocityY: 0 },
    "short flick down": { offsetY: -60, velocityY: -1.2 },
    "flicked back up": { offsetY: -60, velocityY: 1.2 },
    "short slow": { offsetY: -60, velocityY: -0.2 },
    zoomed: { offsetY: -300, velocityY: -3, zoomScale: 2 },
    // more
    "scrolled down, fast": { offsetY: 200, velocityY: -3 },
    "exactly the distance": { offsetY: -120, velocityY: 0 },
    "exact flick": { offsetY: -40, velocityY: -0.8 },
  },
);

export const formatSizeCases = cases(formatSize, {
  // attachments.test.ts
  bytes: 512,
  "1.5 KB": 1536,
  "25 MB": 25 * 1024 * 1024,
  "promotes on rounding": 1024 * 1024 - 20,
  // more
  zero: 0,
  negative: -1,
  "1023 B": 1023,
  "1 KB": 1024,
  "under 10 keeps a decimal": 9.94 * 1024,
  "rounds to 10": 9.96 * 1024,
  "whole when the decimal is zero": 3 * 1024 * 1024,
  "1023.4 KB stays KB": 1023.4 * 1024,
  "1023.5 KB promotes": 1023.5 * 1024,
  "half rounds up": 10.5 * 1024,
  "1.05 KB": 1.05 * 1024,
  "1.25 KB": 1.25 * 1024,
  "GB tops out": 5 * 1024 ** 4,
  "fractional bytes": 0.5,
});
