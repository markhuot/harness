// A minimal daemon: /health plus the token file, then it stays up until SIGTERM.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.HARNESS_HOME!, "token"), "tok-123\n");
Bun.serve({ port: Number(process.env.HARNESS_PORT), hostname: "127.0.0.1", fetch: (req) => (new URL(req.url).pathname === "/health" ? new Response("ok") : Response.json({ data: { echo: req.headers.get("authorization") } })) });
