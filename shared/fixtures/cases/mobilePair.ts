// Pairing links and manual server entry (mobile/src/lib/pair.ts) for HarnessKit's MobilePair.swift.
import { checkToken, displayHost, normalizeBaseUrl, pairParams, parsePairLink } from "../../../mobile/src/lib/pair";
import { buildPairUrl } from "../../src/pairing";
import { cases } from "../case";

export const normalizeBaseUrlCases = cases(normalizeBaseUrl, {
  "host:port gets http": " 100.64.0.2:7717 ",
  "mixed-case host, trailing slash": "Marks-Mac.local:7717/",
  "scheme and host lower-cased, query and fragment dropped": "HTTPS://Host/harness//?q=1#f",
  "leading zeros in port": "http://h:07717",
  "plain http": "http://100.107.188.66:7717",
  "https MagicDNS with trailing slash": "https://macbookpro.tail061e5.ts.net:7717/",
  "ipv6": "http://[fd7a:115c::1]:7717",
  "ipv6 upper-case": "http://[FD7A::1]",
  "ipv6 with bad characters": "http://[fd7a::g]:1",
  "bare host": "mac.local",
  "bare host with path": "mac.local/harness/",
  "trailing dot host": "http://mac.local.:7717",
  "path case kept": "http://h/Harness/Path",
  "only slashes path": "http://h///",
  "fragment only": "http://h#x",
  "query only": "http://h?x=1",
  "port 1": "http://h:1",
  "port 65535": "http://h:65535",
  "port 0": "http://h:0",
  "port 65536": "http://h:65536",
  "huge port": "http://h:99999999999999999999",
  "empty port": "http://h:",
  "non-numeric port": "http://h:ab",
  "two colons": "http://h:1:2",
  ftp: "ftp://h",
  mailto: "mailto:me@x.y",
  "javascript scheme": "javascript:alert(1)",
  "host:port looks like a scheme but has a digit": "localhost:7717",
  "scheme-like word without digit": "localhost:abc",
  empty: "",
  "only whitespace": "   \n",
  "http with no host": "http://",
  "user info": "http://user:pw@h",
  "underscore host": "http://bad_host:1",
  "exclamation host": "http://bad!:1",
  "host starting with hyphen": "http://-h",
  "host ending with hyphen": "http://h-",
  "empty label": "http://a..b",
  "non-ASCII host": "http://café.local",
  "Kelvin sign lower-cases to k": "http://K.local",
  "newline inside host": "http://h\n:1",
  "space inside host": "http://h h",
  "bracket without ipv6": "http://[h]",
  "unclosed bracket": "http://[fd7a::1",
  "digits-only host": "http://1234",
  "whitespace inside path kept": "http://h/a b/",
});

export const checkTokenCases = cases(checkToken, {
  trimmed: "  abc  ",
  blank: "   ",
  empty: "",
  "inner space kept": " a b ",
  "newlines trimmed": "\ntok\t",
});

export const parsePairLinkCases = cases(parsePairLink, {
  "desktop QR": buildPairUrl("http://100.107.188.66:7717", "a1b2c3"),
  "MagicDNS host, trailing slash, https": buildPairUrl("https://macbookpro.tail061e5.ts.net:7717/", "t"),
  ipv6: buildPairUrl("http://[fd7a:115c::1]:7717", "t"),
  "surrounding whitespace": "  " + buildPairUrl("http://h:7717", "t") + "\n",
  "token with URL-significant characters": buildPairUrl("http://10.0.0.5:7717", "abc+/=&x y%"),
  empty: "",
  "https link": "https://example.com/pair?url=x&token=y",
  "other harness route": "harness://settings?url=http%3A%2F%2Fh&token=t",
  "no query": "harness://pair",
  "no url": "harness://pair?token=t",
  "no token": "harness://pair?url=http%3A%2F%2Fh%3A7717",
  "empty token": "harness://pair?url=http%3A%2F%2Fh%3A7717&token=",
  "empty url": "harness://pair?url=&token=t",
  "bad escape": "harness://pair?url=%E0%A4%A&token=t",
  "bad escape in token": "harness://pair?url=http%3A%2F%2Fh&token=%zz",
  "invalid UTF-8 escape": "harness://pair?url=%E0%A4&token=t",
  "javascript url": "harness://pair?url=javascript%3Aalert(1)&token=t",
  "file url": "harness://pair?url=file%3A%2F%2F%2Fetc%2Fpasswd&token=t",
  "user info": "harness://pair?url=http%3A%2F%2Fuser%3Apw%40h&token=t",
  "port out of range": "harness://pair?url=http%3A%2F%2Fh%3A99999&token=t",
  "bad host": "harness://pair?url=http%3A%2F%2Fbad_host!%3A1&token=t",
  "upper-case scheme normalized": "harness://pair?url=HTTP%3A%2F%2FMAC.local%2F&token=t",
  "url found via has() but token param empty after url": "harness://pair?token=&url=http%3A%2F%2Fh",
  "url key inside another value": "harness://pair?x=a&url=&token=t",
  "http with no host": "harness://pair?url=http%3A%2F%2F&token=t",
});

type RouteValue = string | string[] | null | undefined;
type RouteParams = { url?: RouteValue; token?: RouteValue };

export const pairParamsCases = cases(pairParams, {
  "array url takes the first": { url: ["http://h:7717/", "http://x"], token: "t&u" },
  "missing url": { token: "t" },
  "null url": { url: null, token: "t" },
  "empty array url": { url: [], token: "t" },
  "missing token": { url: "http://h" },
  "empty token": { url: "http://h", token: "" },
  "array token": { url: "http://h", token: ["a", "b"] },
  "ftp url": { url: "ftp://h", token: "t" },
  "host:port": { url: "h:7717", token: "t" },
  "token with percent": { url: "http://h", token: "50%" },
  "whitespace token kept": { url: "http://h", token: " t " },
} satisfies Record<string, RouteParams>);

export const displayHostCases = cases(displayHost, {
  http: "http://100.64.0.2:7717",
  https: "https://mac.local/harness",
  "upper-case scheme kept": "HTTP://h",
  "no scheme": "h:1",
  "only the leading scheme": "http://http://h",
});
