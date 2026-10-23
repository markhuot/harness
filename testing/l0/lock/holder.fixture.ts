// A process that takes the testing lock, prints "GOT <label>", holds it for <holdMs> and lets go.
// Run by lock.test.ts with HARNESS_TESTING_LOCK_DIR pointing at a temp directory.
import { acquireTesting } from "../../queue-lock";

const [label, holdMs] = process.argv.slice(2);
const release = await acquireTesting({ cooldown: false, pollMs: 50, log: () => {} });
console.log(`GOT ${label}`);
await Bun.sleep(Number(holdMs));
release();
console.log(`DONE ${label}`);
