import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext, ToolResult } from "../../../service/src/tools/types";
import { editFile, listFiles, LIST_MAX_RESULTS, readFile, READ_MAX_LINE_CHARS, resolvePath, writeFile } from "../../../service/src/tools/native";
import { tempDir } from "../../builders/tmp";
import { pngBytes } from "../files";

/** A tool context whose permission check answers from `decide`, recording what it was asked. */
function ctxFor(cwd: string, decide: (tool: string) => { behavior: "allow" } | { behavior: "deny"; message: string } = () => ({ behavior: "allow" })) {
  const checked: { tool: string; input: unknown }[] = [];
  const ctx = { cwd, ops: { checkPermission: async (_c: unknown, tool: string, input: unknown) => (checked.push({ tool, input }), decide(tool)) } } as unknown as ToolContext;
  return { ctx, checked };
}
const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("");

test("relative paths resolve against the run's folder, absolute ones stay as they are", () => {
  expect(resolvePath({ cwd: "/work" }, "src/a.ts")).toBe("/work/src/a.ts");
  expect(resolvePath({ cwd: "/work" }, "/etc/x")).toBe("/etc/x");
  expect(resolvePath({ cwd: "/work" }, "../up")).toBe("/up");
});

test("read_file numbers lines from 1, pages with offset and limit, and says where to continue", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "a.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const { ctx } = ctxFor(cwd);
  expect(text(await readFile.execute({ path: "a.txt", offset: 3, limit: 2 }, ctx))).toBe("     3\tline 3\n     4\tline 4\n\n[showing lines 3-4 of 10; use offset=5 to read more]");
  const all = text(await readFile.execute({ path: "a.txt" }, ctx));
  expect(all.split("\n")).toHaveLength(10);
  expect(all).not.toContain("showing lines");
});

test("read_file explains an empty file, a missing one, a folder, a binary one and an offset past the end", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "empty.txt"), "");
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([65, 0, 66]));
  writeFileSync(join(cwd, "short.txt"), "one\n");
  mkdirSync(join(cwd, "dir"));
  const { ctx } = ctxFor(cwd);
  const read = async (input: { path: string; offset?: number }) => await readFile.execute(input, ctx);
  expect(text(await read({ path: "empty.txt" }))).toContain("is empty");
  expect(await read({ path: "nope.txt" })).toMatchObject({ isError: true });
  expect(text(await read({ path: "dir" }))).toContain("is a directory");
  expect(text(await read({ path: "bin.dat" }))).toContain("looks like a binary file");
  expect(text(await read({ path: "short.txt", offset: 5 }))).toContain("offset 5 is past the end");
});

test("read_file cuts a very long line and returns an image as image data", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "long.txt"), "x".repeat(READ_MAX_LINE_CHARS + 10));
  writeFileSync(join(cwd, "pic.PNG"), pngBytes());
  const { ctx } = ctxFor(cwd);
  expect(text(await readFile.execute({ path: "long.txt" }, ctx))).toContain("… [line truncated]");
  const image = await readFile.execute({ path: "pic.PNG" }, ctx);
  expect(image.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: pngBytes().toString("base64") });
});

test("every file tool asks the permission gate first and hands back its refusal untouched", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "a.txt"), "hi");
  const { ctx, checked } = ctxFor(cwd, () => ({ behavior: "deny", message: "read-only ticket" }));
  for (const [tool, input] of [[readFile, { path: "a.txt" }], [writeFile, { path: "b.txt", content: "x" }], [editFile, { path: "a.txt", old_string: "hi", new_string: "yo" }], [listFiles, {}]] as const) {
    const result = await (tool as { execute(i: unknown, c: ToolContext): Promise<ToolResult> }).execute(input, ctx);
    expect(result).toEqual({ content: [{ type: "text", text: "read-only ticket" }], isError: true });
  }
  expect(checked.map((c) => c.tool)).toEqual(["read_file", "write_file", "edit_file", "list_files"]);
  expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("hi");
});

