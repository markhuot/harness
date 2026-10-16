import { describe, expect, test } from "bun:test";
import { inlineTokens, mediaIn, parseBlocks, plainText } from "../../../shared/src/state/markdown";

const item = (text: string, children: unknown[] = []) => ({ text, children });

describe("parseBlocks: paragraphs, headings, rules", () => {
  test("empty input has no blocks; blank lines split paragraphs; consecutive lines join with newlines", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("a\nb\n\nc")).toEqual([{ t: "p", text: "a\nb" }, { t: "p", text: "c" }]);
  });
  test("CRLF is normalised", () => {
    expect(parseBlocks("a\r\nb")).toEqual([{ t: "p", text: "a\nb" }]);
  });
  test("headings take 1 to 4 hashes; five hashes or no space is a paragraph", () => {
    expect(parseBlocks("# a\n#### d")).toEqual([{ t: "h", level: 1, text: "a" }, { t: "h", level: 4, text: "d" }]);
    expect(parseBlocks("##### e")[0]!.t).toBe("p");
    expect(parseBlocks("#nospace")[0]!.t).toBe("p");
  });
  test("a heading ends the paragraph above it", () => {
    expect(parseBlocks("para\n# h").map((b) => b.t)).toEqual(["p", "h"]);
  });
  test("three or more dashes or stars alone are a rule; two are not", () => {
    expect(parseBlocks("---\n*****")).toEqual([{ t: "hr" }, { t: "hr" }]);
    expect(parseBlocks("--")).toEqual([{ t: "p", text: "--" }]);
  });
});

describe("parseBlocks: code fences", () => {
  test("lang and body, closing fence dropped", () => {
    expect(parseBlocks("```ts\nlet a;\n\nlet b;\n```\nafter")).toEqual([{ t: "code", lang: "ts", text: "let a;\n\nlet b;" }, { t: "p", text: "after" }]);
  });
  test("an unclosed fence runs to the end", () => {
    expect(parseBlocks("```\nx\ny")).toEqual([{ t: "code", lang: "", text: "x\ny" }]);
  });
  test("a tilde fence is closed by a tilde line, not by backticks", () => {
    expect(parseBlocks("~~~\n```\n~~~")).toEqual([{ t: "code", lang: "", text: "```" }]);
  });
  test("an indented fence strips up to its own indent from the body, keeping deeper indentation", () => {
    expect(parseBlocks("  ```\n    deep\n  flat\n x\n  ```")).toEqual([{ t: "code", lang: "", text: "  deep\nflat\nx" }]);
  });
  test("a fence ends a paragraph in progress", () => {
    expect(parseBlocks("a\n```\nb\n```").map((b) => b.t)).toEqual(["p", "code"]);
  });
});

