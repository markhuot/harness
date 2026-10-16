import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../../../service/src/orchestrator/errors";
import { MAX_VIEW_BYTES, readFileDiff, readFileView, resolveFile, writeFileContents } from "../../../service/src/orchestrator/file-view";
import { tempDir } from "../../builders/tmp";
import { git, gitRepo } from "../git";

const fails = async (p: Promise<unknown> | (() => unknown), code: number, match: RegExp) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(HarnessError);
    expect((e as HarnessError).status).toBe(code);
    expect((e as Error).message).toMatch(match);
    return;
  }
  throw new Error("expected a HarnessError");
};

test("resolveFile accepts relative and absolute paths inside the root and refuses escapes, folders and .git", () => {
  const root = tempDir();
  mkdirSync(join(root, "src"));
  expect(resolveFile(root, "src/a.ts").rel).toBe("src/a.ts");
  expect(resolveFile(root, join(root, "src", "a.ts")).rel).toBe("src/a.ts");
  for (const bad of ["../x", "/etc/passwd", "src/../../x"]) expect(() => resolveFile(root, bad)).toThrow(/outside/);
  expect(() => resolveFile(root, "")).toThrow(/path is required/);
  expect(() => resolveFile(root, ".")).toThrow(/is a folder|outside/);
  expect(() => resolveFile(root, ".git/config")).toThrow(/\.git/);
  expect(() => resolveFile(root, "a/.GIT/hooks/x")).toThrow(/\.git/);
});

test("reading a file gives its text, size and git state; a folder is a 400 and a missing file a 404", async () => {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "héllo\n");
  mkdirSync(join(root, "dir"));
  const view = await readFileView(root, "a.txt");
  expect(view).toMatchObject({ path: "a.txt", size: 7, contents: "héllo\n", binary: false, truncated: false, tooLarge: false });
  expect(view.git.repo).toBe(false);
  await fails(readFileView(root, "dir"), 400, /is a folder/);
  await fails(readFileView(root, "nope.txt"), 404, /No such file/);
});

test("a binary file and an oversized file come back without contents", async () => {
  const root = tempDir();
  writeFileSync(join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(root, "big.txt"), Buffer.alloc(MAX_VIEW_BYTES + 1, 97));
  expect(await readFileView(root, "bin.dat")).toMatchObject({ binary: true, contents: null });
  expect(await readFileView(root, "big.txt")).toMatchObject({ tooLarge: true, contents: null });
});

test("saving keeps the file's CRLF line endings, its BOM, its missing final newline and its mode", async () => {
  const root = tempDir();
  const path = join(root, "a.txt");
  writeFileSync(path, "﻿one\r\ntwo\r\nthree");
  chmodSync(path, 0o751);
  await writeFileContents(root, "a.txt", "one\nTWO\nthree\n");
  expect(readFileSync(path, "utf8")).toBe("﻿one\r\nTWO\r\nthree");
  expect(statSync(path).mode & 0o777).toBe(0o751);
});

test("saving keeps a final newline the file had, even when the editor's text lost it", async () => {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "x\ny\n");
  await writeFileContents(root, "a.txt", "x\nz");
  expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("x\nz\n");
});

test("saving creates a missing file in an existing folder, and leaves no temp file behind", async () => {
  const root = tempDir();
  expect(await writeFileContents(root, "new.txt", "hi")).toEqual({ path: "new.txt", size: 2 });
  expect(readdirSync(root)).toEqual(["new.txt"]);
  await fails(writeFileContents(root, "missing/dir/new.txt", "hi"), 404, /No such folder/);
});

test("saving refuses a bad path or body, a NUL, too much text, a binary file and .git", async () => {
  const root = tempDir();
  writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "latin.txt"), Buffer.from([0xe9, 0x0a]));
  await fails(writeFileContents(root, 5, "x"), 400, /path is required/);
  await fails(writeFileContents(root, "a.txt", 5), 400, /contents must be a string/);
  await fails(writeFileContents(root, "a.txt", "a\0b"), 400, /NUL/);
  await fails(writeFileContents(root, "a.txt", "x".repeat(MAX_VIEW_BYTES + 1)), 413, /over 2 MiB/);
  await fails(writeFileContents(root, "bin.dat", "x"), 409, /binary or too large/);
  await fails(writeFileContents(root, "latin.txt", "x"), 409, /isn't valid UTF-8/);
  await fails(writeFileContents(root, ".git/config", "x"), 400, /\.git/);
  await fails(writeFileContents(root, "../out.txt", "x"), 400, /outside/);
});

test("saving through a symlink writes the target, but not one that leads outside the root or into .git", async () => {
  const root = tempDir();
  const outside = tempDir();
  writeFileSync(join(root, "real.txt"), "old");
  symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
  await writeFileContents(root, "link.txt", "new");
  expect(readFileSync(join(root, "real.txt"), "utf8")).toBe("new");
  expect(statSync(join(root, "link.txt")).isFile()).toBe(true);
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  await fails(writeFileContents(root, "escape.txt", "x"), 400, /outside/);
  expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("s");
  expect(existsSync(join(root, "escape.txt"))).toBe(true);
});

test("a repository file reports its git state: clean, modified, untracked and ignored", async () => {
  const root = gitRepo({ "tracked.txt": "a\n", ".gitignore": "ignored.txt\n" });
  writeFileSync(join(root, "ignored.txt"), "i");
  writeFileSync(join(root, "new.txt"), "n");
  const state = async (p: string) => (await readFileView(root, p)).git;
  expect(await state("tracked.txt")).toEqual({ repo: true, tracked: true, dirty: false, untracked: false, ignored: false });
  writeFileSync(join(root, "tracked.txt"), "changed\n");
  expect(await state("tracked.txt")).toMatchObject({ tracked: true, dirty: true });
  expect(await state("new.txt")).toMatchObject({ tracked: false, untracked: true, dirty: true });
  expect(await state("ignored.txt")).toMatchObject({ ignored: true, tracked: false, dirty: false });
});

test("the diff of a modified file has the patch and both sides; an untracked file is all additions; a clean file has an empty patch", async () => {
  const root = gitRepo({ "a.txt": "one\ntwo\n" });
  writeFileSync(join(root, "a.txt"), "one\nTWO\n");
  const diff = await readFileDiff(root, "a.txt");
  expect(diff).toMatchObject({ path: "a.txt", oldContents: "one\ntwo\n", newContents: "one\nTWO\n", tooLarge: false });
  expect(diff.patch).toContain("-two");
  expect(diff.patch).toContain("+TWO");
  writeFileSync(join(root, "new.txt"), "fresh\n");
  const added = await readFileDiff(root, "new.txt");
  expect(added.oldContents).toBeNull();
  expect(added.patch).toContain("+fresh");
  git(root, "checkout", "-q", "--", "a.txt");
  expect((await readFileDiff(root, "a.txt")).patch).toBe("");
});

test("a deleted tracked file still has a diff, a file git never knew is a 404, and a folder outside any repo is a 409", async () => {
  const root = gitRepo({ "a.txt": "one\n" });
  Bun.spawnSync(["rm", join(root, "a.txt")]);
  const diff = await readFileDiff(root, "a.txt");
  expect(diff.newContents).toBeNull();
  expect(diff.patch).toContain("-one");
  await fails(readFileDiff(root, "ghost.txt"), 404, /No such file/);
  await fails(readFileDiff(tempDir(), "a.txt"), 409, /isn't in a git repository/);
});
