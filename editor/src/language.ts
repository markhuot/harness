// Which Shiki language a file is highlighted in: the same mapping the Changes tab uses
// (@harness/shared langForPath / codeLanguage), so a file reads the same in both places.

import { langForPath } from "@harness/shared/diff";

export const PLAIN = "text";

/**
 * The grammars the iOS bundle carries (an IIFE can't split code, so every grammar is listed up front
 * and the rest of Shiki's are left out; a file in another language shows as plain text there). The
 * iOS build reads this list, and the page passes it to resolveLanguage. The Mac loads any grammar on demand.
 */
export const BUNDLED_LANGUAGES: readonly string[] = [
  "typescript", "tsx", "javascript", "jsx", "json", "jsonc", "shellscript", "shellsession", "yaml", "toml", "ini",
  "dotenv", "php", "blade", "ruby", "python", "go", "rust", "swift", "kotlin", "java", "c", "cpp", "csharp", "css",
  "scss", "less", "html", "xml", "markdown", "sql", "graphql", "docker", "makefile", "diff", "hcl", "terraform",
  "lua", "dart", "scala",
];

/**
 * The Shiki language for what a caller passes: a file path or name ("app/main.tf", "Dockerfile"), an
 * extension or fence name ("ts"), or a language name ("typescript"). `supported` narrows it to a set
 * (iOS); text when the language is unknown or outside it.
 */
export function resolveLanguage(language: string | undefined, supported?: ReadonlySet<string>): string {
  if (!language) return PLAIN;
  const name = langForPath(language) ?? langForPath(`x.${language}`);
  if (!name || name === PLAIN) return PLAIN;
  return supported && !supported.has(name) ? PLAIN : name;
}
