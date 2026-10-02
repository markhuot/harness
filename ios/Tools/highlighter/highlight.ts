// Syntax highlighting for code blocks: Shiki's core with its JavaScript regex engine (JavaScriptCore
// in the app gets no WASM for Oniguruma), so tokens come out as plain data SwiftUI turns into spans.
// Grammars and themes are separate modules imported on first use: the bundle carries them, but
// none is evaluated until a block in that language or theme shows up.
//
// Bundled languages (plus what they embed, e.g. PHP brings HTML, CSS, JS, SQL; Ruby's heredocs
// bring C, C++, Lua, GLSL, HAML): typescript tsx javascript jsx json jsonc shellscript shellsession
// yaml toml ini dotenv php blade ruby python go rust swift kotlin java c cpp csharp css scss html
// xml markdown sql graphql docker makefile diff. Anything else renders as plain monospace text.
//
// Bundled themes: every `syntaxTheme` a Harness theme names (themes.test.ts-style check in
// highlight.test.ts), with Pierre's from @pierre/theme so colors match the Git tab exactly.

import { createHighlighterCore, type HighlighterCore, type LanguageInput, type ThemeInput, type ThemeRegistration, type ThemedToken } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { mix, type ThemeAppearance } from "@harness/shared/themes";
import { langForPath, parseDiff, type DiffLineKind } from "@harness/shared/diff";

