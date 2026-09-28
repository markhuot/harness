// Presentation helpers for summary attachments (screenshots and recordings an agent posts with a
// summary): thumbnail sizing, stepping through them in a lightbox, and a short count label.

import type { SummaryAttachment } from "../protocol";

/** The widest and tallest a thumbnail may be relative to its height, so a panorama or a phone-tall screenshot stays a thumbnail. */
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 2.5;
/** Unknown dimensions (a video, or an image whose header wasn't parsed) get a 4:3 box. */
const DEFAULT_ASPECT = 4 / 3;

/**
 * The box a thumbnail takes at `height` pixels tall: its own aspect ratio when the service knew the
 * dimensions (so nothing shifts when it loads), clamped to 1:2..5:2; 4:3 otherwise.
 */
export function thumbnailBox(a: Pick<SummaryAttachment, "width" | "height">, height: number): { width: number; height: number } {
  const known = a.width && a.height && a.width > 0 && a.height > 0;
  const aspect = known ? Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a.width! / a.height!)) : DEFAULT_ASPECT;
  return { width: Math.round(height * aspect), height };
}

/** The lightbox index after moving `delta` from `index` among `count` attachments, wrapping at both ends. */
export function stepAttachment(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** "2 images", "1 video", "1 image, 2 videos", or "" when there are none. */
export function attachmentsLabel(list: Pick<SummaryAttachment, "kind">[]): string {
  const images = list.filter((a) => a.kind === "image").length;
  const videos = list.length - images;
  const part = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? "" : "s"}` : "");
  return [part(images, "image"), part(videos, "video")].filter(Boolean).join(", ");
}
