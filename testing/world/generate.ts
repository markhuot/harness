// world.json: the world as JSON, for the Swift tests and the walkthrough. Committed, and
// `bun run testing` fails when it differs from a fresh generation (see world.test.ts), so it can't go stale.
//   bun testing/world/generate.ts          write it
//   bun testing/world/generate.ts --check  exit 1 when the committed copy is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./index";

export const WORLD_JSON = join(import.meta.dir, "world.json");

export function render(): string {
  return `${JSON.stringify(world, null, 2)}\n`;
}

/** True when the committed world.json is exactly what the TypeScript world generates now. */
export function isFresh(): boolean {
  try {
    return readFileSync(WORLD_JSON, "utf8") === render();
  } catch {
    return false;
  }
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    if (!isFresh()) {
      console.error("testing/world/world.json is out of date: run `bun testing/world/generate.ts`");
      process.exit(1);
    }
  } else {
    writeFileSync(WORLD_JSON, render());
    console.log(`wrote ${WORLD_JSON}`);
  }
}
