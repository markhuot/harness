import { describe, expect, test } from "bun:test";
import { insertMention } from "@harness/shared";
import { mentionAt, NO_CARET, onPick, onSelection, selectionProp } from "./mentionCaret";

describe("mention caret", () => {
  test("a collapsed caret after @READ is a mention; a range selection over it isn't", () => {
    const text = "Summarize @READ";
    const at = onSelection(NO_CARET, text.length, text.length);
    expect(mentionAt(text, at)?.query).toBe("READ");
    expect(mentionAt(text, onSelection(at, 10, text.length))).toBeNull();
  });

  test("no caret yet (the input never reported one) means no mention", () => {
    expect(mentionAt("@src", NO_CARET)).toBeNull();
  });

  test("a caret past the end (the value was just replaced by a shorter one) means no mention", () => {
    expect(mentionAt("@a", onSelection(NO_CARET, 9, 9))).toBeNull();
  });

  test("a pick forces the caret after the mention until the input lands there", () => {
    const text = "see @src/a";
    const mention = mentionAt(text, onSelection(NO_CARET, text.length, text.length))!;
    const next = insertMention(text, mention, "src/app.ts");
    let c = onPick(next.caret);
    expect(selectionProp(c)).toEqual({ start: next.caret, end: next.caret });
    // iOS reports the old caret once more before it applies the forced selection.
    c = onSelection(c, text.length, text.length);
    expect(selectionProp(c)).toEqual({ start: next.caret, end: next.caret });
    c = onSelection(c, next.caret, next.caret);
    expect(selectionProp(c)).toBeUndefined();
    expect(c.at).toBe(next.caret);
    // The completed file (followed by a space) no longer lists anything.
    expect(mentionAt(next.text, c)).toBeNull();
  });

  test("a folder pick keeps the list open inside it", () => {
    const text = "@sr";
    const mention = mentionAt(text, onSelection(NO_CARET, 3, 3))!;
    const next = insertMention(text, mention, "src/");
    expect(mentionAt(next.text, onSelection(onPick(next.caret), next.caret, next.caret))?.query).toBe("src/");
  });
});
