import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";
import { tempHome } from "../testing/fakes";
import { MAX_VIEW_BYTES, readFileDiff, readFileView, resolveFile } from "./file-view";
import { git } from "./worktree";

function tree(files: Record<string, string | Uint8Array>) {
  const root = join(tempHome("harness-file-view-"), "proj");
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

async function repo(files: Record<string, string | Uint8Array>, dir = "") {
  const top = tree(files);
  const run = async (...args: string[]) => {
    const r = await git(args, top);
    if (r.code !== 0) throw new Error(r.stderr);
  };
  await run("init", "-q");
  await run("add", ".");
  await run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return { root: dir ? join(top, dir) : top, top, run };
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
  test("refuses paths that leave the root, .git internals and the root itself", () => {
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
  });

  test("an absolute path inside the root becomes relative", () => {
    const root = tree({ "src/a.ts": "x" });
    expect(resolveFile(root, join(root, "src", "a.ts"))).toEqual({ rel: "src/a.ts", abs: join(root, "src", "a.ts") });
  });
});

describe("readFileView", () => {
  test("reads a gitignored file from disk and reports it ignored", async () => {
    const { root } = await repo({ ".gitignore": ".env\ndist/\n", "a.txt": "a\n" });
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "out.js"), "built\n");
    const env = await readFileView(root, ".env");
    expect(env).toMatchObject({ path: ".env", root, size: 9, contents: "SECRET=1\n", binary: false, tooLarge: false, truncated: false });
    expect(env.git).toEqual({ repo: true, tracked: false, dirty: false, untracked: false, ignored: true });
    expect((await readFileView(root, "dist/out.js")).git.ignored).toBe(true);
  });

  test("git state: clean, modified, staged, untracked", async () => {
    const { root, run } = await repo({ "clean.txt": "c\n", "mod.txt": "m\n", "staged.txt": "s\n" });
    writeFileSync(join(root, "mod.txt"), "m2\n");
    writeFileSync(join(root, "staged.txt"), "s2\n");
    await run("add", "staged.txt");
    mkdirSync(join(root, "fresh"));
    writeFileSync(join(root, "fresh", "new.txt"), "n\n");
    expect((await readFileView(root, "clean.txt")).git).toEqual({ repo: true, tracked: true, dirty: false, untracked: false, ignored: false });
    expect((await readFileView(root, "mod.txt")).git).toEqual({ repo: true, tracked: true, dirty: true, untracked: false, ignored: false });
    expect((await readFileView(root, "staged.txt")).git).toMatchObject({ tracked: true, dirty: true });
    expect((await readFileView(root, "fresh/new.txt")).git).toEqual({ repo: true, tracked: false, dirty: true, untracked: true, ignored: false });
  });

  test("outside a repository everything git is false", async () => {
    const root = tree({ "a.txt": "hi" });
    expect((await readFileView(root, "a.txt")).git).toEqual({ repo: false, tracked: false, dirty: false, untracked: false, ignored: false });
  });

  test("binary and too-large files come back without contents", async () => {
    const big = "x".repeat(MAX_VIEW_BYTES + 1);
    const root = tree({ "img.bin": new Uint8Array([137, 80, 78, 71, 0, 1, 2]), "big.txt": big, "edge.txt": "y".repeat(MAX_VIEW_BYTES) });
    expect(await readFileView(root, "img.bin")).toMatchObject({ size: 7, contents: null, binary: true, tooLarge: false });
    expect(await readFileView(root, "big.txt")).toMatchObject({ size: MAX_VIEW_BYTES + 1, contents: null, binary: false, tooLarge: true, truncated: false });
    const edge = await readFileView(root, "edge.txt");
    expect([edge.tooLarge, edge.truncated, edge.contents?.length]).toEqual([false, false, MAX_VIEW_BYTES]);
  });

  test("missing is a 404, a folder or an escaping path a 400", async () => {
    const root = tree({ "src/a.ts": "x" });
    expect(await rejects(readFileView(root, "nope.txt"))).toBe(404);
    expect(await rejects(readFileView(root, "src"))).toBe(400);
    expect(await rejects(readFileView(root, "../x"))).toBe(400);
  });
});

describe("readFileDiff", () => {
  test("a modified file diffs against HEAD, staged and unstaged together, and parses", async () => {
    const { root, run } = await repo({ "a.txt": "one\ntwo\nthree\n" });
    writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\n");
    await run("add", "a.txt");
    writeFileSync(join(root, "a.txt"), "one\nTWO\nthree\nfour\n");
    const d = await readFileDiff(root, "a.txt");
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
    const added = await readFileDiff(root, "new [1].ts");
    expect(added.oldContents).toBeNull();
    expect(added.newContents).toBe("export {};\n");
    expect(added.patch).toContain("new file mode");
    expect(added.patch).toContain("+export {};\n");
    expect(parsePatchFiles(added.patch)[0]!.files[0]).toMatchObject({ name: "new [1].ts", type: "new" });
    expect(await readFileDiff(root, "clean.txt")).toEqual({ path: "clean.txt", patch: "", oldContents: "c\n", newContents: "c\n", tooLarge: false });
    expect(await readFileDiff(root, ".env")).toMatchObject({ patch: "", oldContents: null, newContents: "S=1\n" });
  });

  test("a deleted file still diffs; one git never knew is a 404", async () => {
    const { root } = await repo({ "gone.txt": "bye\n" });
    rmSync(join(root, "gone.txt"));
    const d = await readFileDiff(root, "gone.txt");
    expect(d).toMatchObject({ oldContents: "bye\n", newContents: null });
    expect(d.patch).toContain("deleted file mode");
    expect(await rejects(readFileDiff(root, "never.txt"))).toBe(404);
  });

  test("a root inside a repository diffs paths relative to the root", async () => {
    const { root } = await repo({ "pkg/src/a.ts": "a\n", "other.txt": "o\n" }, "pkg");
    writeFileSync(join(root, "src", "a.ts"), "b\n");
    const d = await readFileDiff(root, "src/a.ts");
    expect(d.oldContents).toBe("a\n");
    expect(d.patch).toStartWith("diff --git a/src/a.ts b/src/a.ts\n");
  });

  test("a repository without commits diffs against the empty tree", async () => {
    const root = tree({ "a.txt": "a\n" });
    await git(["init", "-q"], root);
    await git(["add", "a.txt"], root);
    const d = await readFileDiff(root, "a.txt");
    expect(d.oldContents).toBeNull();
    expect(d.patch).toContain("+a\n");
  });

  test("outside a repository is a 409", async () => {
    const root = tree({ "a.txt": "a" });
    expect(await rejects(readFileDiff(root, "a.txt"))).toBe(409);
  });
});
