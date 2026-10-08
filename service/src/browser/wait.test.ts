import { describe, expect, test } from "bun:test";
import { checkCondition, describeCondition, effectiveState } from "./wait.ts";

const error = (input: unknown, ref?: string) => {
  const r = checkCondition(input, ref);
  return r.ok ? undefined : r.error;
};

describe("count, value and attribute conditions", () => {
  test("they're checked and kept with their selector", () => {
    expect(checkCondition({ selector: "li", count: 0, value: "", attribute: { name: "aria-expanded", value: "true" } })).toEqual({
      ok: true,
      condition: { selector: "li", count: 0, value: "", attribute: { name: "aria-expanded", value: "true" } },
    });
    expect(checkCondition({ selector: "a", attribute: { name: "href" } })).toEqual({ ok: true, condition: { selector: "a", attribute: { name: "href" } } });
  });

  test("count is a whole number, 0 or more", () => {
    expect(error({ selector: "li", count: -1 })).toBe("count must be a whole number, 0 or more.");
    expect(error({ selector: "li", count: 1.5 })).toBe("count must be a whole number, 0 or more.");
    expect(error({ selector: "li", count: "2" })).toBe("count must be a whole number, 0 or more.");
  });

  test("each needs a selector (or a ref) to count or read", () => {
    expect(error({ count: 2 })).toBe("count needs a selector: the elements it counts or reads.");
    expect(error({ text: "Saved", value: "x" })).toBe("value needs a selector: the elements it counts or reads.");
    expect(error({ url: "/done", attribute: { name: "href" } })).toBe("attribute needs a selector: the elements it counts or reads.");
    expect(checkCondition({ count: 1 }, "e3")).toEqual({ ok: true, condition: { ref: "e3", count: 1 } });
  });

  test("value is a string and attribute is { name, value? }", () => {
    expect(error({ selector: "#q", value: 3 })).toBe("value must be a string.");
    expect(error({ selector: "a", attribute: {} })).toBe("attribute is { name, value? }, with a non-empty name.");
    expect(error({ selector: "a", attribute: { name: "" } })).toBe("attribute is { name, value? }, with a non-empty name.");
    expect(error({ selector: "a", attribute: "href" })).toBe("attribute is { name, value? }, with a non-empty name.");
    expect(error({ selector: "a", attribute: { name: "href", equals: "/x" } })).toBe("attribute is { name, value? }; it has no equals.");
    expect(error({ selector: "a", attribute: { name: "href", value: 1 } })).toBe("attribute's value must be a string.");
  });

  test("a ref stands in for selector and frame, never beside them", () => {
    expect(error({ selector: "#a" }, "e1")).toBe("A ref names its element and frame: give it without selector or frame.");
    expect(error({ frame: "#f", state: "visible" }, "e1")).toBe("A ref names its element and frame: give it without selector or frame.");
    expect(checkCondition({ state: "hidden" }, "e1")).toEqual({ ok: true, condition: { ref: "e1", state: "hidden" } });
  });

  test("alone they don't ask for visibility; with a state they do", () => {
    expect(effectiveState({ selector: "li" })).toBe("visible");
    expect(effectiveState({ selector: "li", count: 0 })).toBeUndefined();
    expect(effectiveState({ selector: "#q", value: "" })).toBeUndefined();
    expect(effectiveState({ selector: "#q", value: "", state: "enabled" })).toBe("enabled");
  });

  test("they're described for results and timeouts", () => {
    expect(describeCondition({ selector: "li", count: 2 })).toBe('"li" count 2');
    expect(describeCondition({ selector: "#q", state: "enabled", value: "a" })).toBe('"#q" enabled, value "a"');
    expect(describeCondition({ ref: "e4", attribute: { name: "aria-expanded", value: "true" } })).toBe('ref e4 attribute aria-expanded="true"');
    expect(describeCondition({ selector: "a", attribute: { name: "href" } })).toBe('"a" attribute href');
    expect(describeCondition({ ref: "e4", state: "hidden" })).toBe("ref e4 hidden");
  });
});
