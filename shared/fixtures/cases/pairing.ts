import { buildPairUrl, parsePairUrl } from "../../src/pairing";
import { cases } from "../case";

export const buildPairUrlCases = cases(({ baseUrl, token }: { baseUrl: string; token: string }) => buildPairUrl(baseUrl, token), {
  "plain tailscale url": { baseUrl: "http://100.107.188.66:7717", token: "abc" },
  "token with reserved characters": { baseUrl: "http://100.107.188.66:7717", token: "a&b=c d" },
  "ipv6 host": { baseUrl: "http://[fd7a::1]:7717", token: "t" },
  "unicode and unreserved marks": { baseUrl: "https://mac.local/harness", token: "é!~*'()-_.é" },
});

export const parsePairUrlCases = cases(parsePairUrl, {
  "round trip": buildPairUrl("http://100.107.188.66:7717", "a&b=c d"),
  "ipv6 round trip": buildPairUrl("http://[fd7a::1]:7717", "t"),
  "surrounding whitespace": `  ${buildPairUrl("http://h:1", "t")}\n`,
  "other scheme": "https://pair?url=x&token=y",
  "no question mark": "harness://pair",
  "missing token": "harness://pair?url=http%3A%2F%2Fh",
  "empty token": "harness://pair?url=http%3A%2F%2Fh&token=",
  "ftp url": "harness://pair?url=ftp%3A%2F%2Fh&token=t",
  "url without host": "harness://pair?url=http%3A%2F%2F&token=t",
  "bad escape": "harness://pair?url=%E0%A4%A&token=t",
  "uppercase HTTPS accepted": "harness://pair?url=HTTPS%3A%2F%2Fh&token=t",
  "part without equals is skipped": "harness://pair?junk&url=http%3A%2F%2Fh&token=t",
  "later duplicate wins": "harness://pair?url=http%3A%2F%2Fa&url=http%3A%2F%2Fb&token=t",
  "value containing equals": "harness://pair?url=http%3A%2F%2Fh&token=a=b",
  "combining mark after the question mark": "harness://pair?́&url=http%3A%2F%2Fh&token=t",
  "NEL is not whitespace in JS": "\u0085harness://pair?url=http%3A%2F%2Fh&token=t",
  "NBSP is whitespace in JS": " harness://pair?url=http%3A%2F%2Fh&token=t ",
});
