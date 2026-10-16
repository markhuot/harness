import { describe, expect, test } from "bun:test";
import { diffText, diffUnchanged, specDiff, type DiffBlock } from "../../../shared/src/state/specDiff";

const kinds = (blocks: DiffBlock[]) => blocks.map((b) => `${b.change}:${b.block.t}`);
/** Runs as "-del", "+add", "same" strings for compact assertions. */
const runs = (a: string, b: string) => diffText(a, b).map((r) => `${r.change === "del" ? "-" : r.change === "add" ? "+" : "="}${"text" in r ? r.text : r.t}`);

describe("diffText", () => {
  test("identical text is one same run", () => {
    expect(runs("a b", "a b")).toEqual(["=a b"]);
  });
  test("a changed word is a deletion before an addition, with the shared words merged around it", () => {
    expect(runs("the cat sat", "the dog sat")).toEqual(["=the ", "-cat", "+dog", "= sat"]);
  });
  test("a pure insertion and a pure deletion", () => {
    expect(runs("a c", "a b c")).toEqual(["=a ", "+b ", "=c"]);
    expect(runs("a b c", "a c")).toEqual(["=a ", "-b ", "=c"]);
  });
  test("whitespace alone between two changes joins the change rather than staying 'same'", () => {
    // "a b" -> "x y": the lone space would match; it must become del+add so the edit reads as one swap
    expect(runs("a b", "x y")).toEqual(["-a b", "+x y"]);
  });
  test("whitespace at the edge of the text next to a change stays same", () => {
    expect(runs("a b", "a c")).toEqual(["=a ", "-b", "+c"]);
  });
  test("styles are part of identity: the same word in bold vs plain changes", () => {
    const r = diffText("word", "**word**");
    expect(r.map((x) => [x.t, x.change])).toEqual([["text", "del"], ["strong", "add"]]);
  });
  test("a link's URL is part of identity", () => {
    const r = diffText("[a](https://x.test/1)", "[a](https://x.test/2)");
    expect(r.map((x) => x.change)).toEqual(["del", "add"]);
  });
  test("ticket tokens never merge with each other", () => {
    const r = diffText("", "A-1 B-2");
    expect(r.filter((x) => x.t === "ticket")).toHaveLength(2);
  });
  test("an img token is compared whole (alt or id change makes a different unit)", () => {
    const r = diffText("![a](attachment:x1)", "![a](attachment:x2)");
    expect(r.map((x) => [x.t, x.change])).toEqual([["img", "del"], ["img", "add"]]);
  });
  test("newlines are their own units, so a line break change shows", () => {
    expect(runs("a\nb", "a b")).toEqual(["=a", "-\n", "+ ", "=b"]);
  });
  test("empty on either side", () => {
    expect(diffText("", "")).toEqual([]);
    expect(runs("", "new")).toEqual(["+new"]);
    expect(runs("old", "")).toEqual(["-old"]);
  });
});

describe("specDiff: block alignment", () => {
  test("identical specs are all same, and diffUnchanged says so", () => {
    const d = specDiff("# T\n\npara\n\n- a", "# T\n\npara\n\n- a");
    expect(kinds(d)).toEqual(["same:h", "same:p", "same:ul"]);
    expect(diffUnchanged(d)).toBe(true);
  });
  test("diffUnchanged is true for no blocks and false for any change", () => {
    expect(diffUnchanged([])).toBe(true);
    expect(diffUnchanged(specDiff("a", "b b b"))).toBe(false);
  });
  test("an added block and a removed block", () => {
    expect(kinds(specDiff("a", "a\n\n---"))).toEqual(["same:p", "add:hr"]);
    expect(kinds(specDiff("a\n\n---", "a"))).toEqual(["same:p", "del:hr"]);
  });
  test("from empty and to empty", () => {
    expect(kinds(specDiff("", "x"))).toEqual(["add:p"]);
    expect(kinds(specDiff("x", ""))).toEqual(["del:p"]);
  });
  test("a similar paragraph pairs as an edit with word runs", () => {
    const [b] = specDiff("the quick brown fox", "the quick red fox");
    expect(b!.change).toBe("edit");
    expect(b!.block.t).toBe("p");
  });
  test("a dissimilar paragraph is deleted then added, never one edit (Dice below 0.4)", () => {
    expect(kinds(specDiff("alpha beta gamma", "one two three"))).toEqual(["del:p", "add:p"]);
  });
  test("exactly at the threshold pairs: 2 of 5 shared words each side is 0.4", () => {
    expect(kinds(specDiff("a b c d e", "a b x y z"))).toEqual(["edit:p"]);
    expect(kinds(specDiff("a b c d e f", "a b x y z w"))).toEqual(["del:p", "add:p"]);
  });
  test("two empty-text blocks are similar; empty vs non-empty is not", () => {
    // a heading with no text on both sides pairs even when the level matches
    expect(kinds(specDiff("#  ", "#  \n\ntail"))).toContain("same:h");
    expect(kinds(specDiff("# ", "# real text"))).toEqual(["del:h", "add:h"]);
  });
  test("deletions come before additions at a tie (not paired)", () => {
    expect(kinds(specDiff("![a](attachment:x1)", "![b](attachment:x2)"))).toEqual(["del:img", "add:img"]);
  });
  test("rules and images never pair, even when only an attribute differs", () => {
    expect(kinds(specDiff("![a](attachment:x1)\n\n---", "![a](attachment:x2)\n\n---"))).toEqual(["del:img", "add:img", "same:hr"]);
  });
  test("a paragraph and a heading with the same words don't pair (different kinds)", () => {
    expect(kinds(specDiff("same words here", "# same words here"))).toEqual(["del:p", "add:h"]);
  });
  test("a deleted block pairs with the first similar addition, emitting the adds it skipped first", () => {
    const d = specDiff("the quick brown fox jumps", "totally unrelated words\n\nthe quick brown fox leaps");
    expect(kinds(d)).toEqual(["add:p", "edit:p"]);
  });
  test("an addition left over after pairing is emitted at the end of the gap", () => {
    const d = specDiff("the quick brown fox jumps", "the quick brown fox leaps\n\nextra unrelated sentence entirely");
    expect(kinds(d)).toEqual(["edit:p", "add:p"]);
  });
  test("an unmatched block stays between matched ones in reading order", () => {
    const d = specDiff("first\n\nmiddle\n\nlast", "first\n\nlast");
    expect(d.map((b) => b.change)).toEqual(["same", "del", "same"]);
  });
});

