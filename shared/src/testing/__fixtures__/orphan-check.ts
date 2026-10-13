// A check script that starts a daemon and never stops it: prints "<daemon pid> <home>", then waits to be killed (or exits at once with EXIT_NOW=1).
import { startDaemon } from "../daemon";
const d = await startDaemon({ entry: new URL("./health-daemon.ts", import.meta.url).pathname });
console.log(`${d.proc.pid} ${d.home}`);
if (process.env.EXIT_NOW) process.exit(0);
setInterval(() => {}, 1000);
