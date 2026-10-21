/**
 * Service modules L1 doesn't test directly, each with why and which layer owns it. The coverage
 * guard (coverage.test.ts) fails for a module under service/src that is neither imported by a test
 * in testing/service nor listed here, and for a listing that has gone stale (the module is gone,
 * or a test now imports it).
 *
 * `via` is for a module that tests reach only through another one (a repo through the Store): the
 * guard checks that the named module is imported by a test and imports this one.
 */
export interface Exclusion {
  file: string;
  reason: string;
  /** The layer that owns what L1 leaves out */
  layer: string;
  via?: string;
}

const REPO = (file: string): Exclusion => ({
  file: `service/src/store/${file}.ts`,
  reason: "A repository the store tests drive through the Store (one SQL statement set per method), with the injected clock",
  layer: "L1 (through store/index.ts)",
  via: "service/src/store/index.ts",
});

export const EXCLUSIONS: Exclusion[] = [
  // -- HTTP and WebSocket: the service's API surface --
  ...["http", "ws", "mcp", "network"].map((f) => ({
    file: `service/src/api/${f}.ts`,
    reason: "Request handling over a real socket: auth, routing, status codes and payload shapes",
    layer: "L2 (service over HTTP/WS on port 0)",
  })),

  // -- Processes the service starts --
  { file: "service/src/daemon.ts", reason: "The service's process entry: signal handlers, launchd, service.json, process.exit", layer: "L4 (the real app and service)" },
  { file: "service/src/bin.ts", reason: "Chooses between the daemon and the CLI by argv, then exits the process", layer: "L4 (the real app and service)" },
  { file: "service/src/runtime.ts", reason: "Three constants read from import.meta.dir and the executable's path", layer: "L4 (the compiled service)" },
  { file: "service/src/clock.ts", reason: "A type and Date.now as the default; nothing to assert beyond what every injected-clock test shows", layer: "L1 (every test that injects a clock)" },
  { file: "service/src/terminals/pty.ts", reason: "Starts a real shell on a real pseudo-terminal; the registry is tested against a fake PTY", layer: "L4 (a real terminal in the app)" },

  // -- Drivers: a real CLI, a real API --
  { file: "service/src/drivers/anthropic-api.ts", reason: "Calls the Messages API with a native tool loop", layer: "L3 (driver contract against a fake CLI/API)" },
  { file: "service/src/drivers/github-copilot.ts", reason: "Spawns the Copilot CLI and parses its output", layer: "L3 (driver contract against a fake CLI)" },

  // -- The integrated browser: a real Chrome --
  { file: "service/src/browser/chrome.ts", reason: "Launches and supervises a Chrome process", layer: "L4 (a real browser)" },
  { file: "service/src/browser/extension-host.ts", reason: "Installs extensions into a running Chrome over CDP", layer: "L4 (a real browser)" },
  { file: "service/src/browser/script-child.ts", reason: "The process a browser_run script runs in", layer: "L4 (a real browser)" },
  { file: "service/src/browser/websocket.ts", reason: "A raw WebSocket over node:net to Chrome's DevTools port; the CDP client is tested over a fake transport", layer: "L4 (a real browser)" },
  { file: "service/src/browser/index.ts", reason: "Builds the real BrowserManager from the app's options", layer: "L4 (a real browser)" },
  { file: "service/src/browser/types.ts", reason: "Types and one constant", layer: "L1 (type-checked)" },
  { file: "service/src/tools/browser.ts", reason: "Each tool is a thin call into a live page; the wait, key and snapshot logic they use is tested", layer: "L4 (a real browser)" },
  { file: "service/src/tools/browser-run.ts", reason: "Runs a script in a child process against a live page", layer: "L4 (a real browser)" },

  // -- Types --
  { file: "service/src/tools/types.ts", reason: "Interfaces (ToolDefinition, ToolContext, HarnessOps) with no runtime logic", layer: "L1 (type-checked)" },

  // -- Harness tools: run for real, as an agent's call, through the orchestrator --
  ...["board", "board-write", "conductor", "config", "permission", "ticket", "triage"].map((f) => ({
    file: `service/src/tools/${f}.ts`,
    reason: "Each tool is called the way an agent calls it (a scripted run through toolsForRun and the run's own context) in testing/service/tools and orchestrator/*; its schema is checked with the rest of the run's tool set",
    layer: "L1 (through tools/index.ts)",
    via: "service/src/tools/index.ts",
  })),

  // -- Store repositories: tested through the Store --
  ...["activity", "attachments", "browser-tabs", "cos", "devices", "misc", "runs", "sessions", "spec", "subagents", "transcript", "watchers"].map(REPO),
];
