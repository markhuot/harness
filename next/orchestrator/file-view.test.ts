// The file viewer (service/src/orchestrator/file-view.ts): reading, diffing and saving one file.
// Git answers come from memory git's FileGit (the FileGit contract holds its status codes and
// patches to real git's); the files themselves are real ones on disk.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { tempHome } from "../../service/src/testing/fakes";
import { MAX_VIEW_BYTES, readFileDiff, readFileView, resolveFile, writeFileContents } from "../../service/src/orchestrator/file-view";
import { indexPaths } from "../../service/src/orchestrator/files";
import { createMemoryGit } from "../support/memory-git";

const mem = createMemoryGit();
const git = mem.files;

function tree(files: Record<string, string | Uint8Array>) {
  const root = join(tempHome("harness-file-view-"), "proj");
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

/** A repository holding `files`, all committed; `root` is `dir` inside it when given. `add` is `git add`. */
async function repo(files: Record<string, string | Uint8Array>, dir = "") {
  const top = tree(files);
  mem.initEmptyRepo(top);
  mem.stage(top);
  mem.commitStaged(top);
  return { root: dir ? join(top, dir) : top, top, add: (...paths: string[]) => mem.stage(top, ...paths) };
}

const status = (e: unknown) => (e as { status?: number }).status;
async function rejects(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (e) {
    return status(e);
  }
  throw new Error("expected a rejection");
}

describe("resolveFile", () => {
  test("refuses paths that leave the root, .git internals and the root itself; an absolute path inside the root becomes relative", () => {
    const root = tree({ "src/a.ts": "x" });
    const outside = join(root, "..", "secret.txt");
    writeFileSync(outside, "s");
    symlinkSync(outside, join(root, "link.txt"));
    symlinkSync(join(root, ".."), join(root, "up"));
    for (const p of ["../secret.txt", "src/../../secret.txt", "src\\..\\..\\secret.txt", "link.txt", "up/secret.txt", "a\0b", outside, "/etc/passwd", ".git/config", "sub/.git/HEAD", ".", ""]) {
      expect(() => resolveFile(root, p)).toThrow();
      try {
        resolveFile(root, p);
      } catch (e) {
        expect(status(e)).toBe(400);
      }
    }
    expect(resolveFile(root, "src//a.ts").rel).toBe("src/a.ts");
    expect(resolveFile(root, "./src/a.ts").rel).toBe("src/a.ts");
    // An absolute path inside the root becomes relative.
    expect(resolveFile(root, join(root, "src", "a.ts"))).toEqual({ rel: "src/a.ts", abs: join(root, "src", "a.ts") });
  });
});

describe("readFileView", () => {
  test("reads a gitignored file from disk and reports it ignored", async () => {
    const { root } = await repo({ ".gitignore": ".env\ndist/\n", "a.txt": "a\n" });
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "out.js"), "built\n");
    const env = await readFileView(git, root, ".env");
    expect(env).toMatchObject({ path: ".env", root, size: 9, contents: "SECRET=1\n", binary: false, tooLarge: false, truncated: false });
    expect(env.git).toEqual({ repo: true, tracked: false, dirty: false, untracked: false, ignored: true });
    expect((await readFileView(git, root, "dist/out.js")).git.ignored).toBe(true);
  });

  test("git state: clean, modified, staged, untracked", async () => {
    const { root, add } = await repo({ "clean.txt": "c\n", "mod.txt": "m\n", "staged.txt": "s\n" });
    writeFileSync(join(root, "mod.txt"), "m2\n");
    writeFileSync(join(root, "staged.txt"), "s2\n");
    add("staged.txt");
    mkdirSync(join(root, "fresh"));
    writeFileSync(join(root, "fresh", "new.txt"), "n\n");
    expect((await readFileView(git, root, "clean.txt")).git).toEqual({ repo: true, tracked: true, dirty: false, untracked: false, ignored: false });
    expect((await readFileView(git, root, "mod.txt")).git).toEqual({ repo: true, tracked: true, dirty: true, untracked: false, ignored: false });
    expect((await readFileView(git, root, "staged.txt")).git).toMatchObject({ tracked: true, dirty: true });
    expect((await readFileView(git, root, "fresh/new.txt")).git).toEqual({ repo: true, tracked: false, dirty: true, untracked: true, ignored: false });
  });

  test("outside a repository everything git is false", async () => {
    const root = tree({ "a.txt": "hi" });
    expect((await readFileView(git, root, "a.txt")).git).toEqual({ repo: false, tracked: false, dirty: false, untracked: false, ignored: false });
  });

  test("binary and too-large files come back without contents", async () => {
    const big = "x".repeat(MAX_VIEW_BYTES + 1);
    const root = tree({ "img.bin": new Uint8Array([137, 80, 78, 71, 0, 1, 2]), "big.txt": big, "edge.txt": "y".repeat(MAX_VIEW_BYTES) });
    expect(await readFileView(git, root, "img.bin")).toMatchObject({ size: 7, contents: null, binary: true, tooLarge: false });
    expect(await readFileView(git, root, "big.txt")).toMatchObject({ size: MAX_VIEW_BYTES + 1, contents: null, binary: false, tooLarge: true, truncated: false });
    const edge = await readFileView(git, root, "edge.txt");
    expect([edge.tooLarge, edge.truncated, edge.contents?.length]).toEqual([false, false, MAX_VIEW_BYTES]);
  });

  test("missing is a 404, a folder or an escaping path a 400", async () => {
    const root = tree({ "src/a.ts": "x" });
    expect(await rejects(readFileView(git, root, "nope.txt"))).toBe(404);
    expect(await rejects(readFileView(git, root, "src"))).toBe(400);
    expect(await rejects(readFileView(git, root, "../x"))).toBe(400);
  });
});

