// Git plugin server: /plugins/git/api/{changes,log,file}?ticket=KEY
// While a ticket branch's worktree exists, every ticket event re-pins its diff as refs in the repo
// (git.ts pinChanges), except during a completion run, when only the pull request head its agent
// records is pinned (pinCommit). Once the worktree is gone, the routes and the tab read that pin.
import { definePlugin, PluginHttpError, type PluginContext } from "@harness/plugin-sdk/server";
import type { Project, Ticket } from "@harness/shared";
import { commitLog, computeChanges, DEFAULT_MAX_PATCH_BYTES, fileContents, pinChanges, pinCommit, pinnedChanges, pinnedLog, readPin, unpinChanges, type Pin } from "./git";

/** `base`: the ticket's or project's base branch override (DESIGN.md "Branches"); null → git.ts resolveBase's fallbacks */
type Target =
  | { kind: "live"; workdir: string; branch: string | null; projectPath: string | null; base: string | null }
  | { kind: "pinned"; repoPath: string; branch: string | null; pin: Pin; base: string | null };

const baseOverride = (ticket: Ticket, project: Project) => ticket.baseBranch || project.baseBranch || null;

async function target(ctx: PluginContext, query: URLSearchParams): Promise<Target> {
  const key = query.get("ticket");
  if (!key) throw new PluginHttpError(400, "ticket is required");
  const found = ctx.getTicket(key);
  if (!found) throw new PluginHttpError(404, `No ticket ${key}`);
  const { ticket, project } = found;
  const workdir = ctx.ticketWorkdir(key);
  const base = baseOverride(ticket, project);
  if (workdir) return { kind: "live", workdir, branch: ticket.branch, projectPath: project.path, base };
  const pin = ticket.branch ? await readPin(ctx.exec, project.path, ticket.id) : null;
  if (pin) return { kind: "pinned", repoPath: project.path, branch: ticket.branch, pin, base };
  throw new PluginHttpError(409, `${key} has no workdir yet`);
}

function int(query: URLSearchParams, name: string, fallback: number, max: number) {
  const n = Number(query.get(name));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Per ticket id: the pin in flight, and whether another event arrived meanwhile (run once more after). */
const pinning = new Map<string, { again: boolean; done: Promise<void> }>();
/** Ticket id → project path, so a deleted ticket's refs can be removed (the event only carries the id). */
const projectOf = new Map<string, string>();

async function pin(ctx: PluginContext, ticket: Ticket) {
  const running = pinning.get(ticket.id);
  if (running) {
    running.again = true;
    return;
  }
  let finish!: () => void;
  const state = { again: true, done: new Promise<void>((r) => (finish = r)) };
  pinning.set(ticket.id, state);
  try {
    while (state.again) {
      state.again = false;
      const found = ctx.getTicket(ticket.key);
      const t = found?.ticket;
      if (!found || !t?.branch) return;
      const base = baseOverride(t, found.project);
      // A completion run may be merging, resolving conflicts or removing the worktree, so its disk
      // isn't the work: only the commit its agent recorded (the pull request's head) is pinned.
      if (t.completing) {
        if (t.pullRequestHead) await pinCommit(ctx.exec, { repoPath: found.project.path, commit: t.pullRequestHead, branch: t.branch, base, ticketId: t.id });
        continue;
      }
      const workdir = ctx.ticketWorkdir(ticket.key);
      if (!workdir || t.status === "done") return;
      await pinChanges(ctx.exec, { workdir, branch: t.branch, projectPath: found.project.path, base, ticketId: t.id });
    }
  } catch (err) {
    ctx.log.warn(`pinning ${ticket.key} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    pinning.delete(ticket.id);
    finish();
  }
}

const unpinning = new Set<Promise<void>>();

/** Resolves once no pin or unpin is in flight (tests). */
export async function pinsSettled(): Promise<void> {
  while (pinning.size || unpinning.size) await Promise.all([...[...pinning.values()].map((s) => s.done), ...unpinning]);
}

export default definePlugin({
  routes(router, ctx) {
    router.get("/changes", async ({ query }) => {
      const t = await target(ctx, query);
      const maxPatchBytes = int(query, "maxBytes", DEFAULT_MAX_PATCH_BYTES, 64 * 1024 * 1024);
      return t.kind === "live" ? computeChanges(ctx.exec, { ...t, maxPatchBytes }) : pinnedChanges(ctx.exec, { ...t, maxPatchBytes });
    });
    router.get("/log", async ({ query }) => {
      const t = await target(ctx, query);
      const limit = int(query, "limit", 200, 2000);
      return t.kind === "live" ? commitLog(ctx.exec, { ...t, limit }) : pinnedLog(ctx.exec, { ...t, limit });
    });
    router.get("/file", async ({ query }) => {
      const side = query.get("side");
      if (side !== "old" && side !== "new") throw new PluginHttpError(400, "side must be old or new");
      const t = await target(ctx, query);
      const path = query.get("path") ?? "";
      const contents =
        t.kind === "live"
          ? await fileContents(ctx.exec, { workdir: t.workdir, path, side, ref: query.get("ref") })
          : await fileContents(ctx.exec, { workdir: t.repoPath, path, side, ref: query.get("ref"), newRef: t.pin.worktree ?? t.pin.head });
      return { contents };
    });
  },

  // Changes stays on a ticket whose worktree is gone as long as its diff was pinned.
  async showTab(tab, ctx) {
    return tab.id === "changes" && !!tab.ticket.branch && !!tab.project && !!(await readPin(ctx.exec, tab.project.path, tab.ticket.id));
  },

  async onTicketEvent(event, ctx) {
    if (event.kind === "ticket.deleted") {
      const path = projectOf.get(event.id);
      projectOf.delete(event.id);
      if (!path) return;
      const p = unpinChanges(ctx.exec, path, event.id).finally(() => unpinning.delete(p));
      unpinning.add(p);
      await p;
      return;
    }
    const project = ctx.getTicket(event.ticket.key)?.project;
    if (project) projectOf.set(event.ticket.id, project.path);
    await pin(ctx, event.ticket);
  },
});
