// Sign the packaged app (out/Harness-darwin-<arch>/Harness.app) for distribution outside the App
// Store: Developer ID Application identity, hardened runtime, the entitlements V8 needs. Then
// notarize and staple when asked to, and finally zip it with ditto for download.
//
//   bun run package && bun scripts/sign-mac.ts [--zip out/Harness-mac.zip]
// Env: MAC_SIGN_IDENTITY (default: the "Developer ID Application: Mark Huot (47P4ZSALX4)" cert by
// SHA-1, since this keychain holds two certificates with that name). Notarizing: NOTARY_PROFILE
// names a notarytool keychain profile (`xcrun notarytool store-credentials`), or
// NOTARIZE_WITH_ASC_KEY=1 uses the App Store Connect API key (ASC_KEY_ID, ASC_ISSUER_ID, and the
// .p8 at ASC_KEY_PATH, default ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8). The key needs
// no keychain access, which a background process may not get. Neither set: no notarization.
import { signAsync } from "@electron/osx-sign";
import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dir, "..");
const app = join(appDir, "out", `Harness-darwin-${process.arch}`, "Harness.app");
const zipArg = process.argv.indexOf("--zip");
const zip = resolve(appDir, zipArg > 0 ? process.argv[zipArg + 1]! : "out/Harness-mac.zip");
const identity = process.env.MAC_SIGN_IDENTITY ?? "F59032923631CF42FCFFD1CE71D17205FD554A92";
const entitlements = join(appDir, "resources", "entitlements.mac.plist");
if (!existsSync(app)) throw new Error(`${app} is missing; run \`bun run package\` first.`);

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
  optionsForFile: () => ({ hardenedRuntime: true, entitlements }),
});
await run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app]);
const info = await run(["codesign", "-dv", "--verbose=2", app], true);
const authority = info.match(/Authority=(Developer ID Application[^\n]*)/)?.[1];
const runtime = /flags=.*runtime/.test(info);
if (!authority || !runtime) throw new Error(`unexpected signature:\n${info}`);
console.log(`signed: ${authority}, hardened runtime`);

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