describe("parseBlocks: lists", () => {
  test("bullets with any marker; continuation lines join with spaces", () => {
    expect(parseBlocks("- a\n* b\n+ c\n  more")).toEqual([{ t: "ul", items: [item("a"), item("b"), item("c more")] }]);
  });
  test("ordered lists keep their start number, with . or )", () => {
    expect(parseBlocks("3. a\n4) b")).toEqual([{ t: "ol", start: 3, items: [item("a"), item("b")] }]);
  });
  test("a start number past 9 digits resets to 1", () => {
    expect((parseBlocks("1234567890. a")[0] as { start: number }).start).toBe(1);
    expect((parseBlocks("123456789. a")[0] as { start: number }).start).toBe(123456789);
  });
  test("a sibling of the other kind ends the list and starts another", () => {
    expect(parseBlocks("- a\n1. b").map((b) => b.t)).toEqual(["ul", "ol"]);
  });
  test("an item indented 2+ past its parent nests; one indented 1 does not", () => {
    expect(parseBlocks("- a\n  - b\n- c")).toEqual([{ t: "ul", items: [item("a", [{ t: "ul", items: [item("b")] }]), item("c")] }]);
    expect(parseBlocks("- a\n - b")).toEqual([{ t: "ul", items: [item("a"), item("b")] }]);
  });
  test("a nested list of another kind is a child, and an outdent returns to the parent", () => {
    const [list] = parseBlocks("- a\n  1. x\n  2. y\n- b");
    expect(list).toEqual({ t: "ul", items: [item("a", [{ t: "ol", start: 1, items: [item("x"), item("y")] }]), item("b")] });
  });
  test("a blank line followed by an indented line stays in the item as its own paragraph", () => {
    expect(parseBlocks("- a\n\n  para")).toEqual([{ t: "ul", items: [item("a", [{ t: "p", text: "para" }])] }]);
  });
  test("a blank line followed by an unindented line ends the list", () => {
    expect(parseBlocks("- a\n\nafter").map((b) => b.t)).toEqual(["ul", "p"]);
  });
  test("a blank line then a sibling item ends the list (loose lists become two lists, as documented on parseList)", () => {
    expect(parseBlocks("- a\n\n- b")).toEqual([{ t: "ul", items: [item("a")] }, { t: "ul", items: [item("b")] }]);
  });
  test("a fence under an item becomes its child code block, dedented", () => {
    expect(parseBlocks("- a\n  ```js\n  x\n  ```\n- b")).toEqual([{ t: "ul", items: [item("a", [{ t: "code", lang: "js", text: "x" }]), item("b")] }]);
  });
  test("a second continuation line after a code block is a paragraph child, and later lines extend it", () => {
    const [list] = parseBlocks("- a\n  ```\n  x\n  ```\n  tail one\n  tail two") as { items: { children: unknown[] }[] }[];
    expect(list!.items[0]!.children).toEqual([{ t: "code", lang: "", text: "x" }, { t: "p", text: "tail one\ntail two" }]);
  });
  test("a tab counts as four columns of indent", () => {
    expect(parseBlocks("- a\n\t- b")).toEqual([{ t: "ul", items: [item("a", [{ t: "ul", items: [item("b")] }])] }]);
  });
  test("a list item ends a paragraph above it; a dash with no space is not an item", () => {
    expect(parseBlocks("para\n- a").map((b) => b.t)).toEqual(["p", "ul"]);
    expect(parseBlocks("-a")[0]!.t).toBe("p");
  });
});

describe("parseBlocks: quotes", () => {
  test("consecutive > lines join, stripping one optional space", () => {
    expect(parseBlocks("> a\n>b\n> > c")).toEqual([{ t: "quote", text: "a\nb\n> c" }]);
  });
  test("a non-quote line ends the quote", () => {
    expect(parseBlocks("> a\nb").map((b) => b.t)).toEqual(["quote", "p"]);
  });
});

describe("parseBlocks: tables", () => {
  test("header, alignments and rows; short rows are padded and long ones truncated", () => {
    const [t] = parseBlocks("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 | 5 |");
    expect(t).toEqual({ t: "table", align: ["left", "center", "right", null], header: ["a", "b", "c", "d"], rows: [["1", "2", "", ""], ["1", "2", "3", "4"]] });
  });
  test("pipes without outer bars work; an escaped pipe and a pipe in a code span stay in the cell", () => {
    const [t] = parseBlocks("a | b\n-|-\nx \\| y | `p|q`");
    expect(t).toMatchObject({ header: ["a", "b"], rows: [["x | y", "`p|q`"]] });
  });
  test("a trailing escaped pipe is kept, not treated as the closing bar", () => {
    const [t] = parseBlocks("| a |\n|---|\n| x \\|");
    expect((t as { rows: string[][] }).rows).toEqual([["x |"]]);
  });
  test("the table ends at a blank line or a line without a pipe", () => {
    expect(parseBlocks("| a |\n|---|\n| 1 |\n\n| 2 |").map((b) => b.t)).toEqual(["table", "p"]);
    expect(parseBlocks("| a |\n|---|\n| 1 |\ntext").map((b) => b.t)).toEqual(["table", "p"]);
  });
  test("a column-count mismatch between header and delimiter is not a table", () => {
    expect(parseBlocks("| a | b |\n|---|").map((b) => b.t)).toEqual(["p"]);
  });
  test("a header line over a non-delimiter line is a paragraph", () => {
    expect(parseBlocks("| a |\n| b |")[0]!.t).toBe("p");
  });
  test("a pipe line as the last line (nothing under it) is a paragraph", () => {
    expect(parseBlocks("a | b")[0]!.t).toBe("p");
  });
});

