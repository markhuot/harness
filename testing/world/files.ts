import type { FileDiff, FileView } from "@harness/shared";

const git = { repo: true, tracked: true, dirty: false, untracked: false, ignored: false };

function view(path: string, contents: string, over: Partial<FileView> = {}): FileView {
  return { path, root: "/Users/dev/harness", size: contents.length, contents, binary: false, truncated: false, tooLarge: false, git, ...over };
}

const BOARD_OLD = `export function columns(tickets: Ticket[]) {\n  return STATUSES.map((s) => tickets.filter((t) => t.status === s));\n}\n`;
const BOARD_NEW = `export function columns(tickets: Ticket[]) {\n  const byStatus = Map.groupBy(tickets, (t) => t.status);\n  return STATUSES.map((s) => byStatus.get(s) ?? []);\n}\n`;

/** The files of HARNESS-5's worktree: a clean source file, a dirty one with a diff, a readme, an image and a file that's too big to open. */
export const files = {
  ticket: "HARNESS-5",
  views: [
    view("src/board.ts", BOARD_NEW, { git: { ...git, dirty: true } }),
    view("src/util.ts", "export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n"),
    view("README.md", "# Harness\n\nA board for agents.\n"),
    view("assets/logo.png", "", { size: 2048, contents: null, binary: true }),
    view("dist/bundle.js", "", { size: 90_000_000, contents: null, tooLarge: true, git: { ...git, tracked: false, ignored: true } }),
  ],
  diffs: [{ path: "src/board.ts", patch: `--- a/src/board.ts\n+++ b/src/board.ts\n@@ -1,3 +1,4 @@\n export function columns(tickets: Ticket[]) {\n-  return STATUSES.map((s) => tickets.filter((t) => t.status === s));\n+  const byStatus = Map.groupBy(tickets, (t) => t.status);\n+  return STATUSES.map((s) => byStatus.get(s) ?? []);\n }\n`, oldContents: BOARD_OLD, newContents: BOARD_NEW, tooLarge: false } satisfies FileDiff],
};
