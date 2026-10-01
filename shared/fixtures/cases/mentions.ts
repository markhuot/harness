// @-mentions (shared/src/mentions.ts) for HarnessKit's Mentions.swift. Carets and offsets are JS
// string indices (UTF-16 code units), so the cases with emoji, combining marks and CJK before the
// caret pin that the Swift port counts the same way UITextView/NSRange does.
import { type ActiveMention, activeMention, formatMention, insertMention, parseMentions, rankPaths } from "../../src/mentions";
import { cases } from "../case";

/** `|` marks the caret (as in mentions.test.ts). */
const at = (s: string) => ({ text: s.replace("|", ""), caret: s.indexOf("|") });

export const activeMentionCases = cases(({ text, caret }: { text: string; caret: number }) => activeMention(text, caret), {
  // mentions.test.ts
  "at the start": at("@sr|"),
  "after a space": at("see @src/ap|"),
  "after a bracket": at("fix (@a|"),
  "after a newline": at("line\n@x|"),
  "bare @": at("look at @|"),
  "email address": at("mail mark@exam|"),
  "a@": at("a@|"),
  "caret after the word": at("@src done|"),
  "caret before the @": at("|@src"),
  "no @": at("plain text|"),
  "caret mid-word runs to the end of the word": at("@sr|c/app.ts next"),
  "quoted with a space": at('see @"My Doc|'),
  "quoted ends at the closing quote": at('@"My |Doc.md" rest'),
  "closed quoted mention before the caret": at('@"a b" and more|'),
  // boundaries
  "caret 0 on empty text": { text: "", caret: 0 },
  "negative caret": { text: "@a", caret: -1 },
  "caret past the end": { text: "@a", caret: 3 },
  "caret at the end exactly": { text: "x @ab", caret: 5 },
  "after an opening brace": at("{@a|"),
  "after an opening square bracket": at("[@a|"),
  "after a single quote": at("'@a|"),
  "after a backtick": at("`@a|"),
  "after a double quote": at('"@a|'),
  "after a tab": at("\t@a|"),
  "after NBSP (JS whitespace)": at(" @a|"),
  "after NEL (not JS whitespace)": at("\u0085@a|"),
  "after an ideographic space": at("x　@a|"),
  "after a closing bracket is no boundary": at(")@a|"),
  "two @s: the inner one is mid-word": at("@a@b|"),
  "space then @@": at(" @@b|"),
  "word ends at a tab": at("@a|b\tc"),
  "word ends at NBSP": at("@a|b c"),
  "word does not end at NEL": at("@a|b\u0085c"),
  // quoted
  "quoted open, nothing typed": at('@"|'),
  "quoted with a newline before the caret": at('@"a\nb|'),
  "quoted close on a later line is not the end": at('@"a|b\nc"'),
  "quoted close before a newline": at('@"a|b"\nc'),
  "quoted after an email-like @": at('x@"a|'),
  "quoted with a bracket boundary": at('(@"a b|'),
  "quote not after @": at('say "hi|'),
  "unquoted query starting with a quote": at('@x"|'),
  "quoted at index 0 is unquoted-scanned": at('"|'),
  // UTF-16 offsets
  "emoji before the mention": at("😀 @sr|"),
  "emoji in the query": at("@😀a|"),
  "combining mark before the mention": at("é @a|"),
  "combining mark right before the @ is no boundary": at("é@a|"),
  "combining mark in the query": at("@é|"),
  "CJK and emoji before a quoted mention": at('日本😀 @"My D|oc" x'),
  "flag emoji after the caret runs the word": at("@a|🇩🇪 b"),
  "ZWJ family before": at("👨‍👩‍👧 @x|"),
});

type InsertInput = { text: string; mention: ActiveMention; path: string };
const pick = (s: string, path: string): InsertInput => {
  const { text, caret } = at(s);
  return { text, mention: activeMention(text, caret)!, path };
};

export const insertMentionCases = cases(({ text, mention, path }: InsertInput) => insertMention(text, mention, path), {
  // mentions.test.ts
  "file with a space and the caret after it": pick("look at @sr| please", "src/app.ts"),
  "file at the end of the text": pick("@ap|", "app.ts"),
  directory: pick("@sr|", "src/"),
  "quoted file": pick("@my|", "My Docs/a b.md"),
  "quoted directory stays open": pick("@my|", "My Docs/"),
  "inside an open quoted directory": pick('@"My Docs/|', "My Docs/a b.md"),
  // more
  "quote characters are stripped from a path": pick("@a|", 'we"ird name.md'),
  "quote without whitespace still quotes": pick("@a|", 'a"b.md'),
  "after already starts with a newline": pick("@a|\nnext", "a.ts"),
  "after already starts with a tab": pick("@a|\tnext", "a.ts"),
  "after starts with NBSP": pick("@a| x", "a.ts"),
  "directory before existing text": pick("@s|rc rest", "src/"),
  "quoted mention replaced to its closing quote": pick('@"My |Doc.md" rest', "My Doc.md"),
  "unquoted mid-word replaced to the word end": pick("@sr|c/app.ts next", "src/lib.ts"),
  "emoji before the mention": pick("😀 @sr|", "src/app.ts"),
  "emoji in the picked path": pick("@a|", "😀/a.ts"),
  "combining mark in the picked path": pick("x @e|", "é.md"),
  "path with NBSP is quoted": pick("@a|", "a b.md"),
  "empty path": pick("@|", ""),
  "path that is only a slash": pick("@|", "/"),
});

