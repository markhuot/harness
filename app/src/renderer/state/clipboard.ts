// Copying markdown to the clipboard as two flavours at once: text/html rendered from it (a paste into
// Mail, Docs or Notes keeps its headings, lists and tables) and the markdown itself as text/plain
// (what "Paste and Match Style", a terminal or a code editor takes).

import { markdownToHtml } from "@harness/shared/state";

export async function copyMarkdown(md: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (typeof ClipboardItem === "undefined" || !clipboard?.write) return clipboard.writeText(md);
  await clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([markdownToHtml(md)], { type: "text/html" }),
      "text/plain": new Blob([md], { type: "text/plain" }),
    }),
  ]);
}
