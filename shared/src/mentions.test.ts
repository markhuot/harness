import { describe, expect, test } from "bun:test";
import { activeMention, insertMention, parseMentions, rankPaths } from "./mentions";

/** activeMention at the `|` in `s`. */
function at(s: string) {
  const caret = s.indexOf("|");
  return activeMention(s.replace("|", ""), caret);
}

describe("activeMention", () => {
  test("finds the word after an @ at the start, after whitespace or a bracket", () => {
    expect(at("@sr|")).toEqual({ start: 0, end: 3, query: "sr", quoted: false });
    expect(at("see @src/ap|")).toEqual({ start: 4, end: 11, query: "src/ap", quoted: false });
    expect(at("fix (@a|")?.query).toBe("a");
    expect(at("line\n@x|")?.start).toBe(5);
  });

  test("a bare @ is a mention with an empty query", () => {
    expect(at("look at @|")).toEqual({ start: 8, end: 9, query: "", quoted: false });
  });

  test("an @ inside a word (an email address) isn't a mention", () => {
    expect(at("mail mark@exam|")).toBeNull();
    expect(at("a@|")).toBeNull();
  });

  test("the caret must be in the mention", () => {
    expect(at("@src done|")).toBeNull();
    expect(at("|@src")).toBeNull();
    expect(at("plain text|")).toBeNull();
  });

  test("with the caret mid-word, the mention runs to the end of the word", () => {
    expect(at("@sr|c/app.ts next")).toEqual({ start: 0, end: 11, query: "sr", quoted: false });
  });

  test("quoted mentions allow spaces and end at the closing quote", () => {
    expect(at('see @"My Doc|')).toEqual({ start: 4, end: 12, query: "My Doc", quoted: true });
    expect(at('@"My |Doc.md" rest')).toEqual({ start: 0, end: 12, query: "My ", quoted: true });
  });

  test("a closed quoted mention before the caret doesn't capture later text", () => {
    expect(at('@"a b" and more|')).toBeNull();
  });
});

describe("insertMention", () => {
  test("replaces the mention with the path and a space, caret after it", () => {
    const text = "look at @sr please";
    const m = activeMention(text, 11)!;
    expect(insertMention(text, m, "src/app.ts")).toEqual({ text: "look at @src/app.ts please", caret: 20 });
  });

  test("adds a space at the end of the text", () => {
    const m = activeMention("@ap", 3)!;
    expect(insertMention("@ap", m, "app.ts")).toEqual({ text: "@app.ts ", caret: 8 });
  });

  test("a directory gets no space, so completion continues inside it", () => {
    const m = activeMention("@sr", 3)!;
    expect(insertMention("@sr", m, "src/")).toEqual({ text: "@src/", caret: 5 });
  });

  test("quotes paths with spaces; a quoted directory stays open", () => {
    const m = activeMention("@my", 3)!;
    expect(insertMention("@my", m, "My Docs/a b.md").text).toBe('@"My Docs/a b.md" ');
    expect(insertMention("@my", m, "My Docs/")).toEqual({ text: '@"My Docs/', caret: 10 });
    const inner = activeMention('@"My Docs/', 10)!;
    expect(insertMention('@"My Docs/', inner, "My Docs/a b.md").text).toBe('@"My Docs/a b.md" ');
  });
});

describe("parseMentions", () => {
  test("finds unquoted and quoted mentions, in order, once each", () => {
    expect(parseMentions('Read @src/a.ts and @"docs/My Notes.md", then @src/a.ts again')).toEqual(["src/a.ts", "docs/My Notes.md"]);
  });

  test("drops sentence punctuation after a path", () => {
    expect(parseMentions("Look at @README.md. Also (@lib/x.ts), ok?")).toEqual(["README.md", "lib/x.ts"]);
  });

  test("ignores email addresses and a lone @", () => {
    expect(parseMentions("mail mark@example.com @ now")).toEqual([]);
  });
});

describe("rankPaths", () => {
  const paths = ["src/", "src/app.ts", "src/lib/", "src/lib/format.ts", "app/", "app/main.ts", "README.md", "docs/formatting.md", "test/fmt.ts"];

  test("path prefix beats name prefix beats folder prefix beats substring", () => {
    expect(rankPaths(paths, "src/l")).toEqual(["src/lib/", "src/lib/format.ts"]);
    expect(rankPaths(paths, "app")).toEqual(["app/", "app/main.ts", "src/app.ts"]);
    expect(rankPaths(paths, "form")).toEqual(["src/lib/format.ts", "docs/formatting.md"]);
    expect(rankPaths(paths, "lib")).toEqual(["src/lib/", "src/lib/format.ts"]);
    expect(rankPaths(paths, "mat")).toEqual(["src/lib/format.ts", "docs/formatting.md"]);
  });

  test("in-order letters count only when nothing matches outright", () => {
    expect(rankPaths(paths, "fmt")).toEqual(["test/fmt.ts"]);
    expect(rankPaths(paths, "frmt")).toEqual(["src/lib/format.ts", "docs/formatting.md"]);
  });

  test("a completed folder lists its contents, not itself", () => {
    expect(rankPaths(paths, "src/")).toEqual(["src/lib/", "src/app.ts", "src/lib/format.ts"]);
  });

  test("is case-insensitive", () => {
    expect(rankPaths(paths, "readme")).toEqual(["README.md"]);
  });

  test("no match, no results", () => {
    expect(rankPaths(paths, "zzz")).toEqual([]);
  });

  test("an empty query lists only the top level", () => {
    expect(rankPaths(paths, "")).toEqual(["app/", "src/", "README.md"]);
  });

  test("respects the limit", () => {
    expect(rankPaths(paths, "s", 2)).toHaveLength(2);
  });
});
