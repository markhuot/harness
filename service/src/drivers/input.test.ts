import { expect, test } from "bun:test";
import { RunInput } from "./input";

test("take hands each message out once; it stays undelivered until delivered()", () => {
  const input = new RunInput();
  input.push("a");
  input.push("b");
  const taken = input.take();
  expect(taken.map((m) => m.text)).toEqual(["a", "b"]);
  expect(input.take()).toEqual([]);
  expect(input.inFlight().map((m) => m.text)).toEqual(["a", "b"]);
  expect(input.delivered(taken[0]!.id)).toBe(true);
  expect(input.delivered(taken[0]!.id)).toBe(false);
  expect(input.undelivered()).toEqual(["b"]);
  expect(input.pending).toBe(true);
});

test("a closed input refuses pushes and stops notifying", () => {
  const input = new RunInput();
  let pushes = 0;
  input.onPush(() => pushes++);
  expect(input.push("a")).toBe(true);
  input.close();
  expect(input.push("b")).toBe(false);
  expect(pushes).toBe(1);
  expect(input.undelivered()).toEqual(["a"]);
});

test("undelivered gives back what the human wrote, not the text with attached files", () => {
  const input = new RunInput();
  input.push("see @a.ts\n\n<file a.ts>…</file>", "see @a.ts");
  expect(input.take()[0]!.text).toBe("see @a.ts\n\n<file a.ts>…</file>");
  expect(input.undelivered()).toEqual(["see @a.ts"]);
});
