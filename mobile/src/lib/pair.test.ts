import { describe, expect, test } from "bun:test";
import { buildPairUrl } from "@harness/shared";
import { checkToken, normalizeBaseUrl, pairParams, parsePairLink } from "./pair";

describe("parsePairLink", () => {
  test("reads exactly what the desktop QR encodes (shared buildPairUrl)", () => {
    expect(parsePairLink(buildPairUrl("http://100.107.188.66:7717", "a1b2c3"))).toEqual({ ok: true, value: { baseUrl: "http://100.107.188.66:7717", token: "a1b2c3" } });
    // MagicDNS host, trailing slash, https
    expect(parsePairLink(buildPairUrl("https://macbookpro.tail061e5.ts.net:7717/", "t"))).toEqual({ ok: true, value: { baseUrl: "https://macbookpro.tail061e5.ts.net:7717", token: "t" } });
    expect(parsePairLink(buildPairUrl("http://[fd7a:115c::1]:7717", "t"))).toMatchObject({ ok: true, value: { baseUrl: "http://[fd7a:115c::1]:7717" } });
    expect(parsePairLink("  " + buildPairUrl("http://h:7717", "t") + "\n")).toMatchObject({ ok: true });
  });

  test("tokens with URL-significant characters survive the round trip", () => {
    const token = "abc+/=&x y%";
    expect(parsePairLink(buildPairUrl("http://10.0.0.5:7717", token))).toEqual({ ok: true, value: { baseUrl: "http://10.0.0.5:7717", token } });
  });

  test("malformed input is rejected with a reason", () => {
    const bad: [string, RegExp][] = [
      ["", /Not a Harness/],
      ["https://example.com/pair?url=x&token=y", /Not a Harness/],
      ["harness://settings?url=http%3A%2F%2Fh&token=t", /Not a Harness/],
      ["harness://pair", /Not a Harness/],
      ["harness://pair?token=t", /no service URL/],
      ["harness://pair?url=http%3A%2F%2Fh%3A7717", /no token/],
      ["harness://pair?url=http%3A%2F%2Fh%3A7717&token=", /no token/],
      ["harness://pair?url=%E0%A4%A&token=t", /damaged/],
      ["harness://pair?url=javascript%3Aalert(1)&token=t", /http\(s\)/],
      ["harness://pair?url=file%3A%2F%2F%2Fetc%2Fpasswd&token=t", /http\(s\)/],
      ["harness://pair?url=http%3A%2F%2Fuser%3Apw%40h&token=t", /user name/],
      ["harness://pair?url=http%3A%2F%2Fh%3A99999&token=t", /port/],
      ["harness://pair?url=http%3A%2F%2Fbad_host!%3A1&token=t", /host name/],
    ];
    for (const [input, why] of bad) {
      const r = parsePairLink(input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.error, input).toMatch(why);
    }
  });
});

test("route params from expo-router (already decoded, maybe arrays) parse like the link", () => {
  expect(pairParams({ url: ["http://h:7717/", "http://x"], token: "t&u" })).toEqual({ ok: true, value: { baseUrl: "http://h:7717", token: "t&u" } });
  expect(pairParams({ url: undefined, token: "t" })).toMatchObject({ ok: false, error: expect.stringMatching(/no service URL/) });
  expect(pairParams({ url: "ftp://h", token: "t" }).ok).toBe(false);
});

test("manual entry: host:port gets http://, schemes and paths are normalized", () => {
  expect(normalizeBaseUrl(" 100.64.0.2:7717 ")).toEqual({ ok: true, value: "http://100.64.0.2:7717" });
  expect(normalizeBaseUrl("Marks-Mac.local:7717/")).toEqual({ ok: true, value: "http://marks-mac.local:7717" });
  expect(normalizeBaseUrl("HTTPS://Host/harness//?q=1#f")).toEqual({ ok: true, value: "https://host/harness" });
  expect(normalizeBaseUrl("http://h:07717")).toEqual({ ok: true, value: "http://h:7717" });
  expect(normalizeBaseUrl("ftp://h").ok).toBe(false);
  expect(normalizeBaseUrl("mailto:me@x.y").ok).toBe(false);
  expect(normalizeBaseUrl("").ok).toBe(false);
  expect(normalizeBaseUrl("http://").ok).toBe(false);
  expect(checkToken("  abc  ")).toEqual({ ok: true, value: "abc" });
  expect(checkToken("   ").ok).toBe(false);
});
