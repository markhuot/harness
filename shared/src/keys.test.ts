import { describe, expect, test } from "bun:test";
import { checkProjectKey, displayKey, isLegacyMirror, keyLabel, parseTicketKey, PROJECT_KEY_RE, projectKeyFromPath, secondaryKey } from "./keys";

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

describe("remote IDs", () => {
  const unlinked = { key: "MH-62", externalRef: null };
  const linked = { key: "MH-124", externalRef: { key: "MH-62" } };
  const legacy = { key: "CEPFR-12", externalRef: { key: "CEPFR-12" } };

  test("an unlinked ticket shows its key alone", () => {
    expect(displayKey(unlinked)).toBe("MH-62");
    expect(secondaryKey(unlinked)).toBeNull();
    expect(keyLabel(unlinked)).toBe("MH-62");
  });
  test("a linked ticket shows its remote ID with the local key beside it", () => {
    expect(displayKey(linked)).toBe("MH-62");
    expect(secondaryKey(linked)).toBe("MH-124");
    expect(keyLabel(linked)).toBe("MH-62 · MH-124");
  });
  test("a legacy mirror (key equals remote ID) doesn't repeat its key", () => {
    expect(displayKey(legacy)).toBe("CEPFR-12");
    expect(secondaryKey(legacy)).toBeNull();
    expect(keyLabel(legacy)).toBe("CEPFR-12");
  });
  test("only a ticket whose key is its remote ID is a legacy mirror", () => {
    expect(isLegacyMirror(legacy)).toBe(true);
    expect(isLegacyMirror(linked)).toBe(false);
    expect(isLegacyMirror(unlinked)).toBe(false);
  });
});
