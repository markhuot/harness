// The native Changes tab (ios/HarnessKit: Protocol/Changes.swift, Logic/ChangesPatch.swift,
// Logic/ChangesViewed.swift) against the git plugin it replaces: its payload types (plugins/git/git.ts),
// @pierre/diffs' patch parser as the plugin's UI uses it, and the "viewed" marks (plugins/git/ui/viewed.ts).
import { parsePatchFiles } from "@pierre/diffs";
import type { Changes, Commit } from "../../../plugins/git/git";
import { fingerprint, hash, isCollapsed, MAX_FILES, MAX_TICKETS, prune, readViewed, saveViewed, VIEWED_KEY } from "../../../plugins/git/ui/viewed";
import { cases } from "../case";

// --- payloads -----------------------------------------------------------------------------

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@ export function main() {",
  " import { a } from './a';",
  "-console.log(a);",
  "+console.log(a, 'b');",
  " export {};",
  "",
].join("\n");

const changes = (c: Changes) => c;
const commit = (c: Commit) => c;

/** What GET /plugins/git/api/changes returns in each mode. */
export const changesSamples: Changes[] = [
  changes({
    mode: "branch",
    base: "main",
    baseSha: "a".repeat(40),
    head: "b".repeat(40),
    branch: "harness/greet-1",
    files: [
      { path: "notes.txt", status: "untracked", additions: 2, deletions: 0, binary: false },
      { path: "logo.png", status: "added", additions: 0, deletions: 0, binary: true },
      { path: "src/app.ts", status: "modified", additions: 1, deletions: 1, binary: false },
      { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, binary: false },
    ],
    patch: PATCH,
    truncated: false,
    additions: 3,
    deletions: 1,
  }),
  changes({ mode: "workdir", base: "HEAD", baseSha: null, head: null, branch: null, files: [], patch: "", truncated: false, additions: 0, deletions: 0 }),
  changes({
    mode: "pinned",
    base: null,
    baseSha: "c".repeat(40),
    head: "d".repeat(40),
    branch: "harness/gone-2",
    files: [{ path: "src/app.ts", status: "deleted", additions: 0, deletions: 3, binary: false }],
    patch: "",
    truncated: true,
    additions: 0,
    deletions: 3,
    worktree: "e".repeat(40),
  }),
  changes({ mode: "pinned", base: "main", baseSha: "c".repeat(40), head: "d".repeat(40), branch: "x", files: [], patch: "", truncated: false, additions: 0, deletions: 0, worktree: null }),
];

/** GET /log and GET /file. */
export const logSamples = [
  { mode: "branch" as const, base: "main", commits: [commit({ sha: "f".repeat(40), shortSha: "fffffff", subject: "Add greet helper", author: "Harness Test", email: "test@example.com", date: 1767225600000 })] },
  { mode: "workdir" as const, base: null, commits: [] as Commit[] },
];
export const fileSamples = [{ contents: "line\n" }, { contents: null }];

// --- the patch parser and fingerprints ----------------------------------------------------

const git = (path: string, header: string, body = "", from = path) => `diff --git a/${from} b/${path}\n${header}${body}`;
const modified = (path: string, body: string) => git(path, `index 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n`, body);

