import { describe, expect, test } from "bun:test";
import { diffText, specDiff, type DiffBlock, type DiffRun, type EditBlock } from "./specDiff";

/** Runs as compact strings: "=same", "+added", "-removed", with the style when it isn't text. */
const show = (runs: DiffRun[]) =>
  runs.map((r) => `${r.change === "same" ? "=" : r.change === "add" ? "+" : "-"}${r.t === "text" ? "" : r.t + ":"}${"text" in r && r.text !== undefined ? r.text : r.t === "ticket" ? r.key : ""}`);

const changes = (blocks: DiffBlock[]) => blocks.map((b) => `${b.change} ${b.block.t}`);

function edit(blocks: DiffBlock[], at = 0): EditBlock {
  const b = blocks[at]!;
  if (b.change !== "edit") throw new Error(`block ${at} is ${b.change}, not an edit`);
  return b.block;
}

describe("specDiff", () => {
  test("an unchanged spec is all same, with the parsed blocks as they are", () => {
    const md = "# Goal\n\nDo **it**.\n\n- a\n  - b\n\n```ts\nx\n```\n\n| k | v |\n|---|---|\n| 1 | 2 |\n\n---\n![s](attachment:s1)";
    const out = specDiff(md, md);
    expect(out.every((b) => b.change === "same")).toBe(true);
    expect(changes(out)).toEqual(["same h", "same p", "same ul", "same code", "same table", "same hr", "same img"]);
  });

  test("a one-word edit marks only that word", () => {
    const out = specDiff("# Plan\n\nThe quick fox jumps.", "# Plan\n\nThe slow fox jumps.");
    expect(changes(out)).toEqual(["same h", "edit p"]);
    expect(show((edit(out, 1) as { runs: DiffRun[] }).runs)).toEqual(["=The ", "-quick", "+slow", "= fox jumps."]);
  });

  test("a change inside bold keeps the bold style on every run", () => {
    const runs = diffText("Ship **the new build** today", "Ship **the old build** today");
    expect(show(runs)).toEqual(["=Ship ", "=strong:the ", "-strong:new", "+strong:old", "=strong: build", "= today"]);
  });

  test("a change inside a link keeps the url on its runs", () => {
    const runs = diffText("See [the long docs](https://x.test/d) now", "See [the short docs](https://x.test/d) now");
    expect(runs.filter((r) => r.t === "link").every((r) => r.t === "link" && r.url === "https://x.test/d")).toBe(true);
    expect(show(runs)).toEqual(["=See ", "=link:the ", "-link:long", "+link:short", "=link: docs", "= now"]);
  });

  test("a changed link target is a removed and an added word, not a same one", () => {
    expect(show(diffText("[docs](https://a.test) here", "[docs](https://b.test) here"))).toEqual(["-link:docs", "+link:docs", "= here"]);
  });

  test("ticket keys are whole words", () => {
    expect(show(diffText("Blocked on HARNESS-1 today", "Blocked on HARNESS-2 today"))).toEqual(["=Blocked on ", "-ticket:HARNESS-1", "+ticket:HARNESS-2", "= today"]);
  });

  test("a space left between two changes joins them, removals first", () => {
    expect(show(diffText("keep alpha beta keep", "keep gamma delta keep"))).toEqual(["=keep ", "-alpha beta", "+gamma delta", "= keep"]);
  });

  test("paragraph line breaks survive in the runs", () => {
    expect(show(diffText("one\ntwo three", "one\ntwo four"))).toEqual(["=one\ntwo ", "-three", "+four"]);
  });

  test("an inserted list item is added and its neighbours stay the same", () => {
    const out = specDiff("- a\n- c", "- a\n- b\n- c");
    const list = edit(out);
    if (list.t !== "ul") throw new Error(list.t);
    expect(list.items.map((i) => i.change)).toEqual(["same", "add", "same"]);
    expect(list.items[1]).toEqual({ change: "add", item: { text: "b", children: [] } });
  });

  test("an inserted nested item edits its parent item and adds itself", () => {
    const out = specDiff("- a\n  - x\n- b", "- a\n  - x\n  - y\n- b");
    const list = edit(out);
    if (list.t !== "ul") throw new Error(list.t);
    expect(list.items.map((i) => i.change)).toEqual(["edit", "same"]);
    const parent = list.items[0]!;
    if (parent.change !== "edit") throw new Error(parent.change);
    expect(show(parent.runs)).toEqual(["=a"]);
    const nested = edit(parent.children);
    if (nested.t !== "ul") throw new Error(nested.t);
    expect(nested.items.map((i) => i.change)).toEqual(["same", "add"]);
  });

  test("an edited list item diffs its words", () => {
    const list = edit(specDiff("- write the tests\n- ship", "- write the unit tests\n- ship"));
    if (list.t !== "ul") throw new Error(list.t);
    const item = list.items[0]!;
    if (item.change !== "edit") throw new Error(item.change);
    expect(show(item.runs)).toEqual(["=write the ", "+unit ", "=tests"]);
  });

  test("an ordered list keeps the newer start number", () => {
    const list = edit(specDiff("1. a\n2. b", "3. a\n4. b\n5. c"));
    expect(list).toMatchObject({ t: "ol", start: 3 });
  });

  test("an added table row and a changed cell", () => {
    const out = specDiff("| k | v |\n|---|---|\n| a | one two |\n| b | 2 |", "| k | v |\n|---|---|\n| a | one three |\n| b | 2 |\n| c | 3 |");
    const table = edit(out);
    if (table.t !== "table") throw new Error(table.t);
    expect(table.rows.map((r) => r.change)).toEqual(["edit", "same", "add"]);
    const row = table.rows[0]!;
    if (row.change !== "edit") throw new Error(row.change);
    expect(row.cells.map(show)).toEqual([["=a"], ["=one ", "-two", "+three"]]);
    expect(table.header.map(show)).toEqual([["=k"], ["=v"]]);
  });

  test("a table with a new column is removed and added whole", () => {
    expect(changes(specDiff("| a |\n|---|\n| 1 |", "| a | b |\n|---|---|\n| 1 | 2 |"))).toEqual(["del table", "add table"]);
  });

  test("a code block diffs its lines inside the fence", () => {
    const code = edit(specDiff("```ts\nconst a = 1;\nconst b = 2;\nrun();\n```", "```ts\nconst a = 1;\nconst b = 3;\nrun();\n```"));
    expect(code).toEqual({
      t: "code",
      lang: "ts",
      lines: [
        { change: "same", text: "const a = 1;" },
        { change: "del", text: "const b = 2;" },
        { change: "add", text: "const b = 3;" },
        { change: "same", text: "run();" },
      ],
    });
  });

  test("a code block that changed language is removed and added whole", () => {
    expect(changes(specDiff("```ts\nx\n```", "```js\nx\n```"))).toEqual(["del code", "add code"]);
  });

  test("a heading whose level changed is removed and added whole", () => {
    expect(specDiff("## Status", "### Status")).toEqual([
      { change: "del", block: { t: "h", level: 2, text: "Status" } },
      { change: "add", block: { t: "h", level: 3, text: "Status" } },
    ]);
  });

  test("a paragraph that became a list is removed and added", () => {
    expect(changes(specDiff("# T\n\nalpha beta", "# T\n\n- alpha beta"))).toEqual(["same h", "del p", "add ul"]);
  });

  test("an empty older revision adds everything; an empty newer one removes everything", () => {
    expect(changes(specDiff("", "# A\n\ntext"))).toEqual(["add h", "add p"]);
    expect(changes(specDiff("# A\n\ntext", ""))).toEqual(["del h", "del p"]);
    expect(specDiff("", "")).toEqual([]);
  });

  test("an unpaired added block before a paired one keeps reading order", () => {
    const out = specDiff("# T\n\nold words here", "# T\n\nbrand new intro\n\n- x\n\nold words there");
    expect(changes(out)).toEqual(["same h", "add p", "add ul", "edit p"]);
  });

  test("images and rules are added or removed, never edited", () => {
    expect(changes(specDiff("![a](attachment:a)", "![b](attachment:b)"))).toEqual(["del img", "add img"]);
    expect(changes(specDiff("x\n\n---", "x"))).toEqual(["same p", "del hr"]);
  });

  describe("the 40% noise guard", () => {
    // Dice coefficient: 2 · shared words / (old words + new words), paired when >= 0.4.
    test("2 of 5 words shared on each side (0.4) is still one edited paragraph", () => {
      const out = specDiff("a b c d e", "a b x y z");
      expect(changes(out)).toEqual(["edit p"]);
      expect(show((edit(out) as { runs: DiffRun[] }).runs)).toEqual(["=a b ", "-c d e", "+x y z"]);
    });

    test("1 of 5 words shared (0.2) shows the old paragraph removed and the new one added", () => {
      expect(changes(specDiff("a b c d e", "a x y z w"))).toEqual(["del p", "add p"]);
    });

    test("uneven lengths: 1 shared of 2 and 3 words (0.4) pairs, of 2 and 4 (0.33) doesn't", () => {
      expect(changes(specDiff("a b", "a x y"))).toEqual(["edit p"]);
      expect(changes(specDiff("a b", "a x y z"))).toEqual(["del p", "add p"]);
    });

    test("list items use the same guard", () => {
      const list = edit(specDiff("- alpha beta gamma delta epsilon\n- keep", "- one two three four five\n- keep"));
      if (list.t !== "ul") throw new Error(list.t);
      expect(list.items.map((i) => i.change)).toEqual(["del", "add", "same"]);
    });
  });
});