export const formatMentionCases = cases(formatMention, {
  plain: "src/app.ts",
  space: "a b.md",
  tab: "a\tb",
  quote: 'a"b',
  "quote and space": 'a "b" c',
  NBSP: "a b",
  "NEL is not whitespace": "a\u0085b",
  emoji: "😀.md",
  empty: "",
});

export const parseMentionsCases = cases(parseMentions, {
  // mentions.test.ts
  "unquoted and quoted, once each": 'Read @src/a.ts and @"docs/My Notes.md", then @src/a.ts again',
  "sentence punctuation dropped": "Look at @README.md. Also (@lib/x.ts), ok?",
  "email and lone @": "mail mark@example.com @ now",
  // more
  empty: "",
  "only punctuation after @": "@.,;",
  "trailing quote run": "see @a.ts'\"",
  "quoted path is trimmed": '@"  spaced  "',
  "quoted whitespace only": '@"   "',
  "quoted across a newline does not match": '@"a\nb"',
  "unclosed quote": '@"open ended',
  "unquoted stops at a quote": '@a"b"',
  "mention containing an @": "x @a@b",
  "email swallows a following @": "a@b @c",
  "after brackets and quotes": "(@a) [@b] {@c} '@d' `@e` \"@f\"",
  "after NBSP": " @a",
  "after NEL is not a boundary": "\u0085@a",
  "dots inside are kept": "@a.b.c.",
  "inner closing bracket kept": "@a)b.ts)",
  "emoji path": "@😀/a.ts and @é.md!",
  "trailing NBSP is part of the word": "@a ",
  "duplicate after punctuation strip": "@a.ts @a.ts.",
  "CRLF ends a mention": "@a.ts\r\n@b.ts",
  "quoted then unquoted adjacency": '@"a b"@c',
});

type RankInput = { paths: string[]; query: string; limit?: number; demotePrefix?: string };

export const rankPathsCases = cases(
  ({ paths, query, limit, demotePrefix }: RankInput) =>
    rankPaths(paths, query, limit, demotePrefix === undefined ? {} : { demote: (p) => p.startsWith(demotePrefix) }),
  (() => {
    const paths = ["src/", "src/app.ts", "src/lib/", "src/lib/format.ts", "app/", "app/main.ts", "README.md", "docs/formatting.md", "test/fmt.ts"];
    return {
      // mentions.test.ts
      "path prefix src/l": { paths, query: "src/l" },
      "path prefix app": { paths, query: "app" },
      "name prefix form": { paths, query: "form" },
      "folder prefix lib": { paths, query: "lib" },
      "substring mat": { paths, query: "mat" },
      "demoted app/": { paths, query: "app", demotePrefix: "app/" },
      "demoted dist/ behind its rank": { paths: ["dist/fmt.ts", "src/fmt.ts", "x/fmtr/a.ts"], query: "fmt", demotePrefix: "dist/" },
      "demoted real match beats loose": { paths: ["dist/fmt.ts", "f/m/t.ts"], query: "fmt", demotePrefix: "dist/" },
      "fmt matches outright": { paths, query: "fmt" },
      "loose frmt": { paths, query: "frmt" },
      "completed folder lists its contents": { paths, query: "src/" },
      "file typed in full first": { paths: [".envrc", ".env"], query: ".env" },
      "README.md in full": { paths, query: "README.md" },
      "case-insensitive": { paths, query: "readme" },
      "no match": { paths, query: "zzz" },
      "empty query lists the top level": { paths, query: "" },
      "limit 2": { paths, query: "s", limit: 2 },
      // more
      "limit 0": { paths, query: "s", limit: 0 },
      "negative limit slices from the end": { paths, query: "s", limit: -1 },
      "upper-case query": { paths, query: "SRC/L" },
      "empty paths": { paths: [], query: "a" },
      "empty query demoted top level": { paths, query: "", demotePrefix: "app" },
      "ties by length then code units": { paths: ["b/a.ts", "a/a.ts", "B/a.ts", "a.ts"], query: "a" },
      "upper-case sorts before lower-case by code unit": { paths: ["Zed", "apple", "Zap"], query: "" },
      "astral sorts after BMP private use by code unit": { paths: ["\u{1F600}", "～", ""], query: "" },
      "length counts UTF-16": { paths: ["x/😀.ts", "x/abcd.ts"], query: "x/" },
      "unicode case folding": { paths: ["Über/a.ts", "über.md"], query: "ü" },
      "final sigma lower-cases to ς": { paths: ["ΟΔΟΣ", "ΟΔΟΣ/x"], query: "οδος" },
      "medial sigma lower-cases to σ": { paths: ["ΣΑ"], query: "σα" },
      "dotted capital I lower-cases to two units": { paths: ["İx"], query: "i̇x" },
      "loose match walks code points": { paths: ["a😀b"], query: "ab" },
      "loose match never matches an astral query char": { paths: ["a😀xb"], query: "a😀b" },
      "astral substring still matches": { paths: ["x😀y"], query: "😀" },
      "folder exact match only skipped with a slash": { paths: ["src", "src/"], query: "src" },
      "trailing slash name segment": { paths: ["a/lib/", "lib-x/"], query: "lib" },
      "top level directory with trailing slash only": { paths: ["a/", "a/b/", "c"], query: "" },
      "combining mark path is not composed": { paths: ["café.md", "café.md"], query: "café" },
      "duplicate paths both kept": { paths: ["a.ts", "a.ts"], query: "a" },
    } satisfies Record<string, RankInput>;
  })(),
);
