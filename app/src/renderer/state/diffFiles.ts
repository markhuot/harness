// Parsing a diff block's text into files.

import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { normalizePatch } from "@harness/shared/state";

/** The files in a diff block, or [] when it doesn't parse. */
export function diffFiles(text: string): FileDiffMetadata[] {
  const quiet = console.error;
  try {
    console.error = () => {}; // the parser logs the patches it rejects; we fall back instead
    return parsePatchFiles(normalizePatch(text)).flatMap((p) => p.files);
  } catch {
    return [];
  } finally {
    console.error = quiet;
  }
}