describe("parseBlocks: media", () => {
  test("an attachment image alone on a line is a figure, a video when named so", () => {
    expect(parseBlocks("![shot](attachment:abc.png)")).toEqual([{ t: "img", alt: "shot", id: "abc.png", video: false, thumb: false }]);
    expect(parseBlocks("![](attachment:clip.MOV)")[0]).toMatchObject({ video: true });
    expect(parseBlocks("![demo.webm](attachment:x1)")[0]).toMatchObject({ video: true });
  });
  test("thumbnail images on adjacent lines share one row; a gap starts a new one", () => {
    const md = '![a](attachment:a1 "thumb") ![b](attachment:b1 "thumbnail")\n![c](attachment:c1 "thumb")\n\n![d](attachment:d1 "thumb")';
    const blocks = parseBlocks(md);
    expect(blocks.map((b) => (b.t === "thumbs" ? b.items.map((i) => i.id) : b.t))).toEqual([["a1", "b1", "c1"], ["d1"]]);
  });
  test("a thumbs line with other text is a paragraph; a non-thumb attachment alone is a figure", () => {
    expect(parseBlocks('hello ![a](attachment:a1 "thumb")')[0]!.t).toBe("p");
    expect(parseBlocks('![a](attachment:a1 "other")')[0]).toMatchObject({ t: "img", thumb: false });
  });
  test("an http image alone on a line is a paragraph (never fetched), not a figure", () => {
    expect(parseBlocks("![a](https://x.test/a.png)")[0]!.t).toBe("p");
  });
});

