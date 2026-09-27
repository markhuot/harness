// One-off manual verification of ClaudeCodeDriver against the real `claude` CLI (haiku).
// Needs a logged-in claude and network; not part of `bun test`.
//   bun service/scripts/claude-code-smoke.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@harness/shared";
import { handleMcpRequest } from "../src/api/mcp";
import { ClaudeCodeDriver } from "../src/drivers/claude-code";
import type { DriverEvent, RunRequest } from "../src/drivers/types";
import { fakeBrowser, fakeContext, fakeOps } from "../src/tools/fakes";
import { toolsForRun } from "../src/tools/index";

const settings: Settings = {
  defaultDriver: "claude-code",
  maxConcurrentRuns: 1,
  permissionMode: "ask",
  classifier: "off",
  defaultModels: {},
  reviewModels: {},
  anthropicApiKey: null,
};
const driver = new ClaudeCodeDriver({ settings: () => settings });
const cwd = mkdtempSync(join(tmpdir(), "harness-smoke-"));
const ops = fakeOps();
const ctx = fakeContext({ cwd, ops, browser: fakeBrowser() });
const tools = toolsForRun("work", driver);
const server = Bun.serve({ port: 0, fetch: (req) => handleMcpRequest(req, { tools, ctx }) });
const mcp = { url: `http://127.0.0.1:${server.port}/mcp/smoke`, headers: { authorization: "Bearer smoke" } };

function compact(ev: DriverEvent): string {
  switch (ev.type) {
    case "text_delta":
      return "";
    case "text":
    case "thinking":
      return `${ev.type}: ${ev.text.slice(0, 100).replace(/\n/g, " ")}`;
    case "tool_call":
      return `tool_call ${ev.name} ${JSON.stringify(ev.input).slice(0, 100)}`;
    case "tool_result":
      return `tool_result ${ev.name}${ev.result.isError ? " (error)" : ""}: ${JSON.stringify(ev.result.content).slice(0, 100)}`;
    default:
      return JSON.stringify(ev);
  }
}

async function run(prompt: string, state: unknown, model = "haiku"): Promise<DriverEvent[]> {
  const req: RunRequest = {
    runId: "smoke",
    kind: "work",
    prompt,
    systemPrompt: "You are running inside a ticket harness. Harness tools are exposed as mcp__harness__*.",
    cwd,
    model,
    state,
    tools,
    toolContext: ctx,
    mcp,
    signal: new AbortController().signal,
  };
  console.log("argv:", ["claude", ...(await import("../src/drivers/claude-code")).buildClaudeArgs(req, settings, (state as any)?.sessionId ?? null)].map((a) => (a.length > 80 ? a.slice(0, 77) + "..." : a)).join(" "));
  const events: DriverEvent[] = [];
  let deltas = 0;
  for await (const ev of driver.run(req)) {
    events.push(ev);
    if (ev.type === "text_delta") deltas++;
    const line = compact(ev);
    if (line) console.log("  ", line);
  }
  console.log(`   (${deltas} text_delta events)`);
  return events;
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(ok ? "  ok " : "  FAIL", what);
  if (!ok) failures.push(what);
};

try {
  console.log("run 1");
  const first = await run(
    'Call the post_summary tool with summary "smoke summary", then call submit_for_review with summary "smoke done". Do nothing else.',
    null,
  );
  const names = first.filter((e) => e.type === "tool_call").map((e) => (e as { name: string }).name);
  check(names.includes("post_summary") && names.includes("submit_for_review"), "tool_call post_summary + submit_for_review (prefix stripped)");
  check(ops.calls.some((c) => c.method === "postSummary") && ops.calls.some((c) => c.method === "submitForReview"), "HarnessOps received the calls over MCP");
  const state = first.filter((e) => e.type === "state").at(-1) as { state: { sessionId: string } } | undefined;
  check(!!state?.state.sessionId, `state event with sessionId (${state?.state.sessionId})`);
  check(first.some((e) => e.type === "usage" && typeof e.costUsd === "number"), "usage event with cost");

  console.log("run 2 (resume, switched to sonnet)");
  const second = await run("What summary did you just submit for review? Answer in one short sentence.", state?.state, "sonnet");
  const state2 = second.filter((e) => e.type === "state").at(-1) as { state: { sessionId: string } } | undefined;
  check(state2?.state.sessionId === state?.state.sessionId, `resume reused session id (${state2?.state.sessionId})`);
  const answer = second.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join(" ");
  check(/smoke done/i.test(answer), "resumed conversation remembers the submitted summary");
} finally {
  server.stop(true);
}
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "SMOKE OK");
process.exit(failures.length ? 1 : 0);
