// Sign the packaged app (out/Harness-darwin-<arch>/Harness.app) for distribution outside the App
// Store: Developer ID Application identity, hardened runtime, the entitlements V8 and push need,
// and the provisioning profile that grants push embedded at Contents/embedded.provisionprofile.
// Then notarize and staple when asked to, and finally zip it with ditto for download.
//
//   bun run package && bun scripts/sign-mac.ts [--zip out/Harness-mac.zip]
//   bun scripts/sign-mac.ts --local   sign only: no notarization, no zip (`bun run install-app`;
//                                     a locally built app isn't quarantined, so Gatekeeper never
//                                     asks for notarization)
// Env: MAC_SIGN_IDENTITY (default: the "Developer ID Application: Mark Huot (47P4ZSALX4)" cert by
// SHA-1, since this keychain holds two certificates with that name). MAC_PROVISIONING_PROFILE
// (default ~/.appstoreconnect/profiles/Harness_Mac_Push.provisionprofile, outside the repo since
// the repo is public; profile.ts checks it before anything is signed). Notarizing: NOTARY_PROFILE
// names a notarytool keychain profile (`xcrun notarytool store-credentials`), or
// NOTARIZE_WITH_ASC_KEY=1 uses the App Store Connect API key (ASC_KEY_ID, ASC_ISSUER_ID, and the
// .p8 at ASC_KEY_PATH, default ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8). The key needs
// no keychain access, which a background process may not get. Neither set: no notarization.
import { signAsync } from "@electron/osx-sign";
import { copyFileSync, existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_IDENTITY, TEAM_ID, checkProfile, decodeProfile, identitySha1, profilePath, readPlist } from "./profile";

const appDir = resolve(import.meta.dir, "..");
const app = join(appDir, "out", `Harness-darwin-${process.arch}`, "Harness.app");
const local = process.argv.includes("--local");
const zipArg = process.argv.indexOf("--zip");
const zip = resolve(appDir, zipArg > 0 ? process.argv[zipArg + 1]! : "out/Harness-mac.zip");
const identity = process.env.MAC_SIGN_IDENTITY || DEFAULT_IDENTITY;
const entitlements = join(appDir, "resources", "entitlements.mac.plist");
// The desktop widget extension (package.ts) is sandboxed, with entitlements of its own.
const widgetEntitlements = resolve(appDir, "..", "ios", "Widgets", "macOS", "HarnessMacWidgets.entitlements");
if (!existsSync(app)) throw new Error(`${app} is missing; run \`bun run package\` first.`);

// The profile has to grant push for this app's id to the certificate about to sign it, or macOS
// refuses to launch the app. Check that first, so a bad profile stops here and not at launch.
const profile = profilePath();
const bundleId = readPlist(join(app, "Contents", "Info.plist")).CFBundleIdentifier;
if (typeof bundleId !== "string") throw new Error(`${app} has no CFBundleIdentifier`);
const findIdentity = /^[0-9a-fA-F]{40}$/.test(identity) ? "" : (await run(["security", "find-identity", "-v", "-p", "codesigning"], true));
const checked = checkProfile(decodeProfile(profile), {
  appIdentifier: `${TEAM_ID}.${bundleId}`,
  certificateSha1: identitySha1(identity, findIdentity),
  entitlements: readPlist(entitlements),
  path: profile,
});
console.log(`provisioning profile: "${checked.name}" (${checked.uuid}), ${checked.appIdentifier}, aps-environment ${checked.apsEnvironment}, expires ${checked.expires.toISOString().slice(0, 10)}`);
// Copied in here rather than by osx-sign, which keeps an embedded profile that's already there.
const embedded = join(app, "Contents", "embedded.provisionprofile");
rmSync(embedded, { force: true });
copyFileSync(profile, embedded);

async function run(cmd: string[], quiet = false) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} → ${code}\n${err || out}`);
  if (!quiet && (out || err)) console.log((out + err).trim());
  return out + err;
}

console.log(`signing ${app}`);
await signAsync({
  app,
  identity,
  platform: "darwin",
  // Embedded above; osx-sign would otherwise look for a *.provisionprofile in the working directory.
  preEmbedProvisioningProfile: false,
  optionsForFile: (file) => ({ hardenedRuntime: true, entitlements: /\.appex(\/|$)/.test(file) ? widgetEntitlements : entitlements }),
});
await run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
const info = await run(["codesign", "-dv", "--verbose=2", app], true);
const authority = info.match(/Authority=(Developer ID Application[^\n]*)/)?.[1];
const runtime = /flags=.*runtime/.test(info);
if (!authority || !runtime) throw new Error(`unexpected signature:\n${info}`);
const signedEntitlements = await run(["codesign", "-d", "--entitlements", "-", "--xml", app], true);
if (!signedEntitlements.includes("com.apple.developer.aps-environment")) throw new Error(`the signature carries no aps-environment entitlement:\n${signedEntitlements}`);
console.log(`signed: ${authority}, hardened runtime, push (${checked.apsEnvironment})`);
if (local) {
  console.log(JSON.stringify({ app, notarized: false, authority }));
  process.exit(0);
}

function notaryAuth(env = process.env): string[] | null {
  if (env.NOTARY_PROFILE) return ["--keychain-profile", env.NOTARY_PROFILE];
  if (env.NOTARIZE_WITH_ASC_KEY !== "1") return null;
  const { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuer } = env;
  if (!keyId || !issuer) throw new Error("NOTARIZE_WITH_ASC_KEY=1 needs ASC_KEY_ID and ASC_ISSUER_ID");
  const key = env.ASC_KEY_PATH ?? join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`);
  if (!existsSync(key)) throw new Error(`no App Store Connect API key at ${key}`);
  return ["--key", key, "--key-id", keyId, "--issuer", issuer];
}

let notarized = false;
const auth = notaryAuth();
if (auth) {
  const tmp = zip.replace(/\.zip$/, "-notarize.zip");
  await run(["ditto", "-c", "-k", "--keepParent", app, tmp]);
  await run(["xcrun", "notarytool", "submit", tmp, ...auth, "--wait"]);
  await run(["xcrun", "stapler", "staple", app]);
  rmSync(tmp, { force: true });
  // Gatekeeper's verdict is what a downloader gets; notarytool can "finish" a rejected submission.
  const assessment = await run(["spctl", "--assess", "--type", "execute", "-vv", app]);
  if (!/source=Notarized Developer ID/.test(assessment)) throw new Error(`Gatekeeper doesn't see a notarized app:\n${assessment}`);
  notarized = true;
} else {
  console.log("neither NOTARY_PROFILE nor NOTARIZE_WITH_ASC_KEY=1 set: skipping notarization (open with right-click → Open the first time)");
}

rmSync(zip, { force: true });
await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
console.log(JSON.stringify({ zip, bytes: statSync(zip).size, notarized, authority }));
