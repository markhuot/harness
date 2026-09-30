// A code block with syntax colors from the app theme's Shiki theme (lib/highlight): it renders plain
// monospace at once and swaps in the colored tokens when they're ready. Diffs (a `diff`/`patch`
// fence, or an untagged block that reads as one) get the Git tab's added/removed line tints, with
// each file's code colored by its path. Wide code scrolls sideways.

import { useEffect, useReducer, useRef } from "react";
import { ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import { codeKind, codeLanguage } from "@harness/shared/state";
import { PIERRE_DEFAULT, syntaxThemeName } from "@harness/shared/themes";
import { useTheme } from "../state/app";
import { MONO } from "../theme/tokens";
import { cachedHighlight, diffTints, gitColors, hasSyntaxTheme, highlightCached, plainLines, reuseLines, type HighlightedLine, type Span } from "../lib/highlight";

export interface CodeBlockProps {
  code: string;
  /** The fence's language tag as written ("ts", "yml", "diff"…); null or empty for none */
  lang?: string | null;
  showLineNumbers?: boolean;
  /** 1-based, inclusive line range to tint (a file viewer's selected lines) */
  highlightLines?: [start: number, end: number];
}

const FONT = 12.5;
const LINE = 18;
const PAD = 10;

export function spanStyle(s: Span, fallback: string): TextStyle {
  const f = s.fontStyle ?? 0;
  return {
    color: s.color ?? fallback,
    fontStyle: f & 1 ? "italic" : undefined,
    fontWeight: f & 2 ? "700" : undefined,
    textDecorationLine: f & 4 ? "underline" : undefined,
  };
}

/** The app theme's Shiki theme, as on the desktop and in the Git tab; Pierre's when it isn't bundled. */
export function useSyntaxTheme(): string {
  const { resolved, theme } = useTheme();
  const named = syntaxThemeName(resolved, theme.syntaxTheme);
  return hasSyntaxTheme(named) ? named : PIERRE_DEFAULT[resolved];
}

/** Re-renders once the highlight for these inputs lands in the cache. */
export function useHighlight(code: string, lang: string | null, theme: string, diff: boolean, appearance: "light" | "dark") {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const hit = cachedHighlight(code, lang, theme, diff);
  const pending = hit === undefined;
  useEffect(() => {
    if (!pending) return;
    let live = true;
    void highlightCached(code, lang, theme, { diff, appearance }).then(() => live && bump());
    return () => {
      live = false;
    };
  }, [code, lang, theme, diff, appearance, pending]);
  return hit;
}

export function CodeBlock({ code, lang, showLineNumbers, highlightLines }: CodeBlockProps) {
  const { resolved, c } = useTheme();
  const shikiLang = codeLanguage(lang ?? "");
  const diff = codeKind(lang ?? "", code) === "diff";
  const syntaxTheme = useSyntaxTheme();
  const hl = useHighlight(code, shikiLang, syntaxTheme, diff, resolved);

  // The last colored lines, reused line by line while a changed block re-highlights.
  const last = useRef<{ theme: string; lines: HighlightedLine[] } | null>(null);
  if (hl) last.current = { theme: syntaxTheme, lines: hl.lines };
  const lines = hl?.lines ?? reuseLines(plainLines(code, diff), last.current?.theme === syntaxTheme ? last.current.lines : null);
  const fg = hl?.fg ?? c.text;
  const text: TextStyle = { fontFamily: MONO, fontSize: FONT, lineHeight: LINE, color: fg };

  const rowed = diff || showLineNumbers || highlightLines;
  if (!rowed) {
    // One <Text>, so iOS's Copy takes the whole block.
    return (
      <ScrollView horizontal style={[styles.box, { backgroundColor: c.bgSunken, borderColor: c.border }]} contentContainerStyle={{ padding: PAD }}>
        <Text style={text} selectable>
          {lines.map((l, i) => (
            <Text key={i}>
              {l.spans.map((s, j) => (
                <Text key={j} style={spanStyle(s, fg)}>
                  {s.text}
                </Text>
              ))}
              {i < lines.length - 1 ? "\n" : null}
            </Text>
          ))}
        </Text>
      </ScrollView>
    );
  }

  const git = hl ?? gitColors(undefined, resolved);
  const tints = diffTints(c.bgSunken, git, resolved);
  const signColor = { add: git.added, del: git.deleted };
  const rowBg = (l: HighlightedLine, i: number) => {
    if (highlightLines && i + 1 >= highlightLines[0] && i + 1 <= highlightLines[1]) return c.accentSoft;
    return l.kind === "add" ? tints.add : l.kind === "del" ? tints.del : undefined;
  };
  const gutterWidth = Math.ceil(String(lines.length).length * FONT * 0.62) + 12;
  return (
    <View style={[styles.box, styles.rowed, { backgroundColor: c.bgSunken, borderColor: c.border }]}>
      {showLineNumbers ? (
        <View style={{ paddingVertical: PAD }}>
          {lines.map((l, i) => (
            <Text key={i} style={[text, { width: gutterWidth, paddingRight: 8, textAlign: "right", color: c.text3, backgroundColor: rowBg(l, i) }]}>
              {i + 1}
            </Text>
          ))}
        </View>
      ) : null}
      <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ minWidth: "100%", paddingVertical: PAD }}>
        <View style={{ flexGrow: 1 }}>
          {lines.map((l, i) => {
            const meta = l.kind === "hunk" || l.kind === "meta";
            return (
              <Text key={i} style={[text, { paddingHorizontal: PAD, backgroundColor: rowBg(l, i) }, meta && { color: c.text3 }]} selectable>
                {l.spans.map((s, j) => (
                  <Text key={j} style={j === 0 && (l.kind === "add" || l.kind === "del") ? { color: signColor[l.kind] } : meta ? undefined : spanStyle(s, fg)}>
                    {s.text}
                  </Text>
                ))}
                {/* An empty line still takes up its line. */}
                {l.spans.every((s) => !s.text) ? " " : null}
              </Text>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  rowed: { flexDirection: "row", overflow: "hidden" },
});