describe("specDiff: headings", () => {
  test("same level and similar text is an edit carrying the new level", () => {
    const [b] = specDiff("## Old plan title", "## New plan title");
    expect(b).toMatchObject({ change: "edit", block: { t: "h", level: 2 } });
  });
  test("a level change never pairs", () => {
    expect(kinds(specDiff("## Plan title", "### Plan title"))).toEqual(["del:h", "add:h"]);
  });
});

describe("specDiff: quotes and code", () => {
  test("quotes pair on similar text", () => {
    expect(kinds(specDiff("> keep this part\n> one", "> keep this part\n> two"))).toEqual(["edit:quote"]);
  });
  test("code with the same lang diffs by line; the lang differing means no pairing", () => {
    const [b] = specDiff("```ts\na\nb\nc\n```", "```ts\na\nx\nc\n```");
    expect(b!.change).toBe("edit");
    expect((b!.block as { lines: { change: string; text: string }[] }).lines).toEqual([
      { change: "same", text: "a" },
      { change: "del", text: "b" },
      { change: "add", text: "x" },
      { change: "same", text: "c" },
    ]);
    expect(kinds(specDiff("```ts\na\n```", "```js\nb\n```"))).toEqual(["del:code", "add:code"]);
  });
});

describe("specDiff: lists", () => {
  test("items added, removed, kept and edited", () => {
    const [b] = specDiff("- keep me\n- remove me now\n- edit this item text", "- keep me\n- edit this item words\n- brand new thing");
    expect(b!.change).toBe("edit");
    const items = (b!.block as { items: { change: string }[] }).items;
    expect(items.map((i) => i.change)).toEqual(["same", "del", "edit", "add"]);
  });
  test("nested lists diff recursively inside an edited item", () => {
    const [b] = specDiff("- parent item\n  - child one\n  - child two", "- parent item\n  - child one\n  - child three more");
    const items = (b!.block as { items: { change: string; children?: DiffBlock[] }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.change).toBe("edit");
    expect(items[0]!.children![0]).toMatchObject({ change: "edit", block: { t: "ul" } });
  });
  test("an ordered list edit carries the newer revision's start number", () => {
    const [b] = specDiff("1. one thing\n2. two things", "5. one thing\n6. two thing");
    expect(b).toMatchObject({ change: "edit", block: { t: "ol", start: 5 } });
  });
  test("a bullet list and a numbered list never pair", () => {
    expect(kinds(specDiff("- a b c", "1. a b c"))).toEqual(["del:ul", "add:ol"]);
  });
  test("a changed list always pairs with a changed list of the same kind, even if nothing is shared", () => {
    expect(kinds(specDiff("- aaa", "- zzz"))).toEqual(["edit:ul"]);
  });
});

describe("specDiff: tables", () => {
  const table = (rows: string[], align = "|---|---|") => ["| h1 | h2 |", align, ...rows].join("\n");
  test("a similar row becomes an edit, a dissimilar one a deletion and an addition", () => {
    const [b] = specDiff(table(["| same | row |", "| old value | x |", "| gone | row here |"]), table(["| same | row |", "| new value | x |", "| fresh | row there |"]));
    expect(b!.change).toBe("edit");
    const rows = (b!.block as { rows: { change: string; cells: unknown }[] }).rows;
    expect(rows.map((r) => r.change)).toEqual(["same", "edit", "del", "add"]); // "gone row here" vs "fresh row there" share 1 of 3 words: 0.33, below the threshold
  });
  test("a row with no similar partner is a deletion and an addition", () => {
    const [b] = specDiff(table(["| aaa | bbb |"]), table(["| xxx | yyy |"]));
    expect((b!.block as { rows: { change: string }[] }).rows.map((r) => r.change)).toEqual(["del", "add"]);
  });
  test("header cells diff as runs", () => {
    const [b] = specDiff("| old | h2 |\n|---|---|\n| a | b |", "| new | h2 |\n|---|---|\n| a | b |");
    const header = (b!.block as { header: { change: string }[][] }).header;
    expect(header[0]!.map((r) => r.change)).toEqual(["del", "add"]);
    expect(header[1]!.map((r) => r.change)).toEqual(["same"]);
  });
  test("different alignments mean the tables don't pair", () => {
    expect(kinds(specDiff(table(["| a | b |"]), table(["| a | b |"], "|:--|---|")))).toEqual(["del:table", "add:table"]);
  });
  test("a table that gains a column does not pair with the old one", () => {
    const [b] = specDiff("| a |\n|---|\n| 1 |", "| a | b |\n|---|---|\n| 1 | 2 |");
    // the alignment arrays differ in length, so they never pair
    expect(b!.change).toBe("del");
  });
});
