// Where the service runs from: a repo checkout under bun (development), or the single-file
// executable `bun build --compile` makes for Harness.app (service/scripts/compile.ts). DESIGN.md
// "Runtime paths".

import { dirname, resolve } from "node:path";

/** The executable's file name inside Harness.app/Contents/MacOS. */
export const SERVICE_EXECUTABLE = "harness-service";

/** True inside the compiled executable, whose modules live in Bun's embedded /$bunfs. */
export const COMPILED = import.meta.dir.startsWith("/$bunfs/");

/** The command that runs the daemon: the executable's `daemon` mode, or bun on daemon.ts. */
export function daemonProgram(): string[] {
  return COMPILED ? [process.execPath, "daemon"] : [process.execPath, resolve(import.meta.dir, "daemon.ts")];
}

/**
 * Builtin plugins: `<repo>/plugins` in a checkout. The executable sits in Contents/MacOS and the
 * prebuilt plugins in Contents/Resources/plugins.
 */
export const BUILTIN_PLUGINS_DIR = COMPILED
  ? resolve(dirname(process.execPath), "..", "Resources", "plugins")
  : resolve(import.meta.dir, "..", "..", "plugins");
