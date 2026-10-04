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
  expect(input.undelivered()).toEqual([{ text: "b", attachments: [] }]);
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
  expect(input.undelivered()).toEqual([{ text: "a", attachments: [] }]);
});

test("undelivered gives back what the human sent, not the text with attached files", () => {
  const input = new RunInput();
  const attachments = [{ id: "a1", path: "/tmp/shot.png", name: "shot.png", source: "upload" as const, kind: "image" as const, mimeType: "image/png" }];
  const image = { name: "shot.png", path: "/tmp/shot.png", mediaType: "image/png" as const, data: "AAAA" };
  input.push("see @a.ts\n\n<file a.ts>…</file>\n\n<attachments>…</attachments>", { text: "see @a.ts", attachments }, [image]);
  const [taken] = input.take();
  expect(taken!.text).toBe("see @a.ts\n\n<file a.ts>…</file>\n\n<attachments>…</attachments>");
  expect(taken!.images).toEqual([image]);
  expect(input.inFlight()[0]!.images).toEqual([image]);
  expect(input.undelivered()).toEqual([{ text: "see @a.ts", attachments }]);
});
