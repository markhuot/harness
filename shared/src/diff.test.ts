import { describe, expect, test } from "bun:test";
import { langForPath, parseDiff } from "./diff";

describe("langForPath", () => {
  test("uses the extension, through the fence aliases", () => {
    expect(langForPath("src/app.ts")).toBe("typescript");
    expect(langForPath("config/ci.yml")).toBe("yaml");
    expect(langForPath("a\\b\\c.rb")).toBe("ruby");
  });
  test("compound extensions and well-known names win over the last extension", () => {
    expect(langForPath("resources/views/home.blade.php")).toBe("blade");
    expect(langForPath("app/Http/Kernel.php")).toBe("php");
    expect(langForPath("Dockerfile")).toBe("docker");
    expect(langForPath(".env.local")).toBe("dotenv");
  });
  test("a dotfile or extensionless name has no language", () => {
    expect(langForPath("LICENSE")).toBeNull();
    expect(langForPath(".gitignore")).toBeNull();
    expect(langForPath(".envrc")).toBeNull();
  });
});

describe("parseDiff", () => {
  const kinds = (text: string) => parseDiff(text).lines.map((l) => l.kind);

  test("classifies a git diff and names its file without the b/ prefix", () => {
    const d = parseDiff(["diff --git a/src/app.ts b/src/app.ts", "index 1..2 100644", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"));
    expect(d.lines.map((l) => l.kind)).toEqual(["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add"]);
    expect(d.files).toEqual([{ path: "src/app.ts" }]);
  });

  test("inside a hunk, lines starting with --- and +++ are content, not a new file header", () => {
    // Removing a "---" line and adding a "+++ added" one: both within the hunk's counts.
    const d = parseDiff(["--- a/doc.md", "+++ b/doc.md", "@@ -1,2 +1,2 @@", " title", "----", "++++ added", "@@ -9 +9 @@", "-x", "+y"].join("\n"));
    expect(d.lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "ctx", "del", "add", "hunk", "del", "add"]);
    expect(d.files).toHaveLength(1);
  });

  test("once a hunk's counts run out, a ---/+++ pair starts the next file", () => {
    const d = parseDiff(["--- a/one.ts", "+++ b/one.ts", "@@ -1 +1 @@", "-a", "+b", "--- a/two.rb", "+++ b/two.rb", "@@ -1 +1 @@", "-c", "+d"].join("\n"));
    expect(d.files.map((f) => f.path)).toEqual(["one.ts", "two.rb"]);
    expect(d.lines.filter((l) => l.kind === "add").map((l) => l.file)).toEqual([0, 1]);
  });

  test("a second git file's header pair names that file instead of starting a third", () => {
    const d = parseDiff(["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-a", "+b", "diff --git a/b.py b/b.py", "--- a/b.py", "+++ b/b.py", "@@ -1 +1 @@", "-c", "+d"].join("\n"));
    expect(d.files.map((f) => f.path)).toEqual(["a.ts", "b.py"]);
  });

  test("a deleted file is named by its old path; a no-newline marker is meta", () => {
    const d = parseDiff(["--- a/gone.py", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", "\\ No newline at end of file"].join("\n"));
    expect(d.files).toEqual([{ path: "gone.py" }]);
    expect(d.lines.map((l) => l.kind)).toEqual(["meta", "meta", "hunk", "del", "meta"]);
  });

  test("hand-written diffs with a bare @@ or no headers go by first character", () => {
    expect(kinds("@@ @@\n a\n-b\n+c")).toEqual(["hunk", "ctx", "del", "add"]);
    expect(kinds("-old\n+new\n same")).toEqual(["del", "add", "ctx"]);
    expect(parseDiff("-old\n+new").files).toEqual([{ path: null }]);
  });
});
