// The editor's look, built from the app's theme tokens as CSS custom properties (CSS_VAR), so
// changing the variables on the page re-themes a live editor without a reload. Where there are no
// page variables (iOS web view), setTheme() writes a token map onto the editor's own element.

import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { CSS_VAR, type ThemeAppearance, type ThemeToken, type ThemeTokens } from "@harness/shared/themes/types";

export type TokenMap = Partial<ThemeTokens>;

/** What a caller passes as the theme: a token map, with the appearance when it isn't "light". */
export interface EditorTheme {
  appearance?: ThemeAppearance;
  tokens?: TokenMap;
}

/** `setTheme` takes an EditorTheme or a bare token map (what iOS receives as `harness:theme`). */
export type ThemeInput = EditorTheme | TokenMap;

export function normalizeTheme(input: ThemeInput | undefined): EditorTheme {
  if (!input) return {};
  if ("tokens" in input || "appearance" in input) return input as EditorTheme;
  return { tokens: input as TokenMap };
}

const v = (token: ThemeToken, fallback: string) => `var(${CSS_VAR[token]}, ${fallback})`;

export function editorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      "&": {
        color: v("text", "#222"),
        backgroundColor: v("bg", "#fff"),
        height: "100%",
        fontSize: "13px",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.55" },
      ".cm-content": { caretColor: v("accent", "#06f") },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: v("accent", "#06f") },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: v("selection", "rgba(0,100,255,.25)"),
      },
      ".cm-gutters": {
        backgroundColor: v("bg", "#fff"),
        color: v("text3", "#888"),
        border: "none",
      },
      ".cm-activeLine": { backgroundColor: v("bgHover", "rgba(0,0,0,.04)") },
      ".cm-activeLineGutter": { backgroundColor: v("bgHover", "rgba(0,0,0,.04)"), color: v("text2", "#555") },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: v("bgActive", "rgba(0,0,0,.1)") },
      ".cm-panels": { backgroundColor: v("bgElev", "#f6f6f6"), color: v("text", "#222") },
      ".cm-tooltip": { backgroundColor: v("bgElev", "#f6f6f6"), border: `1px solid ${v("border", "#ddd")}`, color: v("text", "#222") },
      ".cm-revealed-line": {
        backgroundColor: v("accentSoft", "rgba(0,100,255,.15)"),
        boxShadow: `inset 2px 0 0 ${v("accent", "#06f")}`,
      },
      // Merge view
      ".cm-changedLine": { backgroundColor: v("diffAddSoft", "rgba(0,160,0,.1)") },
      ".cm-deletedChunk": { backgroundColor: v("diffDelSoft", "rgba(220,0,0,.1)") },
      ".cm-insertedLine, .cm-changedText": { backgroundColor: v("diffAddSoft", "rgba(0,160,0,.2)") },
      ".cm-deletedLine, .cm-deletedChunk .cm-changedText": { backgroundColor: v("diffDelSoft", "rgba(220,0,0,.2)") },
    },
    { dark },
  );
}

// Syntax colors come from the same tokens: violet for keywords, green for strings, amber for
// numbers and types, the accent for functions, and the muted text for comments.
export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: v("violet", "#708") },
  { tag: [t.string, t.special(t.string), t.regexp], color: v("green", "#170") },
  { tag: [t.number, t.bool, t.null, t.atom], color: v("amber", "#a50") },
  { tag: [t.typeName, t.className, t.namespace], color: v("amber", "#a50") },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: v("accentText", "#05c") },
  { tag: [t.propertyName, t.attributeName], color: v("accentText", "#05c") },
  { tag: [t.tagName, t.heading], color: v("red", "#c00"), fontWeight: "bold" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v("text3", "#888"), fontStyle: "italic" },
  { tag: [t.operator, t.punctuation, t.bracket, t.meta], color: v("text2", "#555") },
  { tag: [t.link, t.url], color: v("accentText", "#05c"), textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.inserted, color: v("diffAdd", "#0a0") },
  { tag: t.deleted, color: v("diffDel", "#c00") },
  { tag: t.invalid, color: v("red", "#c00") },
]);

export const highlighting = syntaxHighlighting(highlightStyle);

/** Writes a token map onto `el` as CSS custom properties, clearing any it set before that `next` omits. */
export function applyTokens(el: HTMLElement, next: TokenMap | undefined, prev: TokenMap | undefined): void {
  for (const key of Object.keys(prev ?? {}) as ThemeToken[]) {
    if (!next || next[key] === undefined) el.style.removeProperty(CSS_VAR[key]);
  }
  for (const key of Object.keys(next ?? {}) as ThemeToken[]) {
    const value = next?.[key];
    if (value !== undefined && CSS_VAR[key]) el.style.setProperty(CSS_VAR[key], value);
  }
}
