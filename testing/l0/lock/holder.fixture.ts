// A process that takes the testing lock, prints "GOT <label>", holds it for <holdMs> and lets go.
// Run by lock.test.ts with HARNESS_TESTING_LOCK_DIR pointing at a temp directory.
import { acquireTesting } from "../../queue-lock";

const [label, holdMs, child] = process.argv.slice(2);
const release = await acquireTesting({ cooldown: false, pollMs: 50, log: () => {} });
console.log(`GOT ${label}`);
// "child": run another contender as this process's child, which must not queue behind its parent.
if (child) await Bun.spawn(["bun", import.meta.path, child, "10"], { stdout: "inherit", stderr: "inherit" }).exited;
await Bun.sleep(Number(holdMs));
release();
console.log(`DONE ${label}`);
