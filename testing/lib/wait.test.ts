import { expect, test } from "bun:test";
import { DeadlineError, describeState, until, withDeadline } from "./wait";

test("a deadline names what was awaited and the last state seen, and is a DeadlineError", async () => {
  const never = new Promise<void>(() => {});
  const err = await withDeadline("the board to load", 20, never, () => ({ columns: 3 })).catch((e) => e);
  expect(err).toBeInstanceOf(DeadlineError);
  expect(err.message).toBe('timed out after 20ms waiting for the board to load; last seen: {"columns":3}');
});

test("a promise that settles before its deadline passes its value or its error through", async () => {
  expect(await withDeadline("x", 1000, Promise.resolve(7))).toBe(7);
  await expect(withDeadline("x", 1000, Promise.reject(new Error("boom")))).rejects.toThrow("boom");
});

test("until returns the first probe result that isn't empty, and treats 0 and '' as results", async () => {
  let calls = 0;
  expect(await until("x", 1000, () => (++calls < 3 ? undefined : 0))).toBe(0);
  expect(calls).toBe(3);
});

test("until fails at its deadline with the last thing the probe saw", async () => {
  const err = await until("the badge", 30, () => false as const).catch((e) => e);
  expect(err).toBeInstanceOf(DeadlineError);
  expect(err.message).toContain("waiting for the badge");
});

test("describeState is one short line, and says so when there is nothing", () => {
  expect(describeState(undefined)).toBe("nothing yet");
  expect(describeState("")).toBe("an empty value");
  expect(describeState("a\n  b\n\nc")).toBe("a b c");
  expect(describeState("x".repeat(400))).toHaveLength(301);
});
