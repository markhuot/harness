import { expect, test } from "bun:test";
import { parsePresence, PresenceRegistry } from "../../../service/src/notifications/presence";

const wire = (over: Record<string, unknown> = {}) => ({ deviceId: "d1", platform: "ios", visible: true, tickets: ["abc-1"], ...over });

test("parsePresence upper-cases and dedupes ticket keys and drops malformed ones", () => {
  const p = parsePresence(wire({ tickets: ["abc-1", "ABC-1", "bad key", 7, "-x", "ok_2"] }));
  expect(p?.tickets).toEqual(["ABC-1", "OK_2"]);
});

test("parsePresence rejects anything that isn't a well-formed message", () => {
  for (const bad of [null, "x", 1, wire({ deviceId: "" }), wire({ deviceId: "x".repeat(129) }), wire({ platform: "android" }), wire({ visible: "yes" }), wire({ tickets: "ABC-1" })]) {
    expect(parsePresence(bad)).toBeNull();
  }
});

test("terminal ids keep their case; a missing list stays missing for older clients", () => {
  expect(parsePresence(wire({ terminals: ["t-abc", "t-abc", "no good"] }))?.terminals).toEqual(["t-abc"]);
  expect(parsePresence(wire())?.terminals).toBeUndefined();
});

test("only visible clients hold a ticket, and dropping a socket releases it", () => {
  const reg = new PresenceRegistry();
  reg.set("s1", { deviceId: "a", platform: "mac", visible: true, tickets: ["T-1"] });
  reg.set("s2", { deviceId: "b", platform: "ios", visible: false, tickets: ["T-1", "T-2"] });
  expect(reg.holders("t-1").map((p) => p.deviceId)).toEqual(["a"]);
  expect(reg.isOnScreen("T-2")).toBe(false);
  reg.drop("s1");
  expect(reg.isOnScreen("T-1")).toBe(false);
  expect(reg.get("s1")).toBeNull();
  expect(reg.all()).toHaveLength(1);
});

test("a socket's second report replaces its first", () => {
  const reg = new PresenceRegistry();
  reg.set("s", { deviceId: "a", platform: "mac", visible: true, tickets: ["T-1"] });
  reg.set("s", { deviceId: "a", platform: "mac", visible: true, tickets: ["T-2"] });
  expect(reg.isOnScreen("T-1")).toBe(false);
  expect(reg.isOnScreen("T-2")).toBe(true);
});
