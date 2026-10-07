// The Mac app's provisioning profile: where it lives, and the checks sign-mac.ts runs before
// embedding it at Contents/embedded.provisionprofile. Push (com.apple.developer.aps-environment)
// is a restricted entitlement, so a Developer ID app only launches with it when a profile embedded
// in the bundle grants it, for this app id, to the certificate that signed the app.
//
// The profile stays outside the repo (the repo is public): ~/.appstoreconnect/profiles/
// Harness_Mac_Push.provisionprofile, or MAC_PROVISIONING_PROFILE. Everything here but the two
// helpers at the bottom is pure, so profile.test.ts drives each refusal with plist dicts.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEAM_ID = "47P4ZSALX4";
/** "Developer ID Application: Mark Huot (47P4ZSALX4)". The keychain holds two certificates with that name, so it's named by SHA-1. */
export const DEFAULT_IDENTITY = "F59032923631CF42FCFFD1CE71D17205FD554A92";

export type PlistValue = string | number | boolean | Date | Uint8Array | PlistValue[] | { [key: string]: PlistValue };
export type PlistDict = { [key: string]: PlistValue };

export function profilePath(env: Record<string, string | undefined> = process.env): string {
  return env.MAC_PROVISIONING_PROFILE || join(homedir(), ".appstoreconnect", "profiles", "Harness_Mac_Push.provisionprofile");
}

/** Parses an XML property list, as `security cms -D` prints a profile. */
export function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-zA-Z]+)(?:\s+[^>]*?)?(\s*\/)?>|([^<]+)/g)];
  let i = 0;
  const next = () => tokens[i++];
  const skipSpace = () => {
    while (i < tokens.length && tokens[i]![4] !== undefined && !tokens[i]![4]!.trim()) i++;
  };
  const text = (tag: string): string => {
    let out = "";
    for (let t = next(); ; t = next()) {
      if (!t) throw new Error(`plist: unterminated <${tag}>`);
      if (t[4] !== undefined) out += t[4];
      else if (t[1] === "/" && t[2] === tag) return out;
      else throw new Error(`plist: unexpected <${t[2]}> inside <${tag}>`);
    }
  };
  const unescape = (s: string) =>
    s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, e: string) =>
      e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'"
        : String.fromCodePoint(e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)));
  const value = (): PlistValue => {
    skipSpace();
    const t = next();
    if (!t || t[4] !== undefined || t[1] === "/") throw new Error("plist: expected a value");
    const tag = t[2]!;
    const selfClosing = t[3] !== undefined;
    switch (tag) {
      case "true": case "false":
        if (!selfClosing) text(tag);
        return tag === "true";
      case "string": return selfClosing ? "" : unescape(text(tag));
      case "integer": case "real": {
        const n = Number(text(tag).trim());
        if (Number.isNaN(n)) throw new Error(`plist: bad <${tag}>`);
        return n;
      }
      case "date": {
        const d = new Date(text(tag).trim());
        if (Number.isNaN(d.getTime())) throw new Error("plist: bad <date>");
        return d;
      }
      case "data": return selfClosing ? new Uint8Array() : new Uint8Array(Buffer.from(text(tag).replace(/\s+/g, ""), "base64"));
      case "array": {
        const out: PlistValue[] = [];
        if (selfClosing) return out;
        for (;;) {
          skipSpace();
          if (tokens[i]?.[1] === "/" && tokens[i]?.[2] === "array") { i++; return out; }
          out.push(value());
        }
      }
      case "dict": {
        const out: PlistDict = {};
        if (selfClosing) return out;
        for (;;) {
          skipSpace();
          if (tokens[i]?.[1] === "/" && tokens[i]?.[2] === "dict") { i++; return out; }
          const k = next();
          if (!k || k[2] !== "key" || k[1] === "/") throw new Error("plist: expected <key> in <dict>");
          out[unescape(text("key"))] = value();
        }
      }
      case "plist": {
        const v = value();
        skipSpace();
        if (next()?.[2] !== "plist") throw new Error("plist: expected </plist>");
        return v;
      }
      default: throw new Error(`plist: unknown element <${tag}>`);
    }
  };
  return value();
}

export type CheckedProfile = { name: string; uuid: string; expires: Date; appIdentifier: string; apsEnvironment: string };

/**
 * Checks a decoded profile against what's being signed, throwing a message that says what's
 * wrong and how to fix it. `appIdentifier` is `<team id>.<bundle id>`; `certificateSha1` is the
 * signing identity's SHA-1 (any case); `entitlements` is what the app asks for, every restricted
 * entitlement of which the profile has to grant with the same value.
 */
