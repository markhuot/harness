import { describe, expect, test } from "bun:test";
import { parseTicketKey, projectKeyFromPath } from "./keys";

describe("projectKeyFromPath", () => {
  test("uses the directory basename, upper-cased", () => {
    expect(projectKeyFromPath("/Users/mark/work/nytimes")).toBe("NYTIMES");
  });
  test("strips punctuation and trailing slashes", () => {
    expect(projectKeyFromPath("/tmp/my-app.v2/")).toBe("MYAPPV2");
  });
  test("prefixes keys that would start with a digit", () => {
    expect(projectKeyFromPath("/tmp/37signals")).toBe("P37SIGNALS");
  });
  test("falls back when nothing usable remains", () => {
    expect(projectKeyFromPath("/")).toBe("PROJ");
    expect(projectKeyFromPath("/tmp/---")).toBe("PROJ");
  });
});

describe("parseTicketKey", () => {
  test("parses native and external keys", () => {
    expect(parseTicketKey("NYTIMES-12")).toEqual({ prefix: "NYTIMES", number: 12 });
    expect(parseTicketKey("foo-123")).toEqual({ prefix: "FOO", number: 123 });
  });
  test("rejects non-keys", () => {
    expect(parseTicketKey("NYTIMES")).toBeNull();
    expect(parseTicketKey("12-NYTIMES")).toBeNull();
    expect(parseTicketKey("FOO-")).toBeNull();
  });
});
