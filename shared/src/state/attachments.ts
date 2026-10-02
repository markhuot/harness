// Presentation helpers for ticket attachments (screenshots and recordings an agent shows in the
// spec as attachment:<id> images): stepping through them in a lightbox.

/** The lightbox index after moving `delta` from `index` among `count` attachments, wrapping at both ends. */
export function stepAttachment(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
