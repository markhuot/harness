// Git plugin server: /plugins/git/api/{changes,log,file}?ticket=KEY
import { definePlugin, PluginHttpError, type PluginContext } from "@harness/plugin-sdk/server";
import { commitLog, computeChanges, DEFAULT_MAX_PATCH_BYTES, fileContents } from "./git";

function target(ctx: PluginContext, query: URLSearchParams) {
  const key = query.get("ticket");
  if (!key) throw new PluginHttpError(400, "ticket is required");
  const found = ctx.getTicket(key);
  if (!found) throw new PluginHttpError(404, `No ticket ${key}`);
  const workdir = ctx.ticketWorkdir(key);
  if (!workdir) throw new PluginHttpError(409, `${key} has no workdir yet`);
  return { workdir, branch: found.ticket.branch, projectPath: found.project.path };
}

function int(query: URLSearchParams, name: string, fallback: number, max: number) {
  const n = Number(query.get(name));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export default definePlugin({
  routes(router, ctx) {
    router.get("/changes", ({ query }) =>
      computeChanges(ctx.exec, { ...target(ctx, query), maxPatchBytes: int(query, "maxBytes", DEFAULT_MAX_PATCH_BYTES, 64 * 1024 * 1024) }),
    );
    router.get("/log", ({ query }) => commitLog(ctx.exec, { ...target(ctx, query), limit: int(query, "limit", 200, 2000) }));
    router.get("/file", async ({ query }) => {
      const side = query.get("side");
      if (side !== "old" && side !== "new") throw new PluginHttpError(400, "side must be old or new");
      const contents = await fileContents(ctx.exec, { workdir: target(ctx, query).workdir, path: query.get("path") ?? "", side, ref: query.get("ref") });
      return { contents };
    });
  },
});
