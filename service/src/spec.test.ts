// The spec text helpers: edit_spec's two edit forms and their all-or-nothing errors, the
// unified diff between revisions (read back with the clients' parseDiff), and finding the local
// images a spec write stores.

import { describe, expect, test } from "bun:test";
import { parseDiff } from "@harness/shared/diff";
import { applySpecEdits, localImageSources, numberLines, rewriteImageSources, SpecEditError, unifiedDiff } from "./spec";

const SPEC = ["# Goal", "Make the button blue.", "", "## Status", "* Not started", "* Tests: none yet"].join("\n");

describe("numberLines", () => {
  test("numbers every line from 1, like Read, so edit_spec's line numbers match", () => {
    expect(numberLines("a\nb")).toBe("   1\ta\n   2\tb");
    const many = Array.from({ length: 12345 }, (_, i) => `l${i}`).join("\n");
    expect(numberLines(many).split("\n").at(-1)).toBe("12345\tl12344");
  });
});

describe("applySpecEdits: old/new text", () => {
  test("replaces a unique match", () => {
    expect(applySpecEdits(SPEC, [{ old_string: "* Not started", new_string: "* Button is blue" }], 3)).toContain("* Button is blue\n* Tests");
  });

  test("a missing old_string fails and names the revision", () => {
    expect(() => applySpecEdits(SPEC, [{ old_string: "* Started", new_string: "x" }], 3)).toThrow(/wasn't found \(the spec is at revision 3/);
  });

  test("an ambiguous old_string fails unless replace_all", () => {
    expect(() => applySpecEdits(SPEC, [{ old_string: "* ", new_string: "- " }], 2)).toThrow(/appears 2 times \(the spec is at revision 2\)/);
    expect(applySpecEdits(SPEC, [{ old_string: "* ", new_string: "- ", replace_all: true }], 2)).toContain("- Not started\n- Tests: none yet");
  });

  test("an empty or no-op edit is refused", () => {
    expect(() => applySpecEdits(SPEC, [{ old_string: "", new_string: "x" }], 1)).toThrow("old_string is empty");
    expect(() => applySpecEdits(SPEC, [{ old_string: "Goal", new_string: "Goal" }], 1)).toThrow("are the same");
    expect(() => applySpecEdits(SPEC, [], 1)).toThrow("non-empty list");
    expect(() => applySpecEdits(SPEC, [{ old: "x" }], 1)).toThrow("give either");
  });
});

describe("applySpecEdits: line ranges", () => {
  test("replaces, deletes and inserts lines", () => {
    expect(applySpecEdits(SPEC, [{ start_line: 5, end_line: 6, new_text: "* Done\n" }], 1).split("\n").slice(4)).toEqual(["* Done"]);
    expect(applySpecEdits(SPEC, [{ start_line: 3, end_line: 3, new_text: "" }], 1).split("\n")[2]).toBe("## Status");
    expect(applySpecEdits(SPEC, [{ start_line: 1, end_line: 0, new_text: "Intro" }], 1).split("\n").slice(0, 2)).toEqual(["Intro", "# Goal"]);
    expect(applySpecEdits(SPEC, [{ start_line: 7, end_line: 6, new_text: "* Appended" }], 1).split("\n").at(-1)).toBe("* Appended");
  });

  test("expected must equal those lines' current text", () => {
    const ok = applySpecEdits(SPEC, [{ start_line: 2, end_line: 2, new_text: "Make it green.", expected: "Make the button blue." }], 4);
    expect(ok).toContain("Make it green.");
    expect(() => applySpecEdits(SPEC, [{ start_line: 2, end_line: 2, new_text: "x", expected: "Make the button red." }], 4)).toThrow(
      /don't match expected \(the spec is at revision 4\)\. They read:\nMake the button blue\./,
    );
  });

  test("lines outside the base revision fail", () => {
    expect(() => applySpecEdits(SPEC, [{ start_line: 6, end_line: 7, new_text: "x" }], 2)).toThrow(/aren't in revision 2, which has 6 lines/);
    expect(() => applySpecEdits(SPEC, [{ start_line: 0, end_line: 1, new_text: "x" }], 2)).toThrow(/aren't in revision 2/);
  });

  test("line numbers name the base revision even after an earlier edit in the batch moved them", () => {
    const out = applySpecEdits(
      SPEC,
      [
        { start_line: 1, end_line: 0, new_text: "Line A\nLine B" },
        { start_line: 5, end_line: 5, new_text: "* In progress" },
      ],
      1,
    );
    expect(out.split("\n")).toEqual(["Line A", "Line B", "# Goal", "Make the button blue.", "", "## Status", "* In progress", "* Tests: none yet"]);
  });

  test("a line range an earlier edit in the batch already rewrote is refused", () => {
    expect(() =>
      applySpecEdits(
        SPEC,
        [
          { old_string: "Make the button blue.", new_string: "Make it teal." },
          { start_line: 2, end_line: 3, new_text: "x" },
        ],
        5,
      ),
    ).toThrow(/Edit 2: lines 2-3 overlap an earlier edit in this call/);
  });
});

describe("unifiedDiff", () => {
  const kinds = (diff: string) => parseDiff(diff).lines.map((l) => `${l.kind}:${l.text}`);

  test("is empty for identical text", () => {
    expect(unifiedDiff(SPEC, SPEC, "a", "b")).toBe("");
  });

  test("a changed line is a removal then an addition, with context, in a hunk parseDiff reads", () => {
    const after = SPEC.replace("* Not started", "* Button is blue");
    const diff = unifiedDiff(SPEC, after, "rev 1", "rev 2");
    expect(diff.split("\n").slice(0, 3)).toEqual(["--- rev 1", "+++ rev 2", "@@ -2,5 +2,5 @@"]);
    expect(kinds(diff).filter((k) => !k.startsWith("ctx"))).toEqual(["meta:--- rev 1", "meta:+++ rev 2", "hunk:@@ -2,5 +2,5 @@", "del:-* Not started", "add:+* Button is blue"]);
  });

  test("insertions and deletions get their own counts, and far-apart changes their own hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const after = [...lines.slice(0, 2), "new A", ...lines.slice(2, 25), ...lines.slice(26)];
    const diff = unifiedDiff(lines.join("\n"), after.join("\n"), "a", "b");
    const hunks = diff.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunks).toEqual(["@@ -1,5 +1,6 @@", "@@ -23,7 +24,6 @@"]);
    const parsed = parseDiff(diff).lines;
    expect(parsed.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["+new A"]);
    expect(parsed.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["-line 26"]);
  });

  test("from and to an empty spec", () => {
    expect(unifiedDiff("", "a\nb", "a", "b").split("\n").slice(2)).toEqual(["@@ -0,0 +1,2 @@", "+a", "+b"]);
    expect(unifiedDiff("a\nb", "", "a", "b").split("\n").slice(2)).toEqual(["@@ -1,2 +0,0 @@", "-a", "-b"]);
  });

  test("removed markdown bullets and lines starting with dashes stay removals", () => {
    const diff = unifiedDiff("--- not a header\n- item\nkeep", "keep", "a", "b");
    expect(kinds(diff).slice(3)).toEqual(["del:---- not a header", "del:-- item", "ctx: keep"]);
  });
});

describe("spec images", () => {
  const body = [
    "![After](shots/after.png)",
    '![Flow](<my shots/flow.mp4> "the flow")',
    "![Kept](attachment:abc)",
    "![Remote](https://example.com/x.png)",
    "![Again](shots/after.png)",
    "[a link](shots/after.png)",
  ].join("\n");

  test("finds local srcs once each and leaves attachment: and https: alone", () => {
    expect(localImageSources(body)).toEqual(["shots/after.png", "my shots/flow.mp4"]);
  });

  test("rewrites every image of a stored file, keeping alt text and title", () => {
    const out = rewriteImageSources(body, new Map([["shots/after.png", "id1"], ["my shots/flow.mp4", "id2"]]));
    expect(out.split("\n")).toEqual([
      "![After](attachment:id1)",
      '![Flow](attachment:id2 "the flow")',
      "![Kept](attachment:abc)",
      "![Remote](https://example.com/x.png)",
      "![Again](attachment:id1)",
      "[a link](shots/after.png)",
    ]);
  });
});

test("SpecEditError is what callers catch", () => {
  expect(() => applySpecEdits("x", "nope", 1)).toThrow(SpecEditError);
});
