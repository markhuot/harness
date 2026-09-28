import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "../testing/fakes";
import { attachMentions, listPaths, MAX_FILE_BYTES, searchPaths } from "./files";
import { git } from "./worktree";

function tree(files: Record<string, string | Uint8Array>) {
  const root = join(tempHome("harness-files-"), "proj");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}

describe("listPaths / searchPaths", () => {
  test("a git repo lists tracked, untracked and gitignored files, plus their folders", async () => {
    const root = tree({
      ".gitignore": "dist/\n.env\nspecs/\nnode_modules/\n",
      "src/app.ts": "x",
      "src/lib/fmt.ts": "x",
      "dist/out.js": "x",
      "dist/assets/app.css": "x",
      ".env": "x",
      "specs/login.md": "x",
      "node_modules/pkg/index.js": "x",
      "notes.md": "x",
      ".DS_Store": "x",
    });
    await git(["init", "-q"], root);
    await git(["add", "src/app.ts"], root);
    const paths = await listPaths(root);
    expect(paths.sort()).toEqual([
      ".env",
      ".gitignore",
      "dist/",
      "dist/assets/",
      "dist/assets/app.css",
      "dist/out.js",
      "node_modules/",
      "notes.md",
      "specs/",
      "specs/login.md",
      "src/",
      "src/app.ts",
      "src/lib/",
      "src/lib/fmt.ts",
    ]);
  });

  test("a plain folder is walked; node_modules is listed but not walked, VCS folders and .DS_Store left out", async () => {
    const root = tree({ "a/b.txt": "x", "node_modules/pkg/index.js": "x", ".git/HEAD": "x", ".svn/entries": "x", "a/.DS_Store": "x", "top.txt": "x" });
    expect((await listPaths(root)).sort()).toEqual(["a/", "a/b.txt", "node_modules/", "top.txt"]);
  });

  test("the listing is reused briefly, then refreshed", async () => {
    const root = tree({ "one.txt": "x" });
    const t = Date.now();
    await listPaths(root, t);
    writeFileSync(join(root, "two.txt"), "x");
    expect(await listPaths(root, t + 1000)).toEqual(["one.txt"]);
    expect((await listPaths(root, t + 60_000)).sort()).toEqual(["one.txt", "two.txt"]);
  });

  test("searchPaths ranks and labels files and folders", async () => {
    const root = tree({ "src/app.ts": "x", "app/main.ts": "x" });
    expect(await searchPaths(root, "app")).toEqual([
      { path: "app/", kind: "dir" },
      { path: "app/main.ts", kind: "file" },
      { path: "src/app.ts", kind: "file" },
    ]);
  });

  test("typing into a folder the index skips lists it from disk", async () => {
    const root = tree({ "node_modules/react/index.js": "x", "node_modules/react/cjs/react.js": "x", "app.ts": "x" });
    expect(await searchPaths(root, "node_modules/react/")).toEqual([
      { path: "node_modules/react/cjs/", kind: "dir" },
      { path: "node_modules/react/index.js", kind: "file" },
    ]);
    expect(await searchPaths(root, "node_modules/react/ind")).toEqual([{ path: "node_modules/react/index.js", kind: "file" }]);
  });

  test("typing a gitignored file's full name finds it", async () => {
    const root = tree({ ".gitignore": ".env\n", ".env": "x", ".envrc": "x" });
    await git(["init", "-q"], root);
    expect(await searchPaths(root, ".env")).toEqual([
      { path: ".env", kind: "file" },
      { path: ".envrc", kind: "file" },
    ]);
  });

  test("browsing never leaves the folder, through .. or a symlink", async () => {
    const root = tree({ "in.txt": "x", "src/a.ts": "x" });
    const outside = join(root, "..", "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "leak.txt"), "x");
    symlinkSync(outside, join(root, "src", "link"));
    expect(await searchPaths(root, "../out")).toEqual([]);
    expect(await searchPaths(root, "src/link/")).toEqual([]);
    expect(await searchPaths(root, "src/link/le")).toEqual([]);
  });

  test("browsing doesn't list VCS internals or junk files", async () => {
    const root = tree({ "node_modules/pkg/index.js": "x", "node_modules/pkg/.DS_Store": "x", "node_modules/pkg/.git/HEAD": "x" });
    await git(["init", "-q"], root);
    expect(await searchPaths(root, ".git/")).toEqual([]);
    expect(await searchPaths(root, ".git/HE")).toEqual([]);
    expect(await searchPaths(root, "node_modules/pkg/.git/")).toEqual([]);
    expect(await searchPaths(root, "node_modules/pkg/")).toEqual([{ path: "node_modules/pkg/index.js", kind: "file" }]);
  });

  test("a missing folder has no files", async () => {
    expect(await searchPaths(join(tempHome("harness-files-"), "gone"), "")).toEqual([]);
  });
});

describe("attachMentions", () => {
  test("appends each mentioned file's contents and leaves other @words alone", async () => {
    const root = tree({ "src/a.ts": "export const a = 1;\n", "My Notes.md": "hello" });
    const a = await attachMentions('Fix @src/a.ts, see @"My Notes.md" and ask @mark', root);
    expect(a.attached).toEqual(["src/a.ts", "My Notes.md"]);
    expect(a.skipped).toEqual([]);
    expect(a.prompt.startsWith('Fix @src/a.ts, see @"My Notes.md" and ask @mark\n\n<mentioned-files>')).toBe(true);
    expect(a.prompt).toContain('<file path="src/a.ts">\nexport const a = 1;\n</file>');
    expect(a.prompt).toContain('<file path="My Notes.md">\nhello\n</file>');
  });

  test("no mentions of existing files leaves the prompt untouched", async () => {
    const root = tree({ "a.txt": "x" });
    expect(await attachMentions("email me@x.com about @nobody", root)).toEqual({ prompt: "email me@x.com about @nobody", attached: [], skipped: [] });
  });

  test("a folder attaches its listing", async () => {
    const root = tree({ "src/a.ts": "x", "src/lib/b.ts": "x" });
    const a = await attachMentions("look in @src/", root);
    expect(a.prompt).toContain('<directory path="src/">\na.ts\nlib/\n</directory>');
  });

  test("paths outside the working directory are refused, including through a symlink", async () => {
    const root = tree({ "in.txt": "x" });
    writeFileSync(join(root, "..", "secret.txt"), "top secret");
    symlinkSync(join(root, "..", "secret.txt"), join(root, "link.txt"));
    const a = await attachMentions("read @../secret.txt and @link.txt", root);
    expect(a.attached).toEqual([]);
    expect(a.skipped).toEqual([
      { path: "../secret.txt", reason: "outside the working directory" },
      { path: "link.txt", reason: "outside the working directory" },
    ]);
    expect(a.prompt).not.toContain("top secret");
  });

  test("binary files are skipped; big files are cut and say so", async () => {
    const big = "x".repeat(MAX_FILE_BYTES + 10);
    const root = tree({ "img.png": new Uint8Array([137, 80, 0, 1]), "big.log": big });
    const a = await attachMentions("@img.png @big.log", root);
    expect(a.skipped).toEqual([{ path: "img.png", reason: "binary file" }]);
    expect(a.attached).toEqual(["big.log"]);
    expect(a.prompt).toContain(`<file path="big.log" truncated="first ${MAX_FILE_BYTES} of ${MAX_FILE_BYTES + 10} bytes">`);
    expect(a.prompt.length).toBeLessThan(MAX_FILE_BYTES + 1000);
  });

  test("the total stays under the attachment limit", async () => {
    const chunk = "y".repeat(MAX_FILE_BYTES);
    const root = tree({ "1.txt": chunk, "2.txt": chunk, "3.txt": chunk, "4.txt": chunk, "5.txt": chunk });
    const a = await attachMentions("@1.txt @2.txt @3.txt @4.txt @5.txt", root);
    expect(a.attached).toEqual(["1.txt", "2.txt", "3.txt", "4.txt"]);
    expect(a.skipped).toEqual([{ path: "5.txt", reason: "over the attachment limit" }]);
  });
});
