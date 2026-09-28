// Checks that the generated native iOS project (ios/, from `expo prebuild` + `pod install`) links
// every dependency in package.json that ships iOS native code. ios/ is gitignored and outlives the
// commits that add native modules, so a stale one still builds, but the app then aborts the first
// time JS touches the missing module ("Cannot find native module 'ExpoVideo'" when opening a ticket).
//
//   bun Tools/nativeDeps.ts check    exit 1 listing the packages ios/Podfile.lock doesn't link
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type PackageInfo = {
  name: string;
  /** Podspec paths relative to the package: at its root, in ios/ or in apple/. */
  podspecs: string[];
  /** expo-module.config.json `platforms`, or null when the package isn't an Expo module. */
  expoPlatforms: string[] | null;
};

/** A package needs a pod when it has a podspec and, for an Expo module, lists an Apple platform. */
export function needsPod(p: PackageInfo): boolean {
  if (p.podspecs.length === 0) return false;
  return p.expoPlatforms === null || p.expoPlatforms.some((x) => x === "apple" || x === "ios");
}

/** Packages Podfile.lock pulls pods from: `(from `../../node_modules/<name>/ios`)` and the like. */
export function linkedPackages(podfileLock: string): Set<string> {
  const out = new Set<string>();
  for (const m of podfileLock.matchAll(/\(from `[^`]*?node_modules\/((?:@[^/`]+\/)?[^/`]+)[/`]/g)) out.add(m[1]!);
  return out;
}

/** The native packages the lockfile doesn't link, in the order given. */
export function missingPods(packages: PackageInfo[], podfileLock: string): string[] {
  const linked = linkedPackages(podfileLock);
  return packages.filter((p) => needsPod(p) && !linked.has(p.name)).map((p) => p.name);
}

function packageDir(mobile: string, name: string): string | null {
  for (const base of [join(mobile, "node_modules"), join(mobile, "..", "node_modules")]) {
    const dir = join(base, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
}

export function readPackage(mobile: string, name: string): PackageInfo {
  const dir = packageDir(mobile, name);
  if (!dir) throw new Error(`${name} isn't installed; run bun install`);
  const podspecs = ["", "ios", "apple"].flatMap((sub) => {
    const d = join(dir, sub);
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".podspec")).map((f) => join(sub, f)) : [];
  });
  const cfg = join(dir, "expo-module.config.json");
  const expoPlatforms = existsSync(cfg) ? ((JSON.parse(readFileSync(cfg, "utf8")).platforms as string[] | undefined) ?? []) : null;
  return { name, podspecs, expoPlatforms };
}

if (import.meta.main) {
  const mobile = resolve(import.meta.dir, "..");
  const [cmd] = process.argv.slice(2);
  if (cmd !== "check") {
    console.error("usage: nativeDeps.ts check");
    process.exit(2);
  }
  try {
    const lockPath = join(mobile, "ios", "Podfile.lock");
    if (!existsSync(lockPath)) throw new Error("ios/Podfile.lock is missing; run expo prebuild and pod install");
    const deps = Object.keys(JSON.parse(readFileSync(join(mobile, "package.json"), "utf8")).dependencies ?? {});
    const missing = missingPods(deps.map((d) => readPackage(mobile, d)), readFileSync(lockPath, "utf8"));
    if (missing.length) {
      throw new Error(`ios/ doesn't link ${missing.join(", ")}; the app would crash when it uses them. Regenerate it: bunx expo prebuild --platform ios --no-install && (cd ios && ../Tools/pod.sh install)`);
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
}
