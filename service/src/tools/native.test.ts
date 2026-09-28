import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fakeContext } from "./fakes";
import { bash, BASH_MAX_OUTPUT_CHARS, editFile, listFiles, readFile, resolvePath, writeFile } from "./native";
import type { ToolResult } from "./types";
import { tempDir } from "@harness/shared/testing";

const root = tempDir("harness-native-");
let dir: string;
let n = 0;
beforeEach(() => {
  dir = join(root, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
});

const ctx = (extra: Parameters<typeof fakeContext>[0] = {}) => fakeContext({ cwd: dir, ...extra });
const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

describe("resolvePath", () => {
  test("relative paths resolve against cwd, absolute paths are kept", () => {
    expect(resolvePath({ cwd: "/a/b" }, "c/d.txt")).toBe("/a/b/c/d.txt");
    expect(resolvePath({ cwd: "/a/b" }, "../x")).toBe("/a/x");
    expect(resolvePath({ cwd: "/a/b" }, "/etc/hosts")).toBe("/etc/hosts");
    expect(resolvePath({ cwd: "/a/b" }, "~/f")).not.toContain("~");
  });
});

describe("bash", () => {
  test("runs in ctx.cwd and reports exit code 0", async () => {
    const r = await bash.execute({ command: "pwd; echo out; echo err >&2" }, ctx());
    expect(r.isError).toBeUndefined();
    const t = text(r);
    expect(t).toContain(dir.replace(/^\/private/, "").split("/").pop()!);
    expect(t).toContain("out");
    expect(t).toContain("err");
    expect(t).toEndWith("Exit code: 0");
  });

  test("non-zero exit is an error result that carries the code", async () => {
    const r = await bash.execute({ command: "echo nope; exit 3" }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("nope");
    expect(text(r)).toEndWith("Exit code: 3");
  });

  test("timeout kills the command (and its children) quickly", async () => {
    const started = Date.now();
    const r = await bash.execute({ command: "echo before; sleep 5; echo AFTERMARK", timeout_ms: 200 }, ctx());
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("before");
    expect(text(r)).not.toContain("AFTERMARK");
    expect(text(r)).toContain("timed out after 200ms");
  });

  test("aborting the run signal kills the command", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = bash.execute({ command: "sleep 5" }, ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(Date.now() - started).toBeLessThan(2500);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("cancelled");
  });

  test("an already-aborted signal doesn't start the command", async () => {
    const ac = new AbortController();
    ac.abort();
    const marker = join(dir, "ran");
    const r = await bash.execute({ command: `touch ${marker}` }, ctx({ signal: ac.signal }));
    expect(r.isError).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("backgrounded grandchildren don't hang the call", async () => {
    const started = Date.now();
    const r = await bash.execute({ command: "sleep 30 & echo started" }, ctx());
    expect(Date.now() - started).toBeLessThan(4000);
    expect(text(r)).toContain("started");
  });

  test("long output is truncated in the middle, keeping head and tail", async () => {
    const r = await bash.execute({ command: `echo HEAD; head -c ${BASH_MAX_OUTPUT_CHARS * 2} /dev/zero | tr '\\0' x; echo; echo TAIL` }, ctx());
    const t = text(r);
    expect(t).toStartWith("HEAD");
    expect(t).toContain("TAIL");
    expect(t).toContain("characters truncated");
    expect(t.length).toBeLessThan(BASH_MAX_OUTPUT_CHARS + 200);
  });

  test("timeout_ms above the maximum is rejected by validation", async () => {
    const r = await bash.execute({ command: "true", timeout_ms: 10_000_000 }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("timeout_ms");
  });
});

describe("read_file", () => {
  test("numbers lines and pages with offset/limit", async () => {
    writeFileSync(join(dir, "f.txt"), "a\nb\nc\nd\ne\n");
    const all = text(await readFile.execute({ path: "f.txt" }, ctx()));
    expect(all.split("\n")).toEqual(["     1\ta", "     2\tb", "     3\tc", "     4\td", "     5\te"]);
    const page = text(await readFile.execute({ path: "f.txt", offset: 2, limit: 2 }, ctx()));
    expect(page).toStartWith("     2\tb\n     3\tc");
    expect(page).toContain("showing lines 2-3 of 5; use offset=4");
  });

  test("errors: missing file, directory, offset past end", async () => {
    writeFileSync(join(dir, "f.txt"), "one\n");
    expect((await readFile.execute({ path: "nope.txt" }, ctx())).isError).toBe(true);
    const d = await readFile.execute({ path: "." }, ctx());
    expect(d.isError).toBe(true);
    expect(text(d)).toContain("is a directory");
    const past = await readFile.execute({ path: "f.txt", offset: 5 }, ctx());
    expect(past.isError).toBe(true);
    expect(text(past)).toContain("past the end");
  });

  test("empty files, very long lines, binary files", async () => {
    writeFileSync(join(dir, "empty.txt"), "");
    writeFileSync(join(dir, "long.txt"), "x".repeat(5000));
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0]));
    expect(text(await readFile.execute({ path: "empty.txt" }, ctx()))).toContain("is empty");
    const long = text(await readFile.execute({ path: "long.txt" }, ctx()));
    expect(long).toContain("[line truncated]");
    expect(long.length).toBeLessThan(2100);
    expect((await readFile.execute({ path: "bin.dat" }, ctx())).isError).toBe(true);
  });

  test("images come back as image content", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(join(dir, "pic.png"), png);
    const r = await readFile.execute({ path: "pic.png" }, ctx());
    expect(r.content).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  });
});

describe("write_file", () => {
  test("creates parent directories and overwrites", async () => {
    const r = await writeFile.execute({ path: "a/b/c.txt", content: "hello" }, ctx());
    expect(text(r)).toContain("Wrote 5 bytes");
    expect(readFileSync(join(dir, "a/b/c.txt"), "utf8")).toBe("hello");
    await writeFile.execute({ path: "a/b/c.txt", content: "bye" }, ctx());
    expect(readFileSync(join(dir, "a/b/c.txt"), "utf8")).toBe("bye");
  });

  test("refuses to overwrite a directory", async () => {
    mkdirSync(join(dir, "sub"));
    const r = await writeFile.execute({ path: "sub", content: "x" }, ctx());
    expect(r.isError).toBe(true);
  });
});

describe("edit_file", () => {
  const file = () => join(dir, "code.ts");

  test("replaces a unique match exactly once", async () => {
    writeFileSync(file(), "const a = 1;\nconst b = 2;\n");
    const r = await editFile.execute({ path: "code.ts", old_string: "const b = 2;", new_string: "const b = 3;" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(readFileSync(file(), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  test("non-unique match is an error and leaves the file untouched", async () => {
    writeFileSync(file(), "x = 1\nx = 1\n");
    const r = await editFile.execute({ path: "code.ts", old_string: "x = 1", new_string: "x = 2" }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("occurs 2 times");
    expect(readFileSync(file(), "utf8")).toBe("x = 1\nx = 1\n");
  });

  test("replace_all replaces every occurrence and reports the count", async () => {
    writeFileSync(file(), "x = 1\nx = 1\nx = 1\n");
    const r = await editFile.execute({ path: "code.ts", old_string: "x = 1", new_string: "x = 2", replace_all: true }, ctx());
    expect(text(r)).toContain("Replaced 3 occurrences");
    expect(readFileSync(file(), "utf8")).toBe("x = 2\nx = 2\nx = 2\n");
  });

  test("missing match, missing file, empty and identical strings are errors", async () => {
    writeFileSync(file(), "hello\n");
    const missing = await editFile.execute({ path: "code.ts", old_string: "Hello", new_string: "hi" }, ctx());
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("was not found");
    expect((await editFile.execute({ path: "nope.ts", old_string: "a", new_string: "b" }, ctx())).isError).toBe(true);
    expect((await editFile.execute({ path: "code.ts", old_string: "", new_string: "b" }, ctx())).isError).toBe(true);
    expect((await editFile.execute({ path: "code.ts", old_string: "hello", new_string: "hello" }, ctx())).isError).toBe(true);
    expect(readFileSync(file(), "utf8")).toBe("hello\n");
  });

  test("$ patterns in new_string are inserted literally", async () => {
    writeFileSync(file(), "price = X\n");
    await editFile.execute({ path: "code.ts", old_string: "X", new_string: "$& $1 $$" }, ctx());
    expect(readFileSync(file(), "utf8")).toBe("price = $& $1 $$\n");
  });
});

describe("list_files", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "src/lib"), { recursive: true });
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "");
    writeFileSync(join(dir, "src/lib/b.ts"), "");
    writeFileSync(join(dir, "src/c.js"), "");
    writeFileSync(join(dir, ".env"), "");
    writeFileSync(join(dir, "node_modules/pkg/index.ts"), "");
    writeFileSync(join(dir, ".git/HEAD"), "");
  });

  test("without a pattern lists immediate entries, marking directories, skipping node_modules/.git", async () => {
    const t = text(await listFiles.execute({}, ctx()));
    expect(t.split("\n")).toEqual([".:", ".env", "src/"]);
  });

  test("glob pattern recurses and skips ignored directories", async () => {
    const t = text(await listFiles.execute({ pattern: "**/*.ts" }, ctx()));
    expect(t.split("\n").slice(1)).toEqual(["src/a.ts", "src/lib/b.ts"]);
  });

  test("path scopes the listing and results are relative to it", async () => {
    const t = text(await listFiles.execute({ path: "src", pattern: "*.js" }, ctx()));
    expect(t.split("\n")).toEqual(["src:", "c.js"]);
  });

  test("missing directory and no matches", async () => {
    expect((await listFiles.execute({ path: "nope" }, ctx())).isError).toBe(true);
    expect(text(await listFiles.execute({ pattern: "**/*.rb" }, ctx()))).toContain("No files match");
  });
});
