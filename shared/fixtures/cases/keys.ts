// Ticket-key helpers (shared/src/keys.ts) for HarnessKit's Keys.swift.
import { checkProjectKey, displayKey, isLegacyMirror, isTicketKey, keyLabel, parseTicketKey, PROJECT_KEY_RE, projectKeyFromPath, secondaryKey } from "../../src/keys";
import { cases } from "../case";

export const projectKeyFromPathCases = cases(projectKeyFromPath, {
  "basename upper-cased": "/Users/mark/work/nytimes",
  "punctuation and trailing slashes": "/tmp/my-app.v2/",
  "several trailing slashes": "/tmp/app///",
  "leading digit gets P": "/tmp/37signals",
  "root falls back": "/",
  "empty string falls back": "",
  "only punctuation falls back": "/tmp/---",
  "relative name": "my-app",
  "sixteen characters kept": "/x/abcdefghijklmnop",
  "longer names cut to sixteen": "/x/abcdefghijklmnopqrstuvwxyz",
  "digit prefix cut to sixteen after P": "/x/1234567890123456789",
  "non-ASCII letters dropped": "/x/café-bar",
  "sharp s upper-cases to SS": "/x/straße",
  "underscore dropped": "/x/my_app",
  "home tilde": "~/work/nytimes",
});

export const parseTicketKeyCases = cases(parseTicketKey, {
  native: "NYTIMES-12",
  "lower-case external key": "foo-123",
  "surrounding whitespace": "  HEL-4\n",
  "underscore in prefix": "MY_APP-3",
  "leading zeros": "HEL-007",
  "digit in prefix": "P37-1",
  "no number": "NYTIMES",
  "number first": "12-NYTIMES",
  "trailing dash": "FOO-",
  "two dashes": "FOO-BAR-1",
  "trailing newline inside": "FOO-1\nx",
  "non-ASCII digits": "FOO-١٢",
  "prefix starting with underscore": "_A-1",
  "empty string": "",
});

export const isTicketKeyCases = cases(isTicketKey, {
  valid: "hel-1",
  invalid: "hel",
});

export const checkProjectKeyCases = cases(checkProjectKey, {
  "trimmed and upper-cased": " hel ",
  "letter and digits": "p37",
  "single letter": "A",
  "sixteen characters": "A".repeat(16),
  "seventeen characters": "A".repeat(17),
  empty: "",
  "only whitespace": "   ",
  "starts with digit": "3D",
  "dash inside": "MY-APP",
  underscore: "A_B",
  "non-ASCII letter": "CAFÉ",
  reserved: "triage",
  "reserved with whitespace": " Triage ",
  "reserved as a prefix is fine": "TRIAGE2",
});

export const projectKeyPatternCases = cases((k: string) => PROJECT_KEY_RE.test(k), {
  HEL: "HEL",
  X1: "X1",
  "sixteen": "ABCDEFGHIJKLMNOP",
  "seventeen": "ABCDEFGHIJKLMNOPQ",
  "leading digit": "1A",
  underscore: "A_B",
  "lower case": "hel",
  empty: "",
  "trailing newline": "HEL\n",
});

type Keyed = { key: string; externalRef?: { key: string } | null };

const keyed: Record<string, Keyed> = {
  unlinked: { key: "MH-62", externalRef: null },
  "no externalRef field": { key: "MH-62" },
  linked: { key: "MH-124", externalRef: { key: "MH-62" } },
  "legacy mirror": { key: "CEPFR-12", externalRef: { key: "CEPFR-12" } },
  "empty remote key falls back": { key: "MH-5", externalRef: { key: "" } },
  // === compares code units: a decomposed é isn't the precomposed one.
  "canonically equivalent but different keys": { key: "É-1", externalRef: { key: "É-1" } },
};

export const keyedCases = cases(
  (t: Keyed) => ({ displayKey: displayKey(t), secondaryKey: secondaryKey(t), keyLabel: keyLabel(t), isLegacyMirror: isLegacyMirror(t) }),
  keyed,
);