const LANGS: Record<string, LanguageInput> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  shellsession: () => import("@shikijs/langs/shellsession"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  php: () => import("@shikijs/langs/php"),
  blade: () => import("@shikijs/langs/blade"),
  ruby: () => import("@shikijs/langs/ruby"),
  python: () => import("@shikijs/langs/python"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  markdown: () => import("@shikijs/langs/markdown"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  docker: () => import("@shikijs/langs/docker"),
  makefile: () => import("@shikijs/langs/makefile"),
  diff: () => import("@shikijs/langs/diff"),
};

/** Shiki registers some grammars under a different name than the id we look them up by. */
const LANG_NAMES: Record<string, string> = { makefile: "make" };

const THEMES: Record<string, ThemeInput> = {
  // Pierre's package types its themes loosely; they're complete Shiki themes (@pierre/diffs loads them as such).
  "pierre-light": () => import("@pierre/theme/pierre-light").then((m) => m.default as unknown as ThemeRegistration),
  "pierre-dark": () => import("@pierre/theme/pierre-dark").then((m) => m.default as unknown as ThemeRegistration),
  "one-light": () => import("@shikijs/themes/one-light"),
  "one-dark-pro": () => import("@shikijs/themes/one-dark-pro"),
  "catppuccin-latte": () => import("@shikijs/themes/catppuccin-latte"),
  "catppuccin-frappe": () => import("@shikijs/themes/catppuccin-frappe"),
  "catppuccin-macchiato": () => import("@shikijs/themes/catppuccin-macchiato"),
  "catppuccin-mocha": () => import("@shikijs/themes/catppuccin-mocha"),
  "solarized-light": () => import("@shikijs/themes/solarized-light"),
  "solarized-dark": () => import("@shikijs/themes/solarized-dark"),
  "github-light-default": () => import("@shikijs/themes/github-light-default"),
  "github-dark-default": () => import("@shikijs/themes/github-dark-default"),
  dracula: () => import("@shikijs/themes/dracula"),
  nord: () => import("@shikijs/themes/nord"),
  "gruvbox-light-medium": () => import("@shikijs/themes/gruvbox-light-medium"),
  "gruvbox-dark-medium": () => import("@shikijs/themes/gruvbox-dark-medium"),
  "tokyo-night": () => import("@shikijs/themes/tokyo-night"),
  "rose-pine": () => import("@shikijs/themes/rose-pine"),
  "rose-pine-dawn": () => import("@shikijs/themes/rose-pine-dawn"),
};

/** Every bundled language and theme id, for the native app's JavaScriptCore bundle (ios/Tools/build-highlighter.ts). */
export const LANGUAGE_IDS = Object.keys(LANGS);
export const SYNTAX_THEME_IDS = Object.keys(THEMES);

export const hasLanguage = (lang: string) => lang in LANGS;
export const hasSyntaxTheme = (name: string) => name in THEMES;

/** Tokenizing runs on the JS thread; past this a block stays plain rather than stall scrolling. */
export const MAX_HIGHLIGHT_CHARS = 60_000;
/**
 * Per-line tokenizing budget. Shiki's default (500 ms) cuts off the first line of a new language,
 * where the JS engine compiles the grammar's regexes lazily, on a busy phone; the rest of that line
 * then stays plain, and the cached result with it. The limit only guards against runaway patterns.
 */
const TOKENIZE_MS = 5000;

/** One colored run of text. fontStyle is Shiki's bit set: 1 italic, 2 bold, 4 underline. */
export interface Span {
  text: string;
  color?: string;
  fontStyle?: number;
}

export interface HighlightedLine {
  spans: Span[];
  /** Set for diffs: what the line is, for its background and sign color */
  kind?: DiffLineKind;
}

export interface Highlighted {
  lines: HighlightedLine[];
  /** The theme's default text color */
  fg: string;
  /** Git colors from the theme, for diff line tints (see diffTints) */
  added: string;
  deleted: string;
}

let core: Promise<HighlighterCore> | null = null;
const highlighter = () =>
  // ES2018 target: Hermes has lookbehind, named groups, \p{…} and the d flag, but no v flag.
  (core ??= createHighlighterCore({ engine: createJavaScriptRegexEngine({ target: "ES2018", forgiving: true }) }));

const loading = new Map<string, Promise<void>>();
function ensure(key: string, load: () => Promise<void>) {
  let p = loading.get(key);
  if (!p) {
    p = load().catch((e) => {
      loading.delete(key);
      throw e;
    });
    loading.set(key, p);
  }
  return p;
}

/** Pierre's defaults (@pierre/diffs --diffs-added-*, --diffs-deleted-*) for themes without git colors. */
const GIT_DEFAULTS: Record<ThemeAppearance, { added: string; deleted: string }> = {
  light: { added: "#0dbe4e", deleted: "#ff6762" },
  dark: { added: "#5ecc71", deleted: "#ff6762" },
};

/**
 * The git colors a Shiki theme declares, picked the way @pierre/diffs picks them for the Git tab:
 * gitDecoration colors, then the terminal's green/red, then Pierre's defaults.
 */
export function gitColors(colors: Record<string, string> | undefined, appearance: ThemeAppearance): { added: string; deleted: string } {
  return {
    added: colors?.["gitDecoration.addedResourceForeground"] ?? colors?.["terminal.ansiGreen"] ?? GIT_DEFAULTS[appearance].added,
    deleted: colors?.["gitDecoration.deletedResourceForeground"] ?? colors?.["terminal.ansiRed"] ?? GIT_DEFAULTS[appearance].deleted,
  };
}

/**
 * Line backgrounds for a diff on `bg`, mixed like @pierre/diffs' --diffs-bg-addition/deletion:
 * 12% of the git color in light themes, 20% in dark ones.
 */
export function diffTints(bg: string, git: { added: string; deleted: string }, appearance: ThemeAppearance): { add: string; del: string } {
  const amount = appearance === "dark" ? 0.2 : 0.12;
  return { add: mix(bg, git.added, amount), del: mix(bg, git.deleted, amount) };
}

const spansOf = (line: ThemedToken[]): Span[] => line.map((t) => ({ text: t.content, color: t.color, fontStyle: t.fontStyle || undefined }));

/**
 * The lines of a diff with their kinds and, where a file's language is known (from its `+++` path
 * or `fallbackLang`), syntax colors. Each file's old side (context and removed lines) and new side
 * (context and added lines) are tokenized as whole files, the way the Git tab does, so a string or
 * comment spanning lines colors correctly; each line then takes its tokens from its own side.
 */
export function diffLines(
  code: string,
  tokenize: (code: string, lang: string) => Span[][] | null,
  fallbackLang: string | null,
): HighlightedLine[] {
  const { lines, files } = parseDiff(code);
  // Code lines keep their sign as a span of its own (the UI colors it); headers stay whole.
  const out: HighlightedLine[] = lines.map((l) =>
    l.kind === "add" || l.kind === "del" || l.kind === "ctx" ? { kind: l.kind, spans: [{ text: l.text.slice(0, 1) }, { text: l.text.slice(1) }] } : { kind: l.kind, spans: [{ text: l.text }] },
  );
  files.forEach((f, fi) => {
    const lang = (f.path && langForPath(f.path)) || fallbackLang;
    if (!lang) return;
    for (const side of ["old", "new"] as const) {
      const idx = lines.flatMap((l, i) => (l.file === fi && (l.kind === "ctx" || l.kind === (side === "old" ? "del" : "add")) ? [i] : []));
      if (!idx.length) continue;
      const tokens = tokenize(idx.map((i) => lines[i]!.text.slice(1)).join("\n"), lang);
      if (!tokens) continue;
      idx.forEach((i, j) => {
        const l = lines[i]!;
        // Context lines are on both sides; take them from the new one.
        if (l.kind === "ctx" && side === "old") return;
        out[i] = { kind: l.kind, spans: [{ text: l.text.slice(0, 1) }, ...(tokens[j] ?? [])] };
      });
    }
  });
  return out;
}

async function load(lang: string | null, theme: string) {
  const hl = await highlighter();
  await ensure(`theme:${theme}`, () => hl.loadTheme(THEMES[theme]!));
  if (lang) await ensure(`lang:${lang}`, () => hl.loadLanguage(LANGS[lang]!));
  return hl;
}

/**
 * Highlight `code` as `lang` (a Shiki id, see codeLanguage) or, with `diff`, as a unified diff whose
 * files are colored by their paths. Resolves null when there's nothing to color it with: an
 * unbundled language, or a block past MAX_HIGHLIGHT_CHARS.
 */
export async function highlight(code: string, lang: string | null, theme: string, opts: { diff: boolean; appearance: ThemeAppearance }): Promise<Highlighted | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS || !hasSyntaxTheme(theme)) return null;
  const inner = lang && lang !== "diff" && hasLanguage(lang) ? lang : null;
  if (!opts.diff && !inner) return null;
  let hl = await load(inner, theme);
  const t = hl.getTheme(theme);
  const git = gitColors(t.colors, opts.appearance);
  const base = { fg: t.fg, ...git };
  if (!opts.diff) {
    const { tokens } = hl.codeToTokens(code, { lang: LANG_NAMES[inner!] ?? inner!, theme, tokenizeTimeLimit: TOKENIZE_MS });
    return { ...base, lines: tokens.map((l) => ({ spans: spansOf(l) })) };
  }
  // A diff's files can be in any language; load the bundled ones its paths name first.
  const langs = new Set(parseDiff(code).files.map((f) => (f.path ? langForPath(f.path) : null)).filter((l): l is string => !!l && hasLanguage(l)));
  for (const l of langs) hl = await load(l, theme);
  const tokenize = (src: string, l: string) => {
    if (!hasLanguage(l)) return null;
    return hl.codeToTokens(src, { lang: LANG_NAMES[l] ?? l, theme, tokenizeTimeLimit: TOKENIZE_MS }).tokens.map(spansOf);
  };
  return { ...base, lines: diffLines(code, tokenize, inner) };
}

