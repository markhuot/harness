import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_IDENTITY, TEAM_ID, certificateSha1, checkProfile, decodeProfile, identitySha1, parsePlist, profilePath, readPlist,
  type PlistDict,
} from "./profile";

const APP_ID = `${TEAM_ID}.com.markhuot.harness`;
const cert = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 1, 2, 3, 4]);
const other = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 9, 9, 9, 9]);
const now = new Date("2026-10-07T00:00:00Z");
const entitlements: PlistDict = {
  "com.apple.developer.aps-environment": "production",
  "com.apple.application-identifier": APP_ID,
  "com.apple.developer.team-identifier": TEAM_ID,
};

function profile(over: PlistDict = {}, ent: PlistDict = {}): PlistDict {
  return {
    Name: "Harness Mac Push",
    UUID: "c73c9001",
    Platform: ["OSX"],
    ExpirationDate: new Date("2044-10-02T12:27:32Z"),
    DeveloperCertificates: [cert],
    Entitlements: { ...entitlements, "com.apple.security.application-groups": [`${TEAM_ID}.*`], ...ent },
    ...over,
  };
}
const check = (p: PlistDict, want: Partial<Parameters<typeof checkProfile>[1]> = {}) =>
  checkProfile(p, { appIdentifier: APP_ID, certificateSha1: certificateSha1(cert), entitlements, now, ...want });

