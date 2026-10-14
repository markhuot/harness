import { expect, test } from "bun:test";
import { walk } from "./walk";

test("a failing screen is reported and the walk carries on to the next screen", async () => {
  const w = walk("t");
  await w.screen("a", async (check) => {
    check("first", false, "was 1");
    check("second still runs", true);
  });
  await w.screen("b", async () => {
    throw new Error("boom");
  });
  await w.screen("c", async (check) => check("fine", true));
  const { failed, results } = w.summary();
  expect(results.map((r) => [r.name, r.ok, r.checks])).toEqual([["a", false, 2], ["b", false, 0], ["c", true, 1]]);
  expect(failed[0]!.error).toBe("first (was 1)");
  expect(failed[1]!.error).toBe("threw: boom");
});
