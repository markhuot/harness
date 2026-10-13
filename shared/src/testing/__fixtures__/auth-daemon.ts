// Like health-daemon, but only answers non-/health routes to the token in its home's token file.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const tokenFile = join(process.env.HARNESS_HOME!, "token");
writeFileSync(tokenFile, `${process.env.FIXTURE_TOKEN ?? "tok-123"}\n`);
Bun.serve({
  port: Number(process.env.HARNESS_PORT),
  hostname: "127.0.0.1",
  fetch: (req) => {
    if (new URL(req.url).pathname === "/health") return new Response("ok");
    const want = readFileSync(tokenFile, "utf8").trim();
    return req.headers.get("authorization") === `Bearer ${want}` ? Response.json({ data: [] }) : new Response("no", { status: 401 });
  },
});
