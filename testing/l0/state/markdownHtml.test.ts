import { describe, expect, test } from "bun:test";
import { markdownToHtml } from "../../../shared/src/state/markdownHtml";

describe("markdownToHtml", () => {
  test("headings, paragraphs with their line breaks, rules and code blocks", () => {
    expect(markdownToHtml("## Goal\n\nline one\nline two\n\n---\n\n```ts\nconst a = 1 < 2;\n```")).toBe(
      "<h2>Goal</h2><p>line one<br>line two</p><hr><pre><code>const a = 1 &lt; 2;</code></pre>",
    );
  });

  test("text and inline code are escaped, so markdown can't smuggle markup into the paste", () => {
    expect(markdownToHtml('<script>alert("x")</script> & `<b>`')).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; <code>&lt;b&gt;</code></p>");
  });

  test("emphasis, and only http(s) links stay links; file links, tickets and attachments become their text", () => {
    expect(markdownToHtml("**bold** *it* [site](https://x.dev/?a=1&b=2) [a.ts:3](harness://file/a.ts#L3) [FOO-1](WEB-2) HARNESS-5 ![shot](attachment:abc.png)")).toBe(
      '<p><strong>bold</strong> <em>it</em> <a href="https://x.dev/?a=1&amp;b=2">site</a> a.ts:3 FOO-1 HARNESS-5 <em>shot</em></p>',
    );
  });

  test("nested lists keep their nesting and start number; task items and questions lead with a box", () => {
    expect(markdownToHtml("3. three\n4. four\n   - [ ] open\n   - [x] done\n\n- ( ) ask?\n- (x) asked")).toBe(
      '<ol start="3"><li>three</li><li>four<ul><li>☐ open</li><li>☑ done</li></ul></li></ol><ul><li>☐ ask?</li><li>☑ asked</li></ul>',
    );
  });

  test("tables carry their column alignment; quotes keep their lines", () => {
    expect(markdownToHtml("| a | b |\n|:-:|---|\n| 1 | **2** |\n\n> one\n> two")).toBe(
      '<table><thead><tr><th style="text-align:center">a</th><th>b</th></tr></thead><tbody><tr><td style="text-align:center">1</td><td><strong>2</strong></td></tr></tbody></table><blockquote><p>one<br>two</p></blockquote>',
    );
  });

  test("a figure becomes its caption, a thumbnail row its alt texts, and an image with no alt text nothing", () => {
    expect(markdownToHtml('![After](attachment:a.png)\n\n![Before](attachment:b.png "thumb") ![](attachment:c.png "thumb")\n\n![](attachment:d.png)')).toBe(
      "<p><em>After</em></p><p><em>Before</em></p>",
    );
  });
});
