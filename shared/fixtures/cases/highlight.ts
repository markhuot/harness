// Syntax highlighting (mobile/src/lib/highlight.ts) for the native app's HarnessHighlight target.
// `highlightCases` is the RN app's real highlight() over ios/Tools/highlighter/corpus.ts, and
// HighlighterTests checks that the JavaScriptCore bundle (ios/Tools/build-highlighter.ts) returns
// the same tokens and colors. It runs in a child bun with JavaScriptCore's regex JIT off, as an iOS
// app's JSContext runs (see ios/Tools/highlighter/runCorpus.ts). Highlight outputs go through
// wellFormed() exactly as the bundle's do. The pure helpers (gitColors, diffTints, plainLines,
// reuseLines) are ported to Swift and checked against their TS outputs here.

import { resolve } from "node:path";
import { diffTints, gitColors, LANGUAGE_IDS, MAX_HIGHLIGHT_CHARS, plainLines, reuseLines, SYNTAX_THEME_IDS, type HighlightedLine } from "../../../mobile/src/lib/highlight";
import { BARE_DIFF, CRLF_DIFF, EMOJI_DIFF, MULTI_DIFF, RB_DIFF } from "../../../ios/Tools/highlighter/corpus";
import { wellFormedLines } from "../../../ios/Tools/highlighter/wellFormed";
import type { ThemeAppearance } from "../../src/themes";
import { cases } from "../case";

export const languages = LANGUAGE_IDS;
export const syntaxThemes = SYNTAX_THEME_IDS;
export const maxChars = MAX_HIGHLIGHT_CHARS;

function runCorpus(): unknown {
  const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../../ios/Tools/highlighter/runCorpus.ts")], {
    env: { ...process.env, BUN_JSC_useRegExpJIT: "false" },
    stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`runCorpus failed (exit ${child.exitCode}, signal ${child.signalCode}): ${child.stderr.toString()} ${child.stdout.toString().slice(0, 300)}`);
  return JSON.parse(child.stdout.toString());
}

export const highlightCases = runCorpus();

type Colors = Record<string, string> | null;
export const gitColorsCases = cases(
  ({ colors, appearance }: { colors: Colors; appearance: ThemeAppearance }) => gitColors(colors ?? undefined, appearance),
  {
    "gitDecoration wins": { colors: { "gitDecoration.addedResourceForeground": "#00ff00", "gitDecoration.deletedResourceForeground": "#ff00ff", "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#ff0000" }, appearance: "light" },
    "mixed sources": { colors: { "gitDecoration.addedResourceForeground": "#00ff00", "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#ff0000" }, appearance: "light" },
    "terminal colors": { colors: { "terminal.ansiGreen": "#111111", "terminal.ansiRed": "#222222" }, appearance: "dark" },
    "no colors, light": { colors: null, appearance: "light" },
    "no colors, dark": { colors: null, appearance: "dark" },
    "empty colors, dark": { colors: {}, appearance: "dark" },
  },
);

export const diffTintsCases = cases(
  ({ bg, added, deleted, appearance }: { bg: string; added: string; deleted: string; appearance: ThemeAppearance }) => diffTints(bg, { added, deleted }, appearance),
  {
    "black, light": { bg: "#000000", added: "#00ff00", deleted: "#ff0000", appearance: "light" },
    "black, dark": { bg: "#000000", added: "#00ff00", deleted: "#ff0000", appearance: "dark" },
    "pierre light on white": { bg: "#ffffff", added: "#0dbe4e", deleted: "#ff6762", appearance: "light" },
    "pierre dark on a dark sunken bg": { bg: "#141415", added: "#5ecc71", deleted: "#ff6762", appearance: "dark" },
    "short hex and rgb()": { bg: "#fff", added: "rgb(26, 127, 55)", deleted: "#cf222e", appearance: "light" },
    "rounding halves": { bg: "#010203", added: "#fefdfc", deleted: "#808080", appearance: "dark" },
  },
);

const PLAIN_INPUTS: Record<string, { code: string; diff: boolean }> = {
  "code lines": { code: "a\nbc\n\nd", diff: false },
  "code with crlf keeps the \\r": { code: "a\r\nb", diff: false },
  "empty code": { code: "", diff: false },
  "diff kinds and signs": { code: RB_DIFF, diff: true },
  "multi-file git diff": { code: MULTI_DIFF, diff: true },
  "bare diff": { code: BARE_DIFF, diff: true },
  "emoji context line": { code: EMOJI_DIFF, diff: true },
  "crlf diff": { code: CRLF_DIFF, diff: true },
  "dashes inside a hunk are code": { code: "@@ -1,2 +1,2 @@\n--- not a header\n+++ nor this\n ctx", diff: true },
  "hunk without counts": { code: "@@ edits @@\n-a\n+b\n", diff: true },
  "header lines": { code: "new file mode 100644\nBinary files a/x and b/x differ\nsimilarity index 90%\nrename from a\nrename to b", diff: true },
  "empty diff": { code: "", diff: true },
};
export const plainLinesCases = cases(({ code, diff }: { code: string; diff: boolean }) => wellFormedLines(plainLines(code, diff)), PLAIN_INPUTS);

interface ReuseInput {
  plain: HighlightedLine[];
  prev: HighlightedLine[] | null;
}
const colored = (text: string, color: string, kind?: HighlightedLine["kind"]): HighlightedLine => ({ ...(kind ? { kind } : {}), spans: [{ text, color }] });
export const reuseLinesCases = cases(({ plain, prev }: ReuseInput) => reuseLines(plain, prev), {
  "no previous lines": { plain: plainLines("a\nb", false), prev: null },
  "unchanged lines keep their colors, changed and new ones stay plain": { plain: plainLines("a\nbc\nd", false), prev: [colored("a", "#1"), colored("b", "#2")] },
  "text split across spans still matches": { plain: plainLines("ab", false), prev: [{ spans: [{ text: "a", color: "#1" }, { text: "b", color: "#2", fontStyle: 2 }] }] },
  "a kind change isn't reused": { plain: [{ kind: "del", spans: [{ text: "-" }, { text: "x" }] }], prev: [{ kind: "ctx", spans: [{ text: "-" }, { text: "x", color: "#1" }] }] },
  "same kind and text is reused": { plain: [{ kind: "add", spans: [{ text: "+" }, { text: "x" }] }], prev: [{ kind: "add", spans: [{ text: "+" }, { text: "x", color: "#1" }] }] },
  "kindless previous vs a diff line": { plain: [{ kind: "ctx", spans: [{ text: " " }, { text: "x" }] }], prev: [colored(" x", "#1")] },
  "longer previous block": { plain: plainLines("a", false), prev: [colored("a", "#1"), colored("b", "#2")] },
});
