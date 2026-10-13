// A minimal daemon that reports the environment it was started with.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.HARNESS_HOME!, "token"), "tok\n");
Bun.serve({
  port: Number(process.env.HARNESS_PORT),
  hostname: "127.0.0.1",
  fetch: (req) =>
    new URL(req.url).pathname === "/health"
      ? new Response("ok")
      : Response.json({ data: { launchd: process.env.HARNESS_LAUNCHD ?? null, supervisor: process.env.HARNESS_SUPERVISOR_PID ?? null, mark: process.env.WORLD_MARK ?? null, home: process.env.HARNESS_HOME } }),
});