describe("readFileDiff", () => {
  test("a modified file diffs against HEAD, staged and unstaged together, and parses", async () => {
    const { root, add } = await repo({ "a.txt": "one\ntwo\nthree\n" });
    writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\n");
    add("a.txt");
    writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
    const d = await readFileDiff(git, root, "a.txt");
    expect(d.oldContents).toBe("one\ntwo\nthree\n");
    expect(d.newContents).toBe("one\nTWO\nthree\nfour\n");
    expect(d.patch).toStartWith("diff --git a/a.txt b/a.txt\n");
    expect(d.patch).toContain("-two\n+TWO\n");
    expect(d.patch).toContain("+four\n");
    const [file] = parsePatchFiles(d.patch)[0]!.files;
    expect([file!.name, file!.type]).toEqual(["a.txt", "change"]);
  });

  test("an untracked file shows as added; a clean or ignored one has an empty patch", async () => {
    const { root } = await repo({ ".gitignore": ".env\n", "clean.txt": "c\n" });
    writeFileSync(join(root, "new [1].ts"), "export {};\n");
    writeFileSync(join(root, ".env"), "S=1\n");
    const added = await readFileDiff(git, root, "new [1].ts");
    expect(added.oldContents).toBeNull();
    expect(added.newContents).toBe("export {};\n");
    expect(added.patch).toContain("new file mode");
    expect(added.patch).toContain("+export {};\n");
    expect(parsePatchFiles(added.patch)[0]!.files[0]).toMatchObject({ name: "new [1].ts", type: "new" });
    expect(await readFileDiff(git, root, "clean.txt")).toEqual({ path: "clean.txt", patch: "", oldContents: "c\n", newContents: "c\n", tooLarge: false });
    expect(await readFileDiff(git, root, ".env")).toMatchObject({ patch: "", oldContents: null, newContents: "S=1\n" });
  });

  test("a deleted file still diffs; one git never knew is a 404", async () => {
    const { root } = await repo({ "gone.txt": "bye\n" });
    rmSync(join(root, "gone.txt"));
    const d = await readFileDiff(git, root, "gone.txt");
    expect(d).toMatchObject({ oldContents: "bye\n", newContents: null });
    expect(d.patch).toContain("deleted file mode");
    expect(await rejects(readFileDiff(git, root, "never.txt"))).toBe(404);
  });

  test("a root inside a repository diffs paths relative to the root", async () => {
    const { root } = await repo({ "pkg/src/a.ts": "a\n", "other.txt": "o\n" }, "pkg");
    writeFileSync(join(root, "src", "a.ts"), "b\n");
    const d = await readFileDiff(git, root, "src/a.ts");
    expect(d.oldContents).toBe("a\n");
    expect(d.patch).toStartWith("diff --git a/src/a.ts b/src/a.ts\n");
  });

  test("a repository without commits diffs against the empty tree", async () => {
    const root = tree({ "a.txt": "a\n" });
    mem.initEmptyRepo(root);
    mem.stage(root, "a.txt");
    const d = await readFileDiff(git, root, "a.txt");
    expect(d.oldContents).toBeNull();
    expect(d.patch).toContain("+a\n");
  });

  test("outside a repository is a 409", async () => {
    const root = tree({ "a.txt": "a" });
    expect(await rejects(readFileDiff(git, root, "a.txt"))).toBe(409);
  });
});

