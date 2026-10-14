import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { HarnessEvent } from "@harness/shared";
import { createHttpHandler } from "../../service/src/api/http";
import { handleMcpRequest } from "../../service/src/api/mcp";
import type { WsData } from "../../service/src/api/ws";
import { makeOrchestrator } from "../../service/src/testing/fakes";
import { toolsForRun } from "../../service/src/tools";
import { clearPullRequestTargets } from "../../service/src/store/projects";
import { useRuntime } from "../../service/src/store/util";
import { afterTest } from "./teardown";
import { createMemoryGit, type MemoryGit } from "./memory-git";

type Options = NonNullable<Parameters<typeof makeOrchestrator>[0]> & { memoryGit?: MemoryGit };

const TOKEN = "test-token";

/**
 * The whole service for one test, in this process: an orchestrator on an in-memory store, the HTTP
 * handler called as a function (no Bun.serve), the websocket handler driven with a fake socket, and
 * the MCP handler. The runtime it installs and the orchestrator it starts are torn down after the
 * test, so a later test in the same file starts from the real clock and its own counters.
 */
export function createService(opts: Options = {}) {
  // A fixed clock and counting ids, so stamps and ids repeat from one run to the next; the module-level
  // caches the audit found (service/src store/projects.ts) start empty.
  let clock = 1_700_000_000_000;
  let counter = 0;
  const restore = useRuntime({
    now: () => clock,
    newId: () => `id-${++counter}`,
    newToken: (bytes) => String(++counter).padStart(bytes * 2, "0"),
  });
  clearPullRequestTargets();
  // Git is in memory unless the test brings its own port; the scripted agent's commits and merges land in the same memory.
  const git = opts.memoryGit ?? createMemoryGit();
  const h = makeOrchestrator({ tools: toolsForRun, git: git.port, ...opts });
  h.driver.workGit = git.work;
  // The runtime it installed and the orchestrator it started end with the test (the preload runs these).
  afterTest(restore);
  afterTest(() => h.orch.stop());
  const http = createHttpHandler({
    orchestrator: h.orch,
    bus: h.bus,
    browser: h.browser,
    tokens: { get: () => TOKEN, rotate: () => TOKEN },
    mcp: handleMcpRequest,
  });
  // The only parts of Bun's Server the handler reads: the peer address and the upgrade.
  const server = { requestIP: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }), upgrade: () => false } as never;

  async function request(method: string, path: string, body?: unknown, token: string | null = TOKEN) {
    const res = await http.fetch(
      new Request(`http://service.test${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      server,
    );
    const json = res ? await res.json() : undefined;
    return { status: res?.status ?? 0, data: json?.data, error: json?.error as string | undefined };
  }

  /** A websocket client: what the service sent it, as parsed messages. */
  function connect() {
    const sent: any[] = [];
    const data: WsData = { id: "ws-1", subs: new Map(), off: null };
    const ws = { data, send: (m: string) => sent.push(JSON.parse(m)), close() {} } as unknown as ServerWebSocket<WsData>;
    http.websocket.open!(ws);
    return { sent, events: () => sent.filter((m) => m.type === "event").map((m) => m.event as HarnessEvent), send: (msg: unknown) => http.websocket.message!(ws, JSON.stringify(msg)), close: () => http.websocket.close?.(ws, 1000, "") };
  }

  function projectDir(name: string) {
    const dir = join(h.home, "work", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  return { ...h, git, http, request, connect, projectDir, token: TOKEN, tick: (ms: number) => void (clock += ms) };
}
