// The JavaScriptCore side of the native app's syntax highlighter (HarnessHighlight/Highlighter.swift).
// It wraps highlight.ts: Shiki core, its JS regex engine, and the languages and themes, so code is
// colored as on the desktop and in the Git tab.
// build-highlighter.ts bundles this file into one script that defines `HarnessHighlighter`.
//
// A plain JSContext has no Web APIs. Shiki only needs Date.now (vscode-textmate's time limit),
// which JSC has, and oniguruma-to-es reaches for TextEncoder/TextDecoder on one path, so those get
// small UTF-8 shims below when missing.

import "./polyfills";
import { highlight, LANGUAGE_IDS, MAX_HIGHLIGHT_CHARS, SYNTAX_THEME_IDS } from "./highlight";
import { wellFormed } from "./wellFormed";

type Appearance = "light" | "dark";

/**
 * The global API. Swift calls `highlight` with a completion callback; the work resolves on
 * microtasks, which JSC drains before the call returns, so the callback has run by then.
 */
const api = {
  languages: LANGUAGE_IDS,
  themes: SYNTAX_THEME_IDS,
  maxChars: MAX_HIGHLIGHT_CHARS,
  /** done(json, error): json is a Highlighted, or "null" when there's nothing to color it with. */
  highlight(code: string, lang: string | null, theme: string, diff: boolean, appearance: Appearance, done: (json: string | null, error: string | null) => void) {
    highlight(code, lang, theme, { diff, appearance }).then(
      (r) => done(JSON.stringify(wellFormed(r)), null),
      (e: unknown) => done(null, e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
    );
  },
};

(globalThis as unknown as { HarnessHighlighter: typeof api }).HarnessHighlighter = api;
