import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachMentions, indexPaths, invalidatePaths, listPaths, MAX_ATTACH_BYTES, MAX_FILE_BYTES, searchPaths } from "../../../service/src/orchestrator/files";
import { tempDir } from "../../builders/tmp";
import { gitRepo } from "../git";
import { writeFile } from "../files";

function tree(files: Record<string, string>) {
  const root = tempDir();
  for (const [name, text] of Object.entries(files)) writeFile(root, name, text);
  return root;
}

test("a plain folder lists its files and the folders that hold them, without .git, junk or a walk into node_modules", async () => {
  const root = tree({ "a.txt": "", "src/b.ts": "", "src/deep/c.ts": "", ".DS_Store": "", "node_modules/pkg/index.js": "" });
  mkdirSync(join(root, ".git"));
  const paths = await listPaths(root, 1);
  expect(paths.sort()).toEqual(["a.txt", "node_modules/", "src/", "src/b.ts", "src/deep/", "src/deep/c.ts"]);
});

test("a repository lists tracked and untracked files plus ignored ones, and marks what git ignores", async () => {
  const root = gitRepo({ "tracked.txt": "t", ".gitignore": "dist/\n*.log\n" });
  writeFile(root, "new.txt", "n");
  writeFile(root, "dist/out.js", "o");
  writeFile(root, "debug.log", "l");
  const index = await indexPaths(root, { now: 1 });
  expect(index.paths).toEqual(expect.arrayContaining(["tracked.txt", "new.txt", "dist/", "dist/out.js", "debug.log"]));
  expect(index.paths.some((p) => p.startsWith(".git/"))).toBe(false);
  expect([...index.ignored].sort()).toEqual(["debug.log", "dist/", "dist/out.js"]);
});

test("a listing is reused for five seconds of the clock it's given, then read again; invalidating forgets it at once", async () => {
  const root = tree({ "a.txt": "" });
  expect(await listPaths(root, 1000)).toEqual(["a.txt"]);
  writeFile(root, "b.txt", "");
  expect(await listPaths(root, 5999)).toEqual(["a.txt"]);
  expect((await listPaths(root, 6000)).sort()).toEqual(["a.txt", "b.txt"]);
  writeFile(root, "c.txt", "");
  invalidatePaths(root);
  expect(await listPaths(root, 6001)).toContain("c.txt");
});

test("the deep index also walks node_modules and marks it ignored", async () => {
  const root = tree({ "a.txt": "", "node_modules/pkg/index.js": "" });
  const deep = await indexPaths(root, { now: 1, deep: true });
  expect(deep.paths).toContain("node_modules/pkg/index.js");
  expect(deep.ignored.has("node_modules/pkg/index.js")).toBe(true);
});

test("search ranks a file name match above a path match, marks kinds, and lists a folder typed into", async () => {
  const root = tree({ "src/login.ts": "", "docs/about-login.md": "", "src/other.ts": "", "node_modules/react/index.js": "" });
  const hits = await searchPaths(root, "login");
  expect(hits[0]).toEqual({ path: "src/login.ts", kind: "file" });
  expect(hits.map((h) => h.path)).toContain("docs/about-login.md");
  expect(hits.map((h) => h.path)).not.toContain("src/other.ts");
  expect((await searchPaths(root, "src/", 50, { kind: "dir" })).every((h) => h.kind === "dir")).toBe(true);
  expect((await searchPaths(root, "node_modules/react/")).map((h) => h.path)).toContain("node_modules/react/index.js");
});

test("the file browser's search marks ignored paths and ranks them after equal matches", async () => {
  const root = tree({ "src/util.ts": "", "node_modules/util/index.js": "" });
  const hits = await searchPaths(root, "util", 50, { ignored: true });
  const ignoredHit = hits.find((h) => h.path.startsWith("node_modules/util"));
  expect(ignoredHit).toMatchObject({ ignored: true });
  expect(hits.findIndex((h) => h.path === "src/util.ts")).toBeLessThan(hits.indexOf(ignoredHit!));
  expect(hits.find((h) => h.path === "src/util.ts")!.ignored).toBeUndefined();
});

test("mentioned files are appended to the prompt as one block each; unmatched mentions are left alone", async () => {
  const cwd = tree({ "src/a.ts": "const a = 1;\n", "notes.txt": "no trailing newline" });
  const out = await attachMentions("look at @src/a.ts and @notes.txt, thanks @someone", cwd);
  expect(out.attached).toEqual(["src/a.ts", "notes.txt"]);
  expect(out.skipped).toEqual([]);
  expect(out.prompt.startsWith("look at @src/a.ts and @notes.txt, thanks @someone\n\n<mentioned-files>")).toBe(true);
  expect(out.prompt).toContain('<file path="src/a.ts">\nconst a = 1;\n</file>');
  expect(out.prompt).toContain('<file path="notes.txt">\nno trailing newline\n</file>');
  expect((await attachMentions("nothing to attach @nobody", cwd)).prompt).toBe("nothing to attach @nobody");
});

test("a mentioned folder is listed, sorted, with folders marked", async () => {
  const cwd = tree({ "src/b.ts": "", "src/a.ts": "", "src/sub/c.ts": "", "src/.DS_Store": "" });
  const out = await attachMentions("see @src/", cwd);
  expect(out.prompt).toContain('<directory path="src/">\na.ts\nb.ts\nsub/\n</directory>');
});

test("files outside the working directory, binary files and symlinks out are skipped with the reason", async () => {
  const outside = tree({ "secret.txt": "s" });
  const cwd = tree({ "bin.dat": "" });
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
  symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
  const out = await attachMentions(`@link.txt @../${outside.split("/").pop()}/secret.txt @bin.dat`, cwd);
  expect(out.attached).toEqual([]);
  expect(out.skipped.map((s) => s.reason)).toEqual(["outside the working directory", "outside the working directory", "binary file"]);
  expect(out.prompt).not.toContain("<file");
});

test("a big file is cut at the per-file limit with a note, and the attachment as a whole has a budget", async () => {
  const cwd = tree({ "big.txt": "x".repeat(MAX_FILE_BYTES + 100) });
  const out = await attachMentions("@big.txt", cwd);
  expect(out.prompt).toContain(`truncated="first ${MAX_FILE_BYTES} of ${MAX_FILE_BYTES + 100} bytes"`);
  const files: Record<string, string> = {};
  for (let i = 0; i < 6; i++) files[`f${i}.txt`] = "y".repeat(MAX_FILE_BYTES);
  const many = await attachMentions(Object.keys(files).map((f) => `@${f}`).join(" "), tree(files));
  expect(many.attached.length).toBeGreaterThan(0);
  expect(many.attached.length).toBeLessThan(6);
  expect(many.skipped.every((s) => s.reason === "over the attachment limit")).toBe(true);
  expect(MAX_ATTACH_BYTES).toBeGreaterThan(MAX_FILE_BYTES);
});