describe("checkProfile", () => {
  test("accepts a macOS push profile for this app id and certificate", () => {
    const ok = check(profile(), { certificateSha1: certificateSha1(cert).toLowerCase() });
    expect(ok).toMatchObject({ name: "Harness Mac Push", appIdentifier: APP_ID, apsEnvironment: "production" });
  });

  test("refuses an expired profile, including one expiring this instant", () => {
    expect(() => check(profile({ ExpirationDate: new Date("2026-10-06T00:00:00Z") }))).toThrow(/expired on 2026-10-06/);
    expect(() => check(profile({ ExpirationDate: now }))).toThrow(/expired/);
    expect(() => check(profile({ ExpirationDate: "2044-10-02" }))).toThrow(/no ExpirationDate/);
  });

  test("refuses a profile without aps-environment", () => {
    const p = profile();
    delete (p.Entitlements as PlistDict)["com.apple.developer.aps-environment"];
    expect(() => check(p)).toThrow(/doesn't grant com.apple.developer.aps-environment/);
  });

  test("refuses a development push profile when the app asks for production", () => {
    expect(() => check(profile({}, { "com.apple.developer.aps-environment": "development" }))).toThrow(/aps-environment = development, but .* production/);
  });

  test("refuses a profile for another application identifier", () => {
    expect(() => check(profile({}, { "com.apple.application-identifier": `${TEAM_ID}.com.markhuot.other` }))).toThrow(/is for 47P4ZSALX4.com.markhuot.other, not 47P4ZSALX4.com.markhuot.harness/);
    expect(() => check(profile({}, { "com.apple.application-identifier": `${TEAM_ID}.*` }))).toThrow(/not 47P4ZSALX4.com.markhuot.harness/);
  });

  test("refuses a profile issued for a different certificate", () => {
    expect(() => check(profile({ DeveloperCertificates: [other] }))).toThrow(new RegExp(`wasn't issued for the signing certificate ${certificateSha1(cert)}.*${certificateSha1(other)}`));
    expect(() => check(profile({ DeveloperCertificates: [] }))).toThrow(/no certificates/);
  });

  test("refuses an iOS profile", () => {
    expect(() => check(profile({ Platform: ["iOS"] }))).toThrow(/is for iOS, not macOS/);
  });

  test("refuses a team id the profile doesn't grant", () => {
    expect(() => check(profile({}, { "com.apple.developer.team-identifier": "OTHERTEAM1" }))).toThrow(/team-identifier = OTHERTEAM1/);
  });

  test("names the profile's path in the error", () => {
    expect(() => check(profile({ Platform: [] }), { path: "/tmp/x.provisionprofile" })).toThrow(/profile \(\/tmp\/x.provisionprofile\) "Harness Mac Push" is for no platform/);
  });
});

describe("parsePlist", () => {
  test("reads the value types a profile uses", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Name</key>
	<string>A &amp; B &lt;x&gt;</string>
	<key>Empty</key>
	<string/>
	<key>Platform</key>
	<array>
		<string>OSX</string>
	</array>
	<key>None</key>
	<array/>
	<key>DeveloperCertificates</key>
	<array>
		<data>
		AQID
		BA==
		</data>
	</array>
	<key>ExpirationDate</key>
	<date>2044-10-02T12:27:32Z</date>
	<key>ProvisionsAllDevices</key>
	<true/>
	<key>IsXcodeManaged</key>
	<false/>
	<key>TimeToLive</key>
	<integer>6570</integer>
	<key>Nested</key>
	<dict>
		<key>k</key>
		<real>1.5</real>
	</dict>
</dict>
</plist>`;
    expect(parsePlist(xml)).toEqual({
      Name: "A & B <x>",
      Empty: "",
      Platform: ["OSX"],
      None: [],
      DeveloperCertificates: [new Uint8Array([1, 2, 3, 4])],
      ExpirationDate: new Date("2044-10-02T12:27:32Z"),
      ProvisionsAllDevices: true,
      IsXcodeManaged: false,
      TimeToLive: 6570,
      Nested: { k: 1.5 },
    });
  });

  test("rejects malformed plists", () => {
    expect(() => parsePlist("<plist><dict><string>no key</string></dict></plist>")).toThrow(/expected <key>/);
    expect(() => parsePlist("<plist><date>never</date></plist>")).toThrow(/bad <date>/);
    expect(() => parsePlist("<plist><dict><key>a</key><string>x</dict></plist>")).toThrow(/unexpected <dict> inside <string>/);
    expect(() => parsePlist("<plist><widget/></plist>")).toThrow(/unknown element/);
  });
});

describe("identitySha1", () => {
  const out = `  1) F59032923631CF42FCFFD1CE71D17205FD554A92 "Developer ID Application: Mark Huot (47P4ZSALX4)"
  2) 1111111111111111111111111111111111111111 "Developer ID Application: Mark Huot (47P4ZSALX4)"
  3) 2222222222222222222222222222222222222222 "Apple Development: Mark Huot (ABCDE12345)"
     3 valid identities found`;
  test("takes a SHA-1 as it is", () => {
    expect(identitySha1(DEFAULT_IDENTITY.toLowerCase(), "")).toBe(DEFAULT_IDENTITY);
  });
  test("looks a name up, and refuses an ambiguous or unknown one", () => {
    expect(identitySha1("Apple Development: Mark Huot (ABCDE12345)", out)).toBe("2222222222222222222222222222222222222222");
    expect(() => identitySha1("Developer ID Application: Mark Huot (47P4ZSALX4)", out)).toThrow(/matches 2 certificates/);
    expect(() => identitySha1("Nobody", out)).toThrow(/no valid code signing certificate/);
  });
});

test("profilePath honours MAC_PROVISIONING_PROFILE", () => {
  expect(profilePath({ MAC_PROVISIONING_PROFILE: "/x/y.provisionprofile" })).toBe("/x/y.provisionprofile");
  expect(profilePath({})).toEndWith("/.appstoreconnect/profiles/Harness_Mac_Push.provisionprofile");
});

test("decodeProfile refuses a missing profile", () => {
  expect(() => decodeProfile("/nonexistent/Harness.provisionprofile")).toThrow(/No Mac provisioning profile at \/nonexistent/);
});

// This Mac's real profile, when it has one: the checks sign-mac.ts runs, end to end.
test.skipIf(!existsSync(profilePath()))("the installed profile passes for the app's entitlements and the default identity", () => {
  const ent = readPlist(join(import.meta.dir, "..", "resources", "entitlements.mac.plist"));
  const ok = checkProfile(decodeProfile(profilePath()), { appIdentifier: APP_ID, certificateSha1: DEFAULT_IDENTITY, entitlements: ent, path: profilePath() });
  expect(ok.apsEnvironment).toBe("production");
});
