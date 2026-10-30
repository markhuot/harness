import type { FileDiff, FileView } from "@harness/shared";
import type { Changes, ChangesLog } from "@harness/shared/state";
import { minutesAgo } from "./time";

const git = { repo: true, tracked: true, dirty: false, untracked: false, ignored: false };

function view(path: string, contents: string, over: Partial<FileView> = {}): FileView {
  return { path, root: "/Users/dev/harness", size: contents.length, contents, binary: false, truncated: false, tooLarge: false, image: null, git, ...over };
}

const BOARD_OLD = `export function columns(tickets: Ticket[]) {\n  return STATUSES.map((s) => tickets.filter((t) => t.status === s));\n}\n`;
const BOARD_NEW = `export function columns(tickets: Ticket[]) {\n  const byStatus = Map.groupBy(tickets, (t) => t.status);\n  return STATUSES.map((s) => byStatus.get(s) ?? []);\n}\n`;

/** The files of HARNESS-5's worktree: a clean source file, a dirty one with a diff, a readme, an image, a binary file and a file that's too big to open. */
export const files = {
  ticket: "HARNESS-5",
  views: [
    view("src/board.ts", BOARD_NEW, { git: { ...git, dirty: true } }),
    view("src/util.ts", "export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n"),
    view("README.md", "# Harness\n\nA board for agents.\n"),
    view("assets/logo.png", "", { size: 2048, contents: null, binary: true, image: "image/png" }),
    view("assets/font.woff2", "", { size: 4096, contents: null, binary: true }),
    view("dist/bundle.js", "", { size: 90_000_000, contents: null, tooLarge: true, git: { ...git, tracked: false, ignored: true } }),
  ],
  diffs: [{ path: "src/board.ts", patch: `--- a/src/board.ts\n+++ b/src/board.ts\n@@ -1,3 +1,4 @@\n export function columns(tickets: Ticket[]) {\n-  return STATUSES.map((s) => tickets.filter((t) => t.status === s));\n+  const byStatus = Map.groupBy(tickets, (t) => t.status);\n+  return STATUSES.map((s) => byStatus.get(s) ?? []);\n }\n`, oldContents: BOARD_OLD, newContents: BOARD_NEW, tooLarge: false } satisfies FileDiff],
};

const UTIL_PATCH = `diff --git a/src/util.ts b/src/util.ts
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/src/util.ts
@@ -0,0 +1 @@
+export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
`;

const BOARD_PATCH = `diff --git a/src/board.ts b/src/board.ts
index 1f2e3d4..5a6b7c8 100644
--- a/src/board.ts
+++ b/src/board.ts
@@ -1,3 +1,4 @@
 export function columns(tickets: Ticket[]) {
-  return STATUSES.map((s) => tickets.filter((t) => t.status === s));
+  const byStatus = Map.groupBy(tickets, (t) => t.status);
+  return STATUSES.map((s) => byStatus.get(s) ?? []);
 }
`;

/** What the git plugin answers for a ticket's Changes tab (GET /plugins/git/api/changes and /log), by ticket key. */
export const changes: Record<string, { changes: Changes; log: ChangesLog }> = {
  "HARNESS-5": {
    changes: {
      mode: "branch",
      base: "main",
      baseSha: "9f8e7d6c5b4a",
      head: "a1b2c3d4e5f6",
      branch: "harness/harness-5",
      files: [
        { path: "src/board.ts", status: "modified", additions: 2, deletions: 1, binary: false },
        { path: "src/util.ts", status: "added", additions: 1, deletions: 0, binary: false },
      ],
      patch: BOARD_PATCH + UTIL_PATCH,
      truncated: false,
      additions: 3,
      deletions: 1,
    },
    log: {
      mode: "branch",
      base: "main",
      commits: [{ sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", shortSha: "a1b2c3d", subject: "Cache the first page of tickets", author: "Harness Agent", email: "agent@example.com", date: minutesAgo(45) }],
    },
  },
};
