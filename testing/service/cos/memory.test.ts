import { expect, test } from "bun:test";
import { GUIDANCE_MAX_CHARS, MEMORY_MAX_CHARS, MemoryError, memoryRevision, memorySection, memorySections, replaceMemorySection } from "../../../service/src/cos/memory";

const DOC = "Preamble line.\n\n## Triage guidance\n\nIgnore bots.\n\n## Preferences\n\nShort.\n\n### Sub\n\nkept inside\n\n## Watching\n\nSHOP-4\n";

test("sections are level 1 and 2 headings; deeper headings stay inside their section and a fenced # is not a heading", () => {
  expect(memorySections(DOC)).toEqual(["Triage guidance", "Preferences", "Watching"]);
  expect(memorySection(DOC, "preferences")).toBe("Short.\n\n### Sub\n\nkept inside");
  const fenced = "## A\n\n```sh\n# comment\n## also not a heading\n```\n\n## B\n\nb\n";
  expect(memorySections(fenced)).toEqual(["A", "B"]);
  expect(memorySection(fenced, "A")).toContain("## also not a heading");
  expect(memorySection("", "Triage guidance")).toBe("");
});

test("replacing a section leaves every other byte of the document alone", () => {
  const next = replaceMemorySection(DOC, "Preferences", "Longer answers.");
  expect(next).toBe("Preamble line.\n\n## Triage guidance\n\nIgnore bots.\n\n## Preferences\n\nLonger answers.\n\n## Watching\n\nSHOP-4\n");
  // The guidance edit leaves the rest, preamble and sub-heading section included, as it was.
  const guided = replaceMemorySection(DOC, "TRIAGE GUIDANCE", "Page me for prod.");
  expect(guided).toBe(DOC.replace("Ignore bots.", "Page me for prod."));
});

test("a missing section is appended, an empty body removes a section but never the triage guidance", () => {
  expect(replaceMemorySection("## A\n\na\n", "B", "b")).toBe("## A\n\na\n\n## B\n\nb\n");
  expect(replaceMemorySection(DOC, "Watching", "")).toBe(DOC.replace("\n## Watching\n\nSHOP-4\n", ""));
  expect(replaceMemorySection(DOC, "Triage guidance", "")).toContain("## Triage guidance\n");
  expect(memorySection(replaceMemorySection(DOC, "Triage guidance", ""), "Triage guidance")).toBe("");
  expect(replaceMemorySection("", "Nothing", "")).toBe("");
});

test("a body that would split the section, a bad name, or an overflow is refused", () => {
  expect(() => replaceMemorySection(DOC, "Preferences", "x\n## Triage guidance\ny")).toThrow(MemoryError);
  expect(() => replaceMemorySection(DOC, "Preferences", "# Title")).toThrow(MemoryError);
  expect(replaceMemorySection(DOC, "Preferences", "```\n## fenced\n```")).toContain("## fenced");
  expect(() => replaceMemorySection(DOC, "  ", "x")).toThrow(MemoryError);
  expect(() => replaceMemorySection(DOC, "# Hash", "x")).toThrow(MemoryError);
  expect(() => replaceMemorySection(DOC, "Two\nlines", "x")).toThrow(MemoryError);
  expect(() => replaceMemorySection(DOC, "Triage guidance", "z".repeat(GUIDANCE_MAX_CHARS + 1))).toThrow(/Triage guidance/);
  expect(() => replaceMemorySection(DOC, "Big", "z".repeat(MEMORY_MAX_CHARS))).toThrow(MemoryError);
});

test("the revision changes with the text, and a missing document has the revision of an empty one", () => {
  expect(memoryRevision(DOC)).not.toBe(memoryRevision(`${DOC}x`));
  expect(memoryRevision(null)).toBe(memoryRevision(""));
});
