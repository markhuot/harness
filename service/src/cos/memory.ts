// A chief of staff's memory (DESIGN.md "Chief of staff memory"): one markdown document in its ticket's
// agent notes, split into sections by `#` / `##` headings. The "Triage guidance" section is the one the
// triage layer reads, so edits go one section at a time and leave every other byte of the document alone.

import { createHash } from "node:crypto";

export const TRIAGE_GUIDANCE = "Triage guidance";
export const MEMORY_MAX_CHARS = 16_000;
export const GUIDANCE_MAX_CHARS = 4_000;

/** A section heading: level 1 or 2. Deeper headings belong to the section above them. */
const HEADING = /^(#{1,2})[ \t]+(.*?)[ \t]*#*[ \t]*$/;

interface Chunk {
  /** The section's name, or null for the text before the first heading. */
  name: string | null;
  /** The heading line and the lines under it, up to the next heading. */
  lines: string[];
}

/** The lines of `text` that are headings, ignoring any inside a fenced code block. */
function split(text: string): Chunk[] {
  const chunks: Chunk[] = [{ name: null, lines: [] }];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const f = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const h = fence || f ? null : HEADING.exec(line);
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
    } else if (f) fence = f;
    if (h) chunks.push({ name: h[2]!, lines: [line] });
    else chunks[chunks.length - 1]!.lines.push(line);
  }
  return chunks.filter((c) => c.name !== null || c.lines.length);
}

const same = (a: string | null, b: string) => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

/** The body of the named section (case-insensitive), trimmed; "" when it has none. */
export function memorySection(text: string, name: string): string {
  const chunk = split(text).find((c) => same(c.name, name));
  return chunk ? chunk.lines.slice(1).join("\n").trim() : "";
}

/** The names of the document's sections, in order. */
export function memorySections(text: string): string[] {
  return split(text).flatMap((c) => (c.name === null ? [] : [c.name]));
}

/** Whether `body` has a heading at a section's level outside a code fence (it would split the section in two). */
function hasSectionHeading(body: string): boolean {
  return split(body).some((c) => c.name !== null);
}

export class MemoryError extends Error {}

/**
 * `text` with one section's body replaced; every other section is returned byte for byte. A missing
 * section is appended. An empty body removes the section, except the triage guidance, which stays as
 * an empty heading so the CoS and the human always find it. The result is checked against the size caps.
 */
export function replaceMemorySection(text: string, name: string, body: string): string {
  const title = name.trim();
  if (!title || /[\r\n]/.test(title) || title.startsWith("#")) throw new MemoryError("section must be a one-line name without a leading #");
  const clean = body.replace(/\r\n/g, "\n").trim();
  if (hasSectionHeading(clean)) throw new MemoryError("body can't contain a # or ## heading outside a code block: it would start another section. Use ### for sub-headings.");
  const isGuidance = same(title, TRIAGE_GUIDANCE);
  if (isGuidance && clean.length > GUIDANCE_MAX_CHARS) throw new MemoryError(`${TRIAGE_GUIDANCE} is ${clean.length} characters; keep it under ${GUIDANCE_MAX_CHARS}. Say it more briefly.`);
  const chunks = split(text);
  const at = chunks.findIndex((c) => same(c.name, title));
  let next: string;
  if (at < 0) {
    if (!clean && !isGuidance) return text;
    const block = `## ${title}\n\n${clean}`.trimEnd();
    next = text.trim() ? `${text.replace(/\s+$/, "")}\n\n${block}\n` : `${block}\n`;
  } else if (!clean && !isGuidance) {
    chunks.splice(at, 1);
    next = chunks.map((c) => c.lines.join("\n")).join("\n");
  } else {
    const heading = chunks[at]!.lines[0]!;
    chunks[at] = { name: chunks[at]!.name, lines: [heading, ...(clean ? ["", ...clean.split("\n")] : []), ""] };
    next = chunks.map((c) => c.lines.join("\n")).join("\n");
  }
  if (next.length > MEMORY_MAX_CHARS) throw new MemoryError(`The memory would be ${next.length} characters; keep it under ${MEMORY_MAX_CHARS}. Trim a section first.`);
  return next;
}

/** A whole document a human saved: only the size cap applies. */
export function checkMemory(text: string): string {
  if (text.length > MEMORY_MAX_CHARS) throw new MemoryError(`The memory is ${text.length} characters; the limit is ${MEMORY_MAX_CHARS}.`);
  return text;
}

/** What a write is checked against: changes whenever the text does, so a stale write is caught. */
export function memoryRevision(text: string | null): string {
  return createHash("sha1").update(text ?? "").digest("hex").slice(0, 12);
}