describe("writeFileContents", () => {
  const read = (root: string, rel: string) => readFileSync(join(root, rel));

  test("replaces the contents, last write wins, and reports the bytes written", async () => {
    const root = tree({ "a.txt": "old\n" });
    expect(await writeFileContents(root, "a.txt", "héllo\n")).toEqual({ path: "a.txt", size: 7 });
    expect(read(root, "a.txt").toString()).toBe("héllo\n");
  });

  test("keeps CRLF line endings when the editor's text came back with bare LFs, leaves a CRLF already in the text alone, and never adds CR to an LF file", async () => {
    const root = tree({ "a.txt": "one\r\ntwo\r\n", "crlf.txt": "a\r\nb\r\n", "lf.txt": "a\nb\n" });
    await writeFileContents(root, "a.txt", "one\ntwo\nthree\n");
    await writeFileContents(root, "crlf.txt", "a\r\nb\r\nc\r\n");
    await writeFileContents(root, "lf.txt", "a\nb\nc\n");
    expect(read(root, "a.txt").toString()).toBe("one\r\ntwo\r\nthree\r\n");
    expect(read(root, "crlf.txt").toString()).toBe("a\r\nb\r\nc\r\n");
    expect(read(root, "lf.txt").toString()).toBe("a\nb\nc\n");
  });

  test("keeps the BOM the viewer stripped", async () => {
    const root = tree({ "a.txt": "\uFEFFold\n" });
    await writeFileContents(root, "a.txt", "new\n");
    expect([...read(root, "a.txt").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(read(root, "a.txt").subarray(3).toString()).toBe("new\n");
    const plain = tree({ "b.txt": "old\n" });
    await writeFileContents(plain, "b.txt", "new\n");
    expect(read(plain, "b.txt").toString()).toBe("new\n");
  });

  test("keeps whether the file ended in a newline", async () => {
    const root = tree({ "with.txt": "a\n", "without.txt": "a", "crlf.txt": "a\r\n" });
    await writeFileContents(root, "with.txt", "b");
    await writeFileContents(root, "without.txt", "b\n");
    await writeFileContents(root, "crlf.txt", "b");
    expect(read(root, "with.txt").toString()).toBe("b\n");
    expect(read(root, "without.txt").toString()).toBe("b");
    expect(read(root, "crlf.txt").toString()).toBe("b\r\n");
  });

  test("an empty file or empty text has no newline to keep", async () => {
    const root = tree({ "empty.txt": "", "a.txt": "a\n" });
    await writeFileContents(root, "empty.txt", "x\n");
    await writeFileContents(root, "a.txt", "");
    expect(read(root, "empty.txt").toString()).toBe("x\n");
    expect(read(root, "a.txt").toString()).toBe("");
  });

  test("keeps the file mode and leaves no temp file beside it", async () => {
    const root = tree({ "run.sh": "#!/bin/sh\n", "ro.txt": "x\n" });
    chmodSync(join(root, "run.sh"), 0o755);
    chmodSync(join(root, "ro.txt"), 0o640);
    await writeFileContents(root, "run.sh", "#!/bin/sh\necho\n");
    await writeFileContents(root, "ro.txt", "y\n");
    expect(statSync(join(root, "run.sh")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(root, "ro.txt")).mode & 0o7777).toBe(0o640);
    expect(readdirSync(root).sort()).toEqual(["ro.txt", "run.sh"]);
  });

  test("replaces by rename: the old inode is untouched, so open readers keep a whole file", async () => {
    const root = tree({ "a.txt": "old\n" });
    const before = statSync(join(root, "a.txt")).ino;
    await writeFileContents(root, "a.txt", "new\n");
    expect(statSync(join(root, "a.txt")).ino).not.toBe(before);
  });

  test("creates a missing file in an existing folder; 404 when the folder is missing", async () => {
    const root = tree({ "src/a.ts": "x" });
    await writeFileContents(root, "src/new.ts", "n\n");
    expect(read(root, "src/new.ts").toString()).toBe("n\n");
    expect(await rejects(writeFileContents(root, "nope/new.ts", "n"))).toBe(404);
  });

  test("writes a symlinked file through to its target inside the root", async () => {
    const root = tree({ "real.txt": "old\n" });
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    await writeFileContents(root, "link.txt", "new\n");
    expect(read(root, "real.txt").toString()).toBe("new\n");
    expect(statSync(join(root, "link.txt")).isFile()).toBe(true);
  });

  test("refuses paths that leave the root, .git in any case, a symlink into .git, and folders", async () => {
    const root = tree({ "a.txt": "x", ".git/config": "c", "d/x": "x" });
    const outside = tree({ "secret.txt": "s" });
    symlinkSync(outside, join(root, "escape"));
    symlinkSync(join(outside, "secret.txt"), join(root, "out.txt"));
    symlinkSync(join(root, ".git", "config"), join(root, "cfg"));
    for (const p of ["../x.txt", join(outside, "x.txt"), ".git/config", ".git/new", ".GIT/config", ".Git/hooks/pre-commit", "cfg", "d", "", "a.txt/.."]) {
      expect(await rejects(writeFileContents(root, p, "z"))).toBe(400);
    }
    // A symlinked parent, with a target that doesn't exist yet (safeJoin lets that one through).
    expect(await rejects(writeFileContents(root, "escape/new.txt", "z"))).toBe(400);
    expect(await rejects(writeFileContents(root, "escape/secret.txt", "z"))).toBe(400);
    expect(await rejects(writeFileContents(root, "out.txt", "z"))).toBe(400);
    expect(read(outside, "secret.txt").toString()).toBe("s");
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
    expect(read(root, ".git/config").toString()).toBe("c");
  });

  test("refuses a body that isn't text, has a NUL, or is over the cap (nothing is written)", async () => {
    const root = tree({ "a.txt": "keep" });
    expect(await rejects(writeFileContents(root, "a.txt", 5))).toBe(400);
    expect(await rejects(writeFileContents(root, 5, "x"))).toBe(400);
    expect(await rejects(writeFileContents(root, "a.txt", "a\0b"))).toBe(400);
    expect(await rejects(writeFileContents(root, "a.txt", "x".repeat(MAX_VIEW_BYTES + 1)))).toBe(413);
    expect(read(root, "a.txt").toString()).toBe("keep");
    // Multi-byte text counts in bytes, not characters.
    expect(await rejects(writeFileContents(root, "a.txt", "é".repeat(MAX_VIEW_BYTES / 2 + 1)))).toBe(413);
    await writeFileContents(root, "a.txt", "x".repeat(MAX_VIEW_BYTES));
  });

  test("refuses to overwrite a binary or too-large file", async () => {
    const root = tree({ "bin.dat": new Uint8Array([1, 0, 2]), "big.txt": "x".repeat(MAX_VIEW_BYTES + 1) });
    expect(await rejects(writeFileContents(root, "bin.dat", "text"))).toBe(409);
    expect(await rejects(writeFileContents(root, "big.txt", "text"))).toBe(409);
    expect([...read(root, "bin.dat")]).toEqual([1, 0, 2]);
  });

  test("answers 409 for a file that isn't valid UTF-8 rather than writing U+FFFD", async () => {
    const root = tree({ "latin.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]) });
    expect(await rejects(writeFileContents(root, "latin.txt", "café\n"))).toBe(409);
    expect([...read(root, "latin.txt")]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  });

  test("caps the bytes that land on disk, after CRs and the BOM are added", async () => {
    const line = "a\n";
    const lines = line.repeat(MAX_VIEW_BYTES / 2 - 10); // under the cap as sent, over once CRLF'd
    const root = tree({ "a.txt": "\uFEFFx\r\ny\r\n" });
    expect(await rejects(writeFileContents(root, "a.txt", lines))).toBe(413);
    expect(read(root, "a.txt").toString()).toBe("\uFEFFx\r\ny\r\n");
  });

  test("answers 403 for a read-only file and leaves it alone", async () => {
    const root = tree({ "ro.txt": "keep\n" });
    chmodSync(join(root, "ro.txt"), 0o444);
    if (process.getuid?.() === 0) return; // root ignores the mode
    expect(await rejects(writeFileContents(root, "ro.txt", "new\n"))).toBe(403);
    expect(read(root, "ro.txt").toString()).toBe("keep\n");
  });

  test("a created file shows up in the path index at once", async () => {
    const root = tree({ "a.txt": "x\n" });
    expect((await indexPaths(git, root)).paths).not.toContain("new.txt");
    await writeFileContents(root, "new.txt", "hi\n");
    expect((await indexPaths(git, root)).paths).toContain("new.txt");
  });
});