test("write_file creates parent folders and reports the size, and refuses a folder", async () => {
  const cwd = tempDir();
  const { ctx } = ctxFor(cwd);
  expect(text(await writeFile.execute({ path: "a/b/c.txt", content: "héllo" }, ctx))).toBe(`Wrote 6 bytes to ${join(cwd, "a/b/c.txt")}.`);
  expect(readFileSync(join(cwd, "a/b/c.txt"), "utf8")).toBe("héllo");
  expect(await writeFile.execute({ path: "a", content: "x" }, ctx)).toMatchObject({ isError: true });
});

test("edit_file replaces one exact match, needs it to be unique unless replace_all, and takes $ literally", async () => {
  const cwd = tempDir();
  const path = join(cwd, "a.txt");
  writeFileSync(path, "foo bar foo");
  const { ctx } = ctxFor(cwd);
  const edit = async (input: object) => await editFile.execute({ path: "a.txt", ...input } as never, ctx);
  const ambiguous = await edit({ old_string: "foo", new_string: "x" });
  expect(ambiguous).toMatchObject({ isError: true });
  expect(text(ambiguous)).toContain("occurs 2 times");
  expect(readFileSync(path, "utf8")).toBe("foo bar foo");
  expect(text(await edit({ old_string: "foo", new_string: "$&", replace_all: true }))).toContain("Replaced 2 occurrences");
  expect(readFileSync(path, "utf8")).toBe("$& bar $&");
  expect(text(await edit({ old_string: "bar", new_string: "baz" }))).toContain("Edited");
});

test("edit_file refuses an empty or identical old_string, a missing match and a missing file", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "a.txt"), "abc");
  const { ctx } = ctxFor(cwd);
  const msg = async (input: object) => text(await editFile.execute({ path: "a.txt", ...input } as never, ctx));
  expect(await msg({ old_string: "", new_string: "x" })).toContain("must not be empty");
  expect(await msg({ old_string: "a", new_string: "a" })).toContain("identical");
  expect(await msg({ old_string: "zzz", new_string: "x" })).toContain("was not found");
  expect(text(await editFile.execute({ path: "nope.txt", old_string: "a", new_string: "b" }, ctx))).toContain("File not found");
});

test("list_files lists a folder's entries, marks folders, skips node_modules and .git, and sorts", async () => {
  const cwd = tempDir();
  for (const f of ["b.txt", "a.txt", "src/x.ts", "node_modules/p/i.js", ".git/config"]) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), "");
  }
  const { ctx } = ctxFor(cwd);
  expect(text(await listFiles.execute({}, ctx))).toBe(".:\na.txt\nb.txt\nsrc/");
});

test("list_files with a glob walks down, skips ignored folders, and says when nothing matches", async () => {
  const cwd = tempDir();
  for (const f of ["a.ts", "src/b.ts", "src/deep/c.ts", "src/d.js", "node_modules/p/e.ts"]) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), "");
  }
  const { ctx } = ctxFor(cwd);
  expect(text(await listFiles.execute({ pattern: "**/*.ts" }, ctx))).toBe(".:\na.ts\nsrc/b.ts\nsrc/deep/c.ts");
  expect(text(await listFiles.execute({ path: "src", pattern: "*.ts" }, ctx))).toBe("src:\nb.ts");
  expect(text(await listFiles.execute({ pattern: "*.rb" }, ctx))).toContain("No files match *.rb");
  expect(text(await listFiles.execute({ path: "nope" }, ctx))).toContain("Directory not found");
  expect(text(await listFiles.execute({ path: "a.ts" }, ctx))).toContain("is not a directory");
});

test("a listing is capped and says how many were left out", async () => {
  const cwd = tempDir();
  for (let i = 0; i < LIST_MAX_RESULTS + 5; i++) writeFileSync(join(cwd, `f${String(i).padStart(5, "0")}.txt`), "");
  const out = text(await listFiles.execute({}, ctxFor(cwd).ctx));
  expect(out).toContain("[5+ more not shown; narrow the pattern]");
  expect(out.split("\n").filter((l) => l.endsWith(".txt"))).toHaveLength(LIST_MAX_RESULTS);
});
