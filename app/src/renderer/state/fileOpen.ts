// Turning a file link (shared/src/fileLinks.ts) into a file pane's content. A link can name its
// own context (`?ticket=KEY`, `?project=<id>`); otherwise it's resolved where it was clicked: the
// ticket whose transcript or spec shows it, else the project (the Inbox's triage sessions, the
// palette on a project board).

import type { FileLink } from "@harness/shared";
import type { FileContent, FileRoot } from "./panes";

/** Where a link was clicked, for links that don't name their own ticket or project. */
export interface FileLinkContext {
  ticketKey?: string | null;
  projectId?: string | null;
}

/** The root a link resolves in: the link's own ticket or project first, then the context's. Null when nothing names one. */
export function fileRootFor(link: Pick<FileLink, "ticketKey" | "projectId">, ctx: FileLinkContext = {}): FileRoot | null {
  if (link.ticketKey) return { ticketKey: link.ticketKey };
  if (link.projectId) return { projectId: link.projectId };
  if (ctx.ticketKey) return { ticketKey: ctx.ticketKey };
  if (ctx.projectId) return { projectId: ctx.projectId };
  return null;
}

/** The file pane a link opens, or null when there's no ticket or project to resolve it in. */
export function fileContentFor(link: FileLink, ctx: FileLinkContext = {}): FileContent | null {
  const root = fileRootFor(link, ctx);
  if (!root) return null;
  const c: FileContent = { kind: "file", root, path: link.path };
  if (link.startLine) {
    c.startLine = link.startLine;
    if (link.endLine && link.endLine > link.startLine) c.endLine = link.endLine;
  }
  return c;
}
