import { describe, expect, test } from "bun:test";
import { buildPairUrl, parsePairUrl } from "./pairing";

describe("pair url", () => {
  test("encodes url and token with encodeURIComponent and round-trips", () => {
    const link = buildPairUrl("http://100.107.188.66:7717", "a&b=c d");
    expect(link).toBe("harness://pair?url=http%3A%2F%2F100.107.188.66%3A7717&token=a%26b%3Dc%20d");
    expect(parsePairUrl(link)).toEqual({ url: "http://100.107.188.66:7717", token: "a&b=c d" });
  });

  test("IPv6 base url survives the round trip", () => {
    expect(parsePairUrl(buildPairUrl("http://[fd7a::1]:7717", "t"))).toEqual({ url: "http://[fd7a::1]:7717", token: "t" });
  });

  test("rejects other schemes, missing values, non-http urls and bad escapes", () => {
    expect(parsePairUrl("https://pair?url=x&token=y")).toBeNull();
    expect(parsePairUrl("harness://pair?url=http%3A%2F%2Fh")).toBeNull();
    expect(parsePairUrl("harness://pair?url=ftp%3A%2F%2Fh&token=t")).toBeNull();
    expect(parsePairUrl("harness://pair?url=%E0%A4%A&token=t")).toBeNull();
  });
});
