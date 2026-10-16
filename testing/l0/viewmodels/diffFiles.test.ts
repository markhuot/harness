import { describe, expect, test } from "bun:test";
import { diffFiles } from "../../../app/src/renderer/state/diffFiles";

/** Runs `fn` with console.error replaced by a spy, returning what the spy saw and whether it was put back. */
function withSpy<T>(fn: () => T): { result: T; calls: unknown[][]; restored: boolean } {
  const original = console.error;
  const calls: unknown[][] = [];
  const spy = (...args: unknown[]) => void calls.push(args);
  console.error = spy;
  try {
    const result = fn();
    return { result, calls, restored: console.error === spy };
  } finally {
    console.error = original;
  }
}

describe("diffFiles", () => {
  test("a bare diff (no file header, no hunk header) is one file called snippet", () => {
    const files = diffFiles("-old\n+new\n same");
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("snippet");
    expect(files[0]!.hunks).toHaveLength(1);
  });

  test("a hunk whose header miscounts its lines still parses", () => {
    const files = diffFiles("--- a/x.ts\n+++ b/x.ts\n@@ -1,5 +1,5 @@\n-a\n+b\n c");
    expect(files.map((f) => f.name)).toEqual(["x.ts"]);
    expect(files[0]!.hunks).toHaveLength(1);
  });

  test("two files in one block come back in order", () => {
    const text = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "diff --git a/y b/y", "--- a/y", "+++ b/y", "@@ -1 +1 @@", "-c", "+d"].join("\n");
    expect(diffFiles(text).map((f) => f.name)).toEqual(["x", "y"]);
  });

  test("prose that isn't a diff doesn't throw", () => {
    expect(() => diffFiles("hello world\nnot a diff")).not.toThrow();
  });

  test("input the parser can't take gives [] and leaves console.error as it found it", () => {
    const { result, calls, restored } = withSpy(() => diffFiles(null as unknown as string));
    expect(result).toEqual([]);
    expect(restored).toBe(true);
    expect(calls).toEqual([]);
  });

  test("console.error is restored after a successful parse too, and nothing is logged", () => {
    const { result, calls, restored } = withSpy(() => diffFiles("-a\n+b"));
    expect(result).toHaveLength(1);
    expect(restored).toBe(true);
    expect(calls).toEqual([]);
  });
});