/** Patches the way `git diff` writes them, one quirk each. */
const patches: Record<string, string> = {
  empty: "",
  modified: modified("src/app.ts", "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"),
  "two hunks with function context": modified(
    "lib/greet.py",
    "@@ -2,4 +2,5 @@ def greet(name):\n     x = 1\n-    return x\n+    y = 2\n+    return x + y\n \n def other():\n@@ -40,3 +41,3 @@ class Greeter:\n     pass\n-    # old\n+    # new\n     done\n",
  ),
  "hunk header without counts": modified("a.txt", "@@ -1 +1 @@\n-old\n+new\n"),
  "new file": git("src/new.ts", "new file mode 100644\nindex 0000000..3333333\n--- /dev/null\n+++ b/src/new.ts\n", "@@ -0,0 +1,2 @@\n+export const x = 1;\n+export const y = 2;\n"),
  "empty new file": git("empty.txt", "new file mode 100644\nindex 0000000..e69de29\n"),
  "deleted file": git("gone.md", "deleted file mode 100644\nindex 4444444..0000000\n--- a/gone.md\n+++ /dev/null\n", "@@ -1,2 +0,0 @@\n-# Gone\n-bye\n"),
  "pure rename": git("src/new.ts", "similarity index 100%\nrename from src/old.ts\nrename to src/new.ts\n", "", "src/old.ts"),
  "rename with changes": git(
    "src/b.ts",
    "similarity index 80%\nrename from src/a.ts\nrename to src/b.ts\nindex 5555555..6666666 100644\n--- a/src/a.ts\n+++ b/src/b.ts\n",
    "@@ -1,2 +1,2 @@\n-const a = 1;\n+const b = 1;\n export {};\n",
    "src/a.ts",
  ),
  binary: git("logo.png", "new file mode 100644\nindex 0000000..7777777\nBinary files /dev/null and b/logo.png differ\n"),
  "mode change": git("run.sh", "old mode 100644\nnew mode 100755\n"),
  "mode change with edits": git("run.sh", "old mode 100644\nnew mode 100755\nindex 8888888..9999999\n--- a/run.sh\n+++ b/run.sh\n", "@@ -1 +1,2 @@\n #!/bin/sh\n+echo hi\n"),
  "no newline at end, both sides": modified("n.txt", "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"),
  "no newline after context": modified("n.txt", "@@ -1,2 +1,3 @@\n+top\n a\n b\n\\ No newline at end of file\n"),
  "empty lines": modified("e.txt", "@@ -1,4 +1,4 @@\n a\n \n-\n+x\n b\n"),
  "added empty line at end of patch": modified("e.txt", "@@ -1 +1,2 @@\n a\n+"),
  "CRLF content": modified("w.txt", "@@ -1,2 +1,2 @@\n keep\r\n-old\r\n+new\r\n"),
  "emoji and accents": modified("i18n/ja.json", "@@ -1,2 +1,2 @@\n {\n-  \"hi\": \"héllo 👋\"\n+  \"hi\": \"こんにちは 😀\"\n"),
  "path with spaces": git("my notes/a b.txt", "index 1111111..2222222 100644\n--- a/my notes/a b.txt\t\n+++ b/my notes/a b.txt\t\n", "@@ -1 +1 @@\n-x\n+y\n"),
  "quoted path": `diff --git "a/caf\\303\\251 \\"x\\"\\t.txt" "b/caf\\303\\251 \\"x\\"\\t.txt"\nindex 1111111..2222222 100644\n--- "a/caf\\303\\251 \\"x\\"\\t.txt"\n+++ "b/caf\\303\\251 \\"x\\"\\t.txt"\n@@ -1 +1 @@\n-a\n+b\n`,
  "miscounted hunk": modified("m.txt", "@@ -1,3 +1,4 @@\n a\n-b\n+c\n+d\n"),
  "deleted lines that look like headers": modified("h.md", "@@ -1,3 +1,1 @@\n---- not a header\n-+++ nor this\n keep\n"),
  preamble: `Some text before the diff\n${modified("p.txt", "@@ -1 +1 @@\n-a\n+b\n")}`,
  "several files": [
    modified("a.ts", "@@ -1 +1 @@\n-a\n+b\n"),
    git("b.ts", "new file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/b.ts\n", "@@ -0,0 +1 @@\n+b\n"),
    git("c.png", "index 1111111..2222222 100644\nBinary files a/c.png and b/c.png differ\n"),
    git("d.ts", "deleted file mode 100755\nindex 1111111..0000000\n--- a/d.ts\n+++ /dev/null\n", "@@ -1 +0,0 @@\n-d\n"),
  ].join(""),
};

/** Each file as the native port must see it: Pierre's fields that fingerprint reads, plus the fingerprint. */
function parsed(patch: string) {
  return parsePatchFiles(patch)
    .flatMap((p) => p.files)
    .map((d) => ({
      name: d.name,
      prevName: d.prevName ?? null,
      type: d.type,
      mode: d.mode ?? null,
      prevMode: d.prevMode ?? null,
      hunks: d.hunks.map((h) => ({ deletionStart: h.deletionStart, deletionCount: h.deletionCount, additionStart: h.additionStart, additionCount: h.additionCount, context: h.hunkContext ?? null })),
      deletionLines: d.deletionLines,
      additionLines: d.additionLines,
      fingerprint: fingerprint(d),
    }));
}

export const parseCases = (() => {
  const error = console.error;
  console.error = () => {}; // Pierre logs the miscounted hunk it repairs
  try {
    return cases(parsed, patches);
  } finally {
    console.error = error;
  }
})();

export const hashCases = cases(hash, {
  empty: "",
  ascii: "hello world",
  "control characters": "a\u0000b\u0001c",
  accents: "héllo",
  "combining mark": "e\u0301",
  emoji: "👋😀",
  long: "x".repeat(1000),
});

