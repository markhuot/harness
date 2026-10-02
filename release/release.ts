// Release tags and CHANGELOG.md. A release of the Mac and iPhone apps is an annotated git tag
// app-YYYYMMDD.HHMM (the UTC minute the release was prepared) with a matching CHANGELOG.md
// section; publish-install.sh builds only a commit that carries such a tag. See CLAUDE.md → Releases.
//
//   bun release/release.ts prepare [--at <ISO time>]   move [Unreleased] into a new release section, print the tag
//   bun release/release.ts check <tag>                 validate the tag and its section, print the build number
//   bun release/release.ts notes <tag>                 print the tag's CHANGELOG section body
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const REPO = "markhuot/harness";
const TAG_RE = /^app-(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})$/;
const HEADING_RE = /^## \[([^\]]+)\]/;

/** The tag's UTC time and the iOS build number (CFBundleVersion) derived from it: YYYYMMDDHHMM. */
export function parseTag(tag: string): { at: Date; buildNumber: string } {
  const m = TAG_RE.exec(tag);
  if (!m) throw new Error(`"${tag}" is not a release tag (expected app-YYYYMMDD.HHMM)`);
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi));
  // Date.UTC rolls 2026-02-30 over to March; a round trip catches impossible dates and times.
  if (tagFor(at) !== tag) throw new Error(`"${tag}" is not a real UTC date and time`);
  return { at, buildNumber: tag.slice(4).replace(".", "") };
}

export function tagFor(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `app-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}.${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
}

interface Section { name: string; start: number; end: number } // line indexes: heading, one past the body

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((line, i) => {
    const m = HEADING_RE.exec(line);
    if (!m) return;
    const prev = out.at(-1);
    if (prev) prev.end = i;
    out.push({ name: m[1]!, start: i, end: lines.length });
  });
  return out;
}

const body = (lines: string[], s: Section) => lines.slice(s.start + 1, s.end).join("\n").trim();

/** Moves the [Unreleased] entries into a new section for `tag`, leaving [Unreleased] empty. */
export function prepare(changelog: string, tag: string): string {
  const { at } = parseTag(tag);
  const lines = changelog.split("\n");
  const all = sections(lines);
  const unreleased = all.find((s) => s.name === "Unreleased");
  if (!unreleased) throw new Error("CHANGELOG.md has no ## [Unreleased] section");
  if (all.some((s) => s.name === tag)) throw new Error(`CHANGELOG.md already has a section for ${tag}`);
  const latest = all.find((s) => s.name !== "Unreleased");
  if (latest && TAG_RE.test(latest.name) && latest.name >= tag) {
    throw new Error(`${tag} is not newer than the latest release ${latest.name}`);
  }
  const entries = body(lines, unreleased);
  if (!entries) throw new Error("[Unreleased] is empty; there is nothing to release");
  const heading = `## [${tag}](https://github.com/${REPO}/releases/tag/${tag}) - ${at.toISOString().slice(0, 10)}`;
  return [
    ...lines.slice(0, unreleased.start + 1),
    "",
    heading,
    "",
    entries,
    "",
    ...lines.slice(unreleased.end),
  ].join("\n");
}

/** The body of `tag`'s section. Throws unless the section exists, has entries, is the newest
 *  release and [Unreleased] is empty (so nothing merged before the tag is left out of its notes). */
export function notes(changelog: string, tag: string): string {
  parseTag(tag);
  const lines = changelog.split("\n");
  const all = sections(lines);
  const section = all.find((s) => s.name === tag);
  if (!section) throw new Error(`CHANGELOG.md has no section for ${tag}; run \`bun run release:prepare\` first`);
  const unreleased = all.find((s) => s.name === "Unreleased");
  if (unreleased && body(lines, unreleased)) throw new Error(`[Unreleased] still has entries; they belong in ${tag}`);
  const latest = all.find((s) => s.name !== "Unreleased");
  if (latest !== section) throw new Error(`${tag} is not the newest release in CHANGELOG.md (${latest?.name} is)`);
  const text = body(lines, section);
  if (!text) throw new Error(`the ${tag} section in CHANGELOG.md is empty`);
  return text;
}

if (import.meta.main) {
  const path = join(resolve(import.meta.dir, ".."), "CHANGELOG.md");
  const [cmd, arg, value] = process.argv.slice(2);
  try {
    const changelog = readFileSync(path, "utf8");
    if (cmd === "prepare") {
      const at = arg === "--at" && value ? new Date(value) : new Date();
      const tag = tagFor(at);
      writeFileSync(path, prepare(changelog, tag));
      console.log(tag);
    } else if (cmd === "check" && arg) {
      notes(changelog, arg);
      console.log(parseTag(arg).buildNumber);
    } else if (cmd === "notes" && arg) {
      console.log(notes(changelog, arg));
    } else {
      console.error("usage: release.ts prepare [--at <ISO time>] | check <tag> | notes <tag>");
      process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
