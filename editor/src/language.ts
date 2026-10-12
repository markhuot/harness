// Picks a CodeMirror language from a file name. Lezer languages where one ships, legacy stream modes
// for the rest; an unknown extension gets plain text (no language, no highlighting).

import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { yaml } from "@codemirror/lang-yaml";
import { php } from "@codemirror/lang-php";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { c, cpp, java, kotlin } from "@codemirror/legacy-modes/mode/clike";

export const PLAIN = "plain";

const stream = (mode: Parameters<typeof StreamLanguage.define>[0]) => () => StreamLanguage.define(mode);

const LANGUAGES: Record<string, () => Extension> = {
  javascript: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  markdown: () => markdown(),
  python: () => python(),
  rust: () => rust(),
  go: () => go(),
  yaml: () => yaml(),
  php: () => php(),
  xml: () => xml(),
  sql: () => sql(),
  swift: stream(swift),
  shell: stream(shell),
  ruby: stream(ruby),
  toml: stream(toml),
  c: stream(c),
  cpp: stream(cpp),
  java: stream(java),
  kotlin: stream(kotlin),
};

const BY_EXTENSION: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json", css: "css", html: "html", htm: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  py: "python", rs: "rust", go: "go", swift: "swift",
  yaml: "yaml", yml: "yaml", php: "php", xml: "xml", svg: "xml", plist: "xml",
  sql: "sql", sh: "shell", bash: "shell", zsh: "shell", rb: "ruby", toml: "toml",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", java: "java", kt: "kotlin",
};

const BY_NAME: Record<string, string> = {
  ".zshrc": "shell", ".bashrc": "shell", ".bash_profile": "shell", ".zprofile": "shell",
  Gemfile: "ruby", Rakefile: "ruby",
};

/** The language name for a path or file name ("plain" when unknown). `language` may also be a name already. */
export function languageName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  if (BY_NAME[base]) return BY_NAME[base];
  const dot = base.lastIndexOf(".");
  if (dot < 0) return LANGUAGES[base] ? base : PLAIN;
  return BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? PLAIN;
}

/** The CodeMirror extension for a language name, or none for plain text. */
export function languageExtension(name: string): Extension {
  return LANGUAGES[name]?.() ?? [];
}

/** `language` as callers pass it: a file name/extension ("a.ts", "ts") or a language name ("typescript"). */
export function resolveLanguage(language: string | undefined): string {
  if (!language) return PLAIN;
  if (LANGUAGES[language]) return language;
  return languageName(language.includes(".") ? language : `x.${language}`);
}
