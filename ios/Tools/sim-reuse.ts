// What `build.ts device` and `dev-sim.ts` need to decide whether the app has to be installed again:
// where a device says the app lives now, the hash of the built app, and whether that adds up to an
// install. Nothing here touches a simulator, so the decisions are unit-tested (sim-reuse.test.ts).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type AppPlan = { install: false } | { install: true; reason: string };

/**
 * Whether `build.ts device` has to install the app again. `deviceUrl` is where the device says the
 * app lives now (null: not installed); it changes with every install, whoever made it. So an unchanged
 * build is skipped only when this checkout's record (the build's hashApp and that url) still matches,
 * and another worktree, Xcode or TestFlight installing over it forces a reinstall. Where the app's
 * data must stay, as on a phone, an unchanged build is left alone.
 */
export function planDeviceInstall(o: { installed: { hash: string; url: string } | null; builtHash: string; deviceUrl: string | null }): AppPlan {
  if (o.deviceUrl === null) return { install: true, reason: "the app isn't on the device" };
  if (o.installed === null) return { install: true, reason: "no record of an earlier install" };
  if (o.installed.url !== o.deviceUrl) return { install: true, reason: "the app on the device isn't the one this checkout installed" };
  if (o.installed.hash !== o.builtHash) return { install: true, reason: "the built app changed" };
  return { install: false };
}

/** The device's install location for `bundleId` in `devicectl device info apps --json-output`, or null. */
export function deviceAppUrl(json: string, bundleId: string): string | null {
  try {
    const apps = JSON.parse(json)?.result?.apps;
    const app = Array.isArray(apps) ? apps.find((a: { bundleIdentifier?: unknown }) => a?.bundleIdentifier === bundleId) : undefined;
    return typeof app?.url === "string" ? app.url : null;
  } catch {
    return null;
  }
}

/**
 * A hash of the built app: every file's relative path and bytes, in a fixed order. Content, not
 * mtimes, since a rebuild that changes nothing rewrites every timestamp.
 */
export function hashApp(dir: string): string {
  return hashTree(dir);
}

function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const p = join(rel, name);
      const full = join(dir, p);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue; // a dangling symlink or a file that vanished mid-walk: this note is advisory
      }
      if (st.isDirectory()) walk(p);
      else {
        h.update(`${p}\0${st.size}\0`);
        h.update(readFileSync(full));
      }
    }
  };
  walk("");
  return h.digest("hex");
}
