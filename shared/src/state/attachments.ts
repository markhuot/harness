// Presentation helpers for ticket attachments (screenshots and recordings an agent shows in the
// spec as attachment:<id> images): stepping through them in a lightbox.

import type { Attachment, ToolResultContent } from "../protocol";

/** The lightbox index after moving `delta` from `index` among `count` attachments, wrapping at both ends. */
export function stepAttachment(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** One image (or video) a tool returned, ready for the lightbox, and where it sits in the result. */
export interface ToolOutputMedia {
  /** Its block's index in the tool result's output */
  at: number;
  /** A stand-in for the lightbox: the service never stored these bytes, so the id is only local */
  attachment: Attachment;
  /** A data: URL of the block's own bytes */
  url: string;
}

/**
 * The media in a tool result (screenshots, mostly), in order, so a click on one opens the lightbox
 * over all of them. Each is named for the tool, numbered when there's more than one.
 */
export function toolOutputMedia(callId: string, tool: string, output: ToolResultContent[]): ToolOutputMedia[] {
  const blocks = output.flatMap((o, at) => (o.type === "image" ? [{ o, at }] : []));
  return blocks.map(({ o, at }, n) => ({
    at,
    url: `data:${o.mimeType};base64,${o.data}`,
    attachment: {
      id: `${callId}:${at}`,
      path: "",
      name: blocks.length > 1 ? `${tool} output ${n + 1}` : `${tool} output`,
      source: "upload",
      kind: o.mimeType.startsWith("video/") ? "video" : "image",
      mimeType: o.mimeType,
    },
  }));
}
