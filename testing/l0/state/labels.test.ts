import { describe, expect, test } from "bun:test";
import {
  LABEL_COLORS,
  type ParsedSearch,
  MAX_LABEL_NAME_LENGTH,
  completeQualifier,
  defaultLabelColor,
  labelKey,
  normalizeLabelName,
  normalizeLabelNames,
  parseSearchQuery,
  quoteQualifierValue,
} from "@harness/shared";
import fixtures from "../../../shared/src/labels.fixtures.json";

describe("search qualifiers (shared fixtures, which the Swift port runs too)", () => {
  test.each(fixtures.parse)("parses $q", ({ q, ...expected }) => expect(parseSearchQuery(q)).toEqual(expected as ParsedSearch));
  test.each(fixtures.quote as [string, string][])("quotes %s", (value, quoted) => expect(quoteQualifierValue(value)).toBe(quoted));
  test.each(fixtures.complete as [string, "label" | "project", string, string][])("completes %j with %s %s", (q, field, value, result) =>
    expect(completeQualifier(q, field, value)).toBe(result),
  );
});

describe("label names", () => {
  test.each(fixtures.names as [string, string | null][])("%j is stored as %j", (raw, name) => expect(normalizeLabelName(raw)).toBe(name));
  test.each(fixtures.keys as [string, string][])("%s compares as %s", (name, key) => expect(labelKey(name)).toBe(key));
  test("a name over the limit is refused", () => {
    expect(normalizeLabelName("a".repeat(MAX_LABEL_NAME_LENGTH))).not.toBeNull();
    expect(normalizeLabelName("a".repeat(MAX_LABEL_NAME_LENGTH + 1))).toBeNull();
  });
  test("a list is de-duplicated case-insensitively, keeping the first spelling and dropping unusable names", () => {
    expect(normalizeLabelNames(["Bugfix", "bugfix ", "  ", "Release 1", "release   1", 'a"b'])).toEqual(["Bugfix", "Release 1"]);
  });
  test("a new label's color is a palette color that depends only on its folded name", () => {
    const ids = LABEL_COLORS.map((c) => c.id) as string[];
    expect(ids).toContain(defaultLabelColor("Bugfix"));
    expect(defaultLabelColor("BUGFIX")).toBe(defaultLabelColor("bugfix"));
    expect(new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(defaultLabelColor)).size).toBeGreaterThan(2);
  });
});