export function checkProfile(
  profile: PlistValue,
  want: { appIdentifier: string; certificateSha1: string; entitlements: PlistDict; now?: Date; path?: string },
): CheckedProfile {
  const where = want.path ? ` (${want.path})` : "";
  const fail = (why: string): never => {
    throw new Error(`The Mac provisioning profile${where} ${why}. Download a Developer ID profile for ${want.appIdentifier} with Push Notifications from developer.apple.com and point MAC_PROVISIONING_PROFILE at it.`);
  };
  if (!isDict(profile)) return fail("isn't a provisioning profile (no top-level dict)");
  const name = typeof profile.Name === "string" ? profile.Name : "(unnamed)";
  const uuid = typeof profile.UUID === "string" ? profile.UUID : "";
  const platforms = Array.isArray(profile.Platform) ? profile.Platform : [];
  if (!platforms.includes("OSX")) fail(`"${name}" is for ${platforms.join(", ") || "no platform"}, not macOS (OSX)`);
  const expires = profile.ExpirationDate;
  if (!(expires instanceof Date)) return fail(`"${name}" has no ExpirationDate`);
  const now = want.now ?? new Date();
  if (expires.getTime() <= now.getTime()) fail(`"${name}" expired on ${expires.toISOString()}`);
  const ent = profile.Entitlements;
  if (!isDict(ent)) return fail(`"${name}" has no Entitlements`);
  const appIdentifier = ent["com.apple.application-identifier"];
  if (appIdentifier !== want.appIdentifier) fail(`"${name}" is for ${String(appIdentifier ?? "no application identifier")}, not ${want.appIdentifier}`);
  const aps = ent["com.apple.developer.aps-environment"];
  if (typeof aps !== "string") return fail(`"${name}" doesn't grant com.apple.developer.aps-environment (Push Notifications)`);
  for (const key of RESTRICTED) {
    if (!(key in want.entitlements)) continue;
    if (want.entitlements[key] !== ent[key]) {
      fail(`"${name}" grants ${key} = ${String(ent[key] ?? "nothing")}, but the app's entitlements ask for ${String(want.entitlements[key])}`);
    }
  }
  const sha1 = want.certificateSha1.toUpperCase();
  const certs = (Array.isArray(profile.DeveloperCertificates) ? profile.DeveloperCertificates : []).filter((c): c is Uint8Array => c instanceof Uint8Array);
  const issued = certs.map(certificateSha1);
  if (!issued.includes(sha1)) fail(`"${name}" wasn't issued for the signing certificate ${sha1} (it lists ${issued.join(", ") || "no certificates"})`);
  return { name, uuid, expires, appIdentifier: want.appIdentifier, apsEnvironment: aps };
}

/** Entitlements only a profile can grant, which the app's entitlements file must match exactly. */
const RESTRICTED = ["com.apple.application-identifier", "com.apple.developer.team-identifier", "com.apple.developer.aps-environment"];

export function certificateSha1(der: Uint8Array): string {
  return createHash("sha1").update(der).digest("hex").toUpperCase();
}

/**
 * The SHA-1 of the signing identity: MAC_SIGN_IDENTITY may already be one, or a name that
 * `security find-identity -v -p codesigning` lists (it has to name exactly one certificate).
 */
export function identitySha1(identity: string, findIdentityOutput: string): string {
  if (/^[0-9a-fA-F]{40}$/.test(identity)) return identity.toUpperCase();
  const matches = [...findIdentityOutput.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)]
    .filter((m) => m[2] === identity || m[2]!.includes(identity))
    .map((m) => m[1]!);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new Error(`MAC_SIGN_IDENTITY "${identity}" matches ${unique.length ? `${unique.length} certificates (${unique.join(", ")})` : "no valid code signing certificate"}; set it to the certificate's SHA-1.`);
  }
  return unique[0]!;
}

function isDict(v: PlistValue | undefined): v is PlistDict {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);
}

/** Decodes the CMS-signed profile at `path` with `security cms -D`. */
export function decodeProfile(path: string): PlistValue {
  if (!existsSync(path)) {
    throw new Error(`No Mac provisioning profile at ${path}. Push needs one: download the Developer ID profile for ${TEAM_ID}.com.markhuot.harness (with Push Notifications) from developer.apple.com and save it there, or set MAC_PROVISIONING_PROFILE.`);
  }
  const r = Bun.spawnSync(["security", "cms", "-D", "-i", path], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Couldn't decode the provisioning profile at ${path}: ${r.stderr.toString().trim()}`);
  return parsePlist(r.stdout.toString());
}

// `bun app/scripts/profile.ts check`: the checks sign-mac.ts runs, for the shipped bundle id and
// entitlements, so release/publish-install.sh can stop before it spends time on builds.
if (import.meta.main && process.argv[2] === "check") {
  const { APP_BUNDLE_ID } = await import("./bundle-id");
  const identity = process.env.MAC_SIGN_IDENTITY || DEFAULT_IDENTITY;
  const find = /^[0-9a-fA-F]{40}$/.test(identity) ? "" : Bun.spawnSync(["security", "find-identity", "-v", "-p", "codesigning"]).stdout.toString();
  const path = profilePath();
  const ok = checkProfile(decodeProfile(path), {
    appIdentifier: `${TEAM_ID}.${APP_BUNDLE_ID}`,
    certificateSha1: identitySha1(identity, find),
    entitlements: readPlist(join(import.meta.dir, "..", "resources", "entitlements.mac.plist")),
    path,
  });
  console.log(`"${ok.name}": ${ok.appIdentifier}, aps-environment ${ok.apsEnvironment}, expires ${ok.expires.toISOString().slice(0, 10)}`);
}

/** Reads a plain XML plist file (the entitlements, the app's Info.plist). */
export function readPlist(path: string): PlistDict {
  const r = Bun.spawnSync(["plutil", "-convert", "xml1", "-o", "-", path], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Couldn't read ${path}: ${r.stderr.toString().trim()}`);
  const v = parsePlist(r.stdout.toString());
  if (!isDict(v)) throw new Error(`${path} isn't a dictionary plist`);
  return v;
}
