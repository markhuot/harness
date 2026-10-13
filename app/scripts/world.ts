// Boots the seeded world (lib/world.ts) and leaves it running for development: the real daemon with
// the dummy driver and the NYTIMES/HARNESS/SITE/MH projects, as the smoke and shoot scripts see it.
//
//   bun run --cwd app world        then:  HARNESS_URL=<url> HARNESS_TOKEN=<token> bun run --cwd app dev
import { bootWorld } from "./lib/world";

const world = await bootWorld({ delayMs: 70, logs: "inherit" });
console.log(`world: ${world.base}\ntoken: ${world.token}\nHARNESS_URL=${world.base} HARNESS_TOKEN=${world.token} bun run --cwd app dev\nCtrl-C stops it.`);
const quit = () => void world.stop().then(() => process.exit(0));
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
await world.proc.exited;
