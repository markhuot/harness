// Sign the packaged app (out/Harness-darwin-<arch>/Harness.app) for distribution outside the App
// Store: Developer ID Application identity, hardened runtime, the entitlements V8 needs. Then, if
// a notarytool keychain profile is given (NOTARY_PROFILE, created with `xcrun notarytool
// store-credentials`), notarize and staple. Finally zip it with ditto for download.
//
//   bun run package && bun scripts/sign-mac.ts [--zip out/Harness-mac.zip]
// Env: MAC_SIGN_IDENTITY (default: the "Developer ID Application: Mark Huot (47P4ZSALX4)" cert by
// SHA-1, since this keychain holds two certificates with that name), NOTARY_PROFILE (optional).
import { signAsync } from "@electron/osx-sign";
import { existsSync, rmSync, statSync } from "node:fs";
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

let notarized = false;
if (process.env.NOTARY_PROFILE) {
  const tmp = zip.replace(/\.zip$/, "-notarize.zip");
  await run(["ditto", "-c", "-k", "--keepParent", app, tmp]);
  await run(["xcrun", "notarytool", "submit", tmp, "--keychain-profile", process.env.NOTARY_PROFILE, "--wait"]);
  await run(["xcrun", "stapler", "staple", app]);
  rmSync(tmp, { force: true });
  notarized = true;
} else {
  console.log("NOTARY_PROFILE not set: skipping notarization (open with right-click → Open the first time)");
}

rmSync(zip, { force: true });
await run(["ditto", "-c", "-k", "--keepParent", app, zip]);
console.log(JSON.stringify({ zip, bytes: statSync(zip).size, notarized, authority }));
