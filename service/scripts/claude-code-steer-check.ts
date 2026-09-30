// Manual check that a message sent while a claude-code run is going steers it (HARNESS-68).
// Needs a logged-in claude and network; not part of `bun test`.
//   bun service/scripts/claude-code-steer-check.ts
//
// Case 1: the message arrives while the agent is between tool calls. The CLI takes it in at the
//   next tool boundary (echoed back with our uuid) and the agent changes course in the same turn.
// Case 2: the message arrives as the agent is finishing. The CLI starts another turn with it;
//   the driver keeps stdin open until that turn's result.
import type { Settings } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { handleMcpRequest } from "../src/api/mcp";
import { ClaudeCodeDriver } from "../src/drivers/claude-code";
import { RunInput, type DriverEvent, type RunRequest } from "../src/drivers/types";
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
const cwd = tempDir("harness-steer-");
const ctx = fakeContext({ cwd, ops: fakeOps(), browser: fakeBrowser() });
const tools = toolsForRun("work", driver);
const server = Bun.serve({ port: 0, fetch: (req) => handleMcpRequest(req, { tools, ctx }) });
const mcp = { url: `http://127.0.0.1:${server.port}/mcp/steer`, headers: { authorization: "Bearer steer" } };

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(ok ? "  ok " : "  FAIL", what);
  if (!ok) failures.push(what);
};

/** Run `prompt`, pushing `message` once `when` says so; returns the events and the input. */
async function run(prompt: string, message: string, when: (ev: DriverEvent, seen: DriverEvent[]) => boolean) {
  const input = new RunInput();
  const req: RunRequest = {
    runId: "steer",
    kind: "work",
    prompt,
    systemPrompt: "You are running inside a ticket harness.",
    cwd,
    model: "haiku",
    state: null,
    tools,
    toolContext: ctx,
    mcp,
    signal: new AbortController().signal,
    grants: { tools: ["Bash"], once: [] },
    input,
  };
  const events: DriverEvent[] = [];
  let pushed = false;
  const started = Date.now();
  for await (const ev of driver.run(req)) {
    events.push(ev);
    const t = ((Date.now() - started) / 1000).toFixed(1);
    if (ev.type === "text") console.log(`   ${t}s text: ${ev.text.slice(0, 100).replace(/\n/g, " ")}`);
    else if (ev.type === "tool_call") console.log(`   ${t}s tool_call ${ev.name} ${JSON.stringify(ev.input).slice(0, 80)}`);
    else if (ev.type === "status") console.log(`   ${t}s status: ${ev.text}`);
    if (!pushed && when(ev, events)) {
      pushed = true;
      console.log(`   ${t}s >>> steer: ${message}`);
      check(input.push(message), "the running run took the message");
    }
  }
  return { events, input, pushed };
}

const SLEEPS = "Run these Bash commands one at a time, each as its own tool call, waiting for each: `sleep 3; echo one`, then `sleep 3; echo two`, then `sleep 3; echo three`, then `sleep 3; echo four`. After each, say what it printed.";
const STEER = "STOP. Don't run any more commands. Reply with exactly the word PINEAPPLE and end your turn.";
const said = (events: DriverEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text);
const bashCalls = (events: DriverEvent[]) => events.filter((e) => e.type === "tool_call" && e.name === "Bash").length;

try {
  console.log("case 1: steer mid-turn");
  const mid = await run(SLEEPS, STEER, (ev) => ev.type === "tool_result" && JSON.stringify(ev.result.content).includes("one"));
  check(mid.pushed, "pushed after the first command");
  check(said(mid.events).some((t) => /PINEAPPLE/.test(t)), "the agent answered the steering message");
  check(bashCalls(mid.events) < 4, `the agent stopped early (${bashCalls(mid.events)} of 4 commands)`);
  check(mid.input.undelivered().length === 0, "the CLI echoed the message back (delivered)");
  check(mid.events.filter((e) => e.type === "usage").length === 1, "one turn: the message joined the turn that was going");

  console.log("case 2: steer as the turn ends");
  const late = await run(SLEEPS, STEER, (ev) => ev.type === "tool_result" && JSON.stringify(ev.result.content).includes("four"));
  check(late.pushed, "pushed after the last command");
  check(said(late.events).some((t) => /PINEAPPLE/.test(t)), "the agent answered it in a turn of its own");
  check(late.input.undelivered().length === 0, "the CLI echoed the message back (delivered)");
  check(late.input.push("after the run") === false, "the finished run refuses more messages (they'd be queued)");
} finally {
  server.stop(true);
}
console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "STEER OK");
process.exit(failures.length ? 1 : 0);