describe("inlineTokens", () => {
  test("plain text is one token; empty is none", () => {
    expect(inlineTokens("hello")).toEqual([{ t: "text", text: "hello" }]);
    expect(inlineTokens("")).toEqual([]);
  });
  test("code, strong and em", () => {
    expect(inlineTokens("a `b` **c** *d* e")).toEqual([
      { t: "text", text: "a " },
      { t: "code", text: "b" },
      { t: "text", text: " " },
      { t: "strong", text: "c" },
      { t: "text", text: " " },
      { t: "em", text: "d" },
      { t: "text", text: " e" },
    ]);
  });
  test("underscore emphasis needs word boundaries, so snake_case_names stay literal", () => {
    expect(inlineTokens("snake_case_name")).toEqual([{ t: "text", text: "snake_case_name" }]);
    expect(inlineTokens("an _em_ here")[1]).toEqual({ t: "em", text: "em" });
    expect(inlineTokens("a*b*c")[1]).toEqual({ t: "em", text: "b" });
  });
  test("a bare ticket key is a ticket token; lowercase and no-digit words are not", () => {
    expect(inlineTokens("see ABC-12.")).toEqual([{ t: "text", text: "see " }, { t: "ticket", key: "ABC-12" }, { t: "text", text: "." }]);
    expect(inlineTokens("abc-12 ABC")).toEqual([{ t: "text", text: "abc-12 ABC" }]);
  });
  test("links: http(s) and file targets are links, other schemes keep only the label", () => {
    expect(inlineTokens("[a](https://x.test)")).toEqual([{ t: "link", text: "a", url: "https://x.test" }]);
    expect(inlineTokens("[a](src/a.ts#L3)")).toEqual([{ t: "link", text: "a", url: "src/a.ts#L3" }]);
    expect(inlineTokens("[a](harness://file/a.ts)")[0]!.t).toBe("link");
    expect(inlineTokens("[a](javascript:alert(1))")).toEqual([{ t: "text", text: "a" }, { t: "text", text: ")" }]);
    expect(inlineTokens("[a](#anchor)")).toEqual([{ t: "text", text: "a" }]);
    expect(inlineTokens("[a](data:text/html,x)")).toEqual([{ t: "text", text: "a" }]);
  });
  test("a link whose target is a ticket key is a ticket token carrying the label", () => {
    expect(inlineTokens("[RFAWC-726](RFACOM-2)")).toEqual([{ t: "ticket", key: "RFACOM-2", text: "RFAWC-726" }]);
  });
  test("bare URLs autolink for http(s) only, stopping before ) and spaces", () => {
    expect(inlineTokens("go (https://x.test/a) now")[1]).toEqual({ t: "link", text: "https://x.test/a", url: "https://x.test/a" });
    expect(inlineTokens("ftp://x.test")).toEqual([{ t: "text", text: "ftp://x.test" }]);
  });
  test("emphasis around a link keeps the link live and emphasises the rest", () => {
    expect(inlineTokens("**see [a.ts](harness://file/a.ts) now**")).toEqual([
      { t: "strong", text: "see " },
      { t: "link", text: "a.ts", url: "harness://file/a.ts" },
      { t: "strong", text: " now" },
    ]);
    expect(inlineTokens("**plain ABC-1**")).toEqual([{ t: "strong", text: "plain ABC-1" }]);
  });
  test("emphasis around a labelled ticket link also splits; around a bare key it does not", () => {
    expect(inlineTokens("*[R-1](A-2)*")).toEqual([{ t: "ticket", key: "A-2", text: "R-1" }]);
  });
  test("images: attachments become img tokens; http and file sources become links labelled by alt (or src); others keep alt text", () => {
    expect(inlineTokens("![a](attachment:x.png)")).toEqual([{ t: "img", alt: "a", id: "x.png", video: false, thumb: false }]);
    expect(inlineTokens('![a](attachment:x.png "Thumb")')[0]).toMatchObject({ thumb: true });
    expect(inlineTokens("![a](https://x.test/p.png)")).toEqual([{ t: "link", text: "a", url: "https://x.test/p.png" }]);
    expect(inlineTokens("![](https://x.test/p.png)")).toEqual([{ t: "link", text: "https://x.test/p.png", url: "https://x.test/p.png" }]);
    expect(inlineTokens("![a](data:image/png;base64,AAA)")).toEqual([{ t: "text", text: "a" }]);
  });
  test("an attachment id that could escape (leading dot or slash) is not served as an img", () => {
    expect(inlineTokens("![a](attachment:../x)")[0]!.t).not.toBe("img");
    expect(inlineTokens("![a](attachment:.x)")[0]!.t).not.toBe("img");
  });
});

describe("mediaIn", () => {
  test("finds media in every block kind, once per id, first appearance first", () => {
    const md = [
      "![one](attachment:a1.png)",
      "text ![two](attachment:b1.png) and ![dup](attachment:a1.png)",
      "- item ![three](attachment:c1.png)",
      "  - nested ![four](attachment:d1.png)",
      "> quote ![five](attachment:e1.png)",
      "# head ![six](attachment:f1.png)",
      "| h ![seven](attachment:g1.png) |",
      "|---|",
      "| ![eight](attachment:h1.png) |",
      '![nine](attachment:i1.png "thumb")',
    ].join("\n\n");
    expect(mediaIn(parseBlocks(md)).map((m) => m.id)).toEqual(["a1.png", "b1.png", "c1.png", "d1.png", "e1.png", "f1.png", "g1.png", "h1.png", "i1.png"]);
  });
  test("code blocks are not searched, and no media gives an empty list", () => {
    expect(mediaIn(parseBlocks("```\n![a](attachment:x)\n```"))).toEqual([]);
    expect(mediaIn([])).toEqual([]);
  });
});

describe("plainText", () => {
  test("strips code fences, markup and heading/bullet markers, collapsing whitespace", () => {
    expect(plainText("# Title\n\n- **bold** and `code`\n- [link](http://x.test) ![img](attachment:a)\n\n```\nhidden\n```\nend")).toBe("Title • bold and code • link img end");
  });
  test("table rows join their cells with a dot and drop the delimiter row", () => {
    expect(plainText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("a · b 1 · 2");
  });
});
