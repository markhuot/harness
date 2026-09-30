import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { diffFiles } from "./CodeDiff";
import { Markdown } from "./Markdown";

test("hand-written diffs parse into @pierre/diffs files, named without their a/ b/ prefixes", () => {
  const bare = diffFiles("-old line\n+new line\n context");
  expect(bare).toHaveLength(1);
  expect(bare[0]!.hunks[0]!.additionLines).toBe(1);
  const miscounted = diffFiles("--- a/app.php\n+++ b/app.php\n@@ -1,40 +1,2 @@\n-a\n+b");
  expect(miscounted.map((f) => f.name)).toEqual(["app.php"]);
  const two = diffFiles("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b.yml b/b.yml\n--- a/b.yml\n+++ b/b.yml\n@@ -1 +1 @@\n-x\n+y");
  expect(two.map((f) => f.name)).toEqual(["a.ts", "b.yml"]);
});

test("fenced code renders its text right away (highlighting swaps in later), with a copy button", () => {
  const g = globalThis as { window?: unknown };
  g.window = {}; // useTheme reads window.harness
  let html: string;
  try {
    html = renderToStaticMarkup(<Markdown text={"```ts\nconst a = <b>1</b>;\n```"} />);
  } finally {
    delete g.window;
  }
  expect(html).toContain('data-lang="typescript"');
  expect(html).toContain("const a = &lt;b&gt;1&lt;/b&gt;;"); // escaped, never markup
  expect(html).toContain('class="code-copy"');
});
