import { expect, test } from "bun:test";
import { NOW } from "../world";

// Every render in this directory leans on these; if one drifts, the failure should be here, not in a snapshot of "3m ago".
test("the clock, time zone and locale are the world's", () => {
  expect(Date.now()).toBe(NOW);
  expect(new Date().getTime()).toBe(NOW);
  expect(new Date(NOW).getTimezoneOffset()).toBe(0);
  expect(new Date(NOW).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })).toBe("3:00 PM");
});