// --- viewed marks -------------------------------------------------------------------------

export const pruneCases = cases(
  ({ viewed, current, changed }: { viewed: [string, string][]; current: Record<string, string>; changed: string[] }) => [
    ...prune(new Map(viewed), new Map(Object.entries(current)), new Set(changed)),
  ],
  {
    "same diff keeps its mark": { viewed: [["a.ts", "fp1"]], current: { "a.ts": "fp1" }, changed: ["a.ts"] },
    "changed diff drops it": { viewed: [["a.ts", "fp1"]], current: { "a.ts": "fp2" }, changed: ["a.ts"] },
    "file no longer changed drops it": { viewed: [["a.ts", "fp1"]], current: {}, changed: [] },
    "unparsed (truncated) file keeps it": { viewed: [["z.ts", "fp9"]], current: { "a.ts": "fp1" }, changed: ["a.ts", "z.ts"] },
    "order is kept": {
      viewed: [
        ["c.ts", "3"],
        ["a.ts", "1"],
        ["b.ts", "x"],
        ["d.ts", "4"],
      ],
      current: { "a.ts": "1", "b.ts": "2", "c.ts": "3", "d.ts": "4" },
      changed: ["a.ts", "b.ts", "c.ts", "d.ts"],
    },
  },
);

export const isCollapsedCases = cases(
  ({ viewed, toggle, fp }: { viewed: boolean; toggle: { fp: string; collapsed: boolean } | null; fp: string }) => isCollapsed(viewed, toggle ?? undefined, fp),
  {
    "viewed collapses": { viewed: true, toggle: null, fp: "a" },
    "unviewed stays open": { viewed: false, toggle: null, fp: "a" },
    "toggle on this version wins (open)": { viewed: true, toggle: { fp: "a", collapsed: false }, fp: "a" },
    "toggle on this version wins (closed)": { viewed: false, toggle: { fp: "a", collapsed: true }, fp: "a" },
    "toggle on another version is ignored": { viewed: true, toggle: { fp: "old", collapsed: false }, fp: "a" },
  },
);

type Op = { op: "save"; ticket: string; files: [string, string][]; now: number } | { op: "read"; ticket: string };

/** Run saves and reads against one store; after each step, the tickets kept and that ticket's marks. */
function run(ops: Op[]) {
  const m = new Map<string, string>();
  const store = () => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
  return ops.map((o) => {
    if (o.op === "save") saveViewed(o.ticket, new Map(o.files), store, o.now);
    const raw = m.get(VIEWED_KEY);
    return { tickets: Object.keys(raw ? JSON.parse(raw) : {}).sort(), read: [...readViewed(o.ticket, store)] };
  });
}

const files = (n: number, prefix = "f") => Array.from({ length: n }, (_, i): [string, string] => [`${prefix}${i}.ts`, `fp${i}`]);

export const viewedSequences = [
  {
    name: "save, read, replace, clear",
    ops: [
      { op: "read", ticket: "A-1" },
      { op: "save", ticket: "A-1", files: [["a.ts", "1"], ["b.ts", "2"]], now: 1 },
      { op: "save", ticket: "B-2", files: [["x.ts", "9"]], now: 2 },
      { op: "read", ticket: "A-1" },
      { op: "save", ticket: "A-1", files: [["b.ts", "2"], ["a.ts", "3"]], now: 3 },
      { op: "save", ticket: "B-2", files: [], now: 4 },
      { op: "read", ticket: "B-2" },
    ],
  },
  {
    name: `more than ${MAX_TICKETS} tickets evicts the least recently written`,
    ops: [
      ...Array.from({ length: MAX_TICKETS + 1 }, (_, i): Op => ({ op: "save", ticket: `T-${i}`, files: [["a.ts", `${i}`]], now: 100 + i })),
      { op: "read", ticket: "T-0" },
      { op: "save", ticket: "T-1", files: [["b.ts", "x"]], now: 500 },
      { op: "save", ticket: "N-1", files: [["c.ts", "y"]], now: 501 },
      { op: "read", ticket: "T-1" },
      { op: "read", ticket: "T-2" },
    ],
  },
  {
    name: `more than ${MAX_FILES} files keeps the last ones`,
    ops: [{ op: "save", ticket: "F-1", files: files(MAX_FILES + 3), now: 1 }],
  },
].map((s) => ({ ...s, outputs: run(s.ops as Op[]) }));

export const limits = { key: VIEWED_KEY, maxTickets: MAX_TICKETS, maxFiles: MAX_FILES };
