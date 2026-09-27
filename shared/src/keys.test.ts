import { describe, expect, test } from "bun:test";
import { checkProjectKey, parseTicketKey, PROJECT_KEY_RE, projectKeyFromPath } from "./keys";

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

describe("checkProjectKey", () => {
  test("upper-cases and trims valid keys", () => {
    expect(checkProjectKey(" hel ")).toEqual({ key: "HEL", error: null });
    expect(checkProjectKey("p37")).toEqual({ key: "P37", error: null });
    expect(checkProjectKey("A")).toEqual({ key: "A", error: null });
    expect(checkProjectKey("A".repeat(16)).error).toBeNull();
  });
  test("explains each kind of invalid key", () => {
    expect(checkProjectKey("").error).toBe("Enter a key");
    expect(checkProjectKey("3D").error).toBe("Must start with a letter");
    expect(checkProjectKey("MY-APP").error).toBe("Letters and digits only");
    expect(checkProjectKey("A".repeat(17)).error).toBe("16 characters at most");
    expect(checkProjectKey("triage").error).toBe("TRIAGE is reserved");
  });
  test("agrees with PROJECT_KEY_RE on every accepted key", () => {
    for (const k of ["HEL", "X1", "ABCDEFGHIJKLMNOP"]) expect(PROJECT_KEY_RE.test(checkProjectKey(k).key)).toBe(true);
    for (const k of ["1A", "A_B", "ABCDEFGHIJKLMNOPQ"]) expect(PROJECT_KEY_RE.test(k)).toBe(false);
  });
});