/** A block's lines before (or without) highlighting: one uncolored span each, diff kinds included. */
export function plainLines(code: string, diff: boolean): HighlightedLine[] {
  if (diff) return diffLines(code, () => null, null);
  return code.split("\n").map((text) => ({ spans: [{ text }] }));
}

const lineText = (l: HighlightedLine) => l.spans.map((s) => s.text).join("");

/**
 * While a changed block (a message still streaming in) is re-highlighted, keep the colors of
 * every line whose text and kind didn't change, instead of flashing the whole block plain.
 */
export function reuseLines(plain: HighlightedLine[], prev: HighlightedLine[] | null | undefined): HighlightedLine[] {
  if (!prev) return plain;
  return plain.map((l, i) => {
    const p = prev[i];
    return p && p.kind === l.kind && lineText(p) === lineText(l) ? p : l;
  });
}

// One highlight at a time, with a macrotask between them: a transcript full of code blocks
// tokenizes block by block instead of holding the JS thread for all of them at once.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(() => new Promise((r) => setTimeout(r, 0))).then(job);
  queue = run.catch(() => {});
  return run;
}

const CACHE_SIZE = 200;
const cache = new Map<string, Highlighted | null>();
const inflight = new Map<string, Promise<Highlighted | null>>();
const cacheKey = (code: string, lang: string | null, theme: string, diff: boolean) => `${theme}\u0000${diff ? "diff:" : ""}${lang ?? ""}\u0000${code}`;

/** A finished highlight for these inputs, if one is cached (undefined when it isn't, yet). */
export function cachedHighlight(code: string, lang: string | null, theme: string, diff: boolean): Highlighted | null | undefined {
  const key = cacheKey(code, lang, theme, diff);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Least recently used goes first: re-inserting moves a hit to the back.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/** highlight(), memoized per (code, lang, theme, diff) in a small LRU. Failures resolve null. */
export async function highlightCached(code: string, lang: string | null, theme: string, opts: { diff: boolean; appearance: ThemeAppearance }): Promise<Highlighted | null> {
  const hit = cachedHighlight(code, lang, theme, opts.diff);
  if (hit !== undefined) return hit;
  const key = cacheKey(code, lang, theme, opts.diff);
  let p = inflight.get(key);
  if (!p) {
    p = serial(() => highlight(code, lang, theme, opts))
      .catch(() => null)
      .then((result) => {
        inflight.delete(key);
        cache.set(key, result);
        while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
        return result;
      });
    inflight.set(key, p);
  }
  return p;
}
