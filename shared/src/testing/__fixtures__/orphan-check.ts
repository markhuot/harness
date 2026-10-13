// A check script that starts a daemon and never stops it: prints "<daemon pid> <home>", then waits to be killed (or exits at once with EXIT_NOW=1).
import { startDaemon } from "../daemon";
// GIVEN_HOME=1: the home is a caller-supplied temp dir, as in the app's check scripts. TWO=1: a second daemon in the same process.
import { tempDir } from "../tmp";
const entry = new URL("./health-daemon.ts", import.meta.url).pathname;
const d = await startDaemon({ entry, ...(process.env.GIVEN_HOME ? { home: tempDir("harness-given-") } : {}) });
const d2 = process.env.TWO ? await startDaemon({ entry }) : undefined;
console.log(`${d.proc.pid} ${d.home}${d2 ? ` ${d2.proc.pid}` : ""}`);
if (process.env.EXIT_NOW) process.exit(0);
setInterval(() => {}, 1000);
