import { expect, test } from "bun:test";
import { notes, parseTag, prepare, tagFor } from "./release";

const changelog = (unreleased: string) => `# Changelog

Intro text.

## [Unreleased]
${unreleased}
## [app-20260927.1854](https://github.com/markhuot/harness/releases/tag/app-20260927.1854) - 2026-09-27

### Fixed

- Older fix.
`;

test("parseTag: build number is the tag's digits, time is UTC", () => {
  const { at, buildNumber } = parseTag("app-20260927.1854");
  expect(buildNumber).toBe("202609271854");
  expect(at.toISOString()).toBe("2026-09-27T18:54:00.000Z");
});

test("parseTag rejects other names and impossible dates or times", () => {
  for (const bad of ["v1.0.0", "app-20260927", "app-20260927.185", "app-2026-09-27.1854", "app-20260230.1200", "app-20260927.2460", "app-20261301.0000"]) {
    expect(() => parseTag(bad)).toThrow();
  }
});

test("tagFor uses the UTC minute, not local time", () => {
  expect(tagFor(new Date("2026-09-27T23:05:59-04:00"))).toBe("app-20260928.0305");
});

test("prepare moves [Unreleased] entries under a linked, dated heading above the last release", () => {
  const out = prepare(changelog("\n### Added\n\n- New thing.\n"), "app-20260928.0305");
  expect(out).toContain(`## [Unreleased]

## [app-20260928.0305](https://github.com/markhuot/harness/releases/tag/app-20260928.0305) - 2026-09-28

### Added

- New thing.

## [app-20260927.1854]`);
  expect(notes(out, "app-20260928.0305")).toBe("### Added\n\n- New thing.");
});

test("prepare refuses an empty [Unreleased], a duplicate or older tag, and a missing [Unreleased]", () => {
  expect(() => prepare(changelog("\n"), "app-20260928.0305")).toThrow(/nothing to release/);
  expect(() => prepare(changelog("\n- x\n"), "app-20260927.1854")).toThrow(/already has/);
  expect(() => prepare(changelog("\n- x\n"), "app-20260927.1800")).toThrow(/not newer/);
  expect(() => prepare("# Changelog\n", "app-20260928.0305")).toThrow(/no ## \[Unreleased\]/);
});

test("notes refuses a tag with no section, leftover [Unreleased] entries, or a tag that isn't the newest", () => {
  expect(() => notes(changelog("\n"), "app-20260928.0305")).toThrow(/no section/);
  expect(() => notes(changelog("\n- Forgotten.\n"), "app-20260927.1854")).toThrow(/still has entries/);
  const two = prepare(changelog("\n- New.\n"), "app-20260928.0305");
  expect(() => notes(two, "app-20260927.1854")).toThrow(/not the newest/);
  expect(notes(changelog("\n"), "app-20260927.1854")).toBe("### Fixed\n\n- Older fix.");
});
