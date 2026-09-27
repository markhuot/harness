#!/usr/bin/env bun
// Fake `claude` CLI for driver tests. Records each invocation and replays canned output.
//
// Env:
//   FAKE_CLAUDE_RECORD   file to append one JSON line per invocation: { argv, stdin, cwd, env }
//   FAKE_CLAUDE_SCRIPT   NDJSON file replayed on stdout for `-p` runs. Control lines:
//                          {"__sleep": ms}  {"__stderr": "text"}  {"__exit": code}
//                          {"__echo_session": true} → emits system/init with the --resume id (or "new-session")
//   FAKE_CLAUDE_MISSING_SESSION  when --resume equals this id, fail like the real CLI does
//   FAKE_CLAUDE_AUTH     JSON printed by `auth status --json`
//   FAKE_CLAUDE_LOGIN_URL URL printed by `auth login` (then it sleeps FAKE_CLAUDE_LOGIN_SLEEP ms)
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const env = process.env;

// SDK control protocol (`-p --input-format stream-json`): answer `initialize` like the real
// CLI (models etc.), then idle until stdin closes or we're killed. Env:
//   FAKE_CLAUDE_MODELS       JSON array for response.models (default: two models + "default")
//   FAKE_CLAUDE_INIT         "error" → error control_response; "exit" → exit 2 with stderr, no answer;
//                            "hang" → never answer; "noise" → junk lines + an unrelated response first
if (argv[0] === "-p" && argv[argv.indexOf("--input-format") + 1] === "stream-json") {
  if (env.FAKE_CLAUDE_RECORD) {
    const passEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("CLAUDE") || k === "HARNESS_MARKER"));
    appendFileSync(env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin: "", cwd: process.cwd(), env: passEnv }) + "\n");
  }
  const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  const mode = env.FAKE_CLAUDE_INIT ?? "";
  if (mode === "exit") {
    process.stderr.write("Error: not logged in\n");
    process.exit(2);
  }
  say({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup", session_id: "s" });
  const models = env.FAKE_CLAUDE_MODELS
    ? JSON.parse(env.FAKE_CLAUDE_MODELS)
    : [
        { value: "default", resolvedModel: "claude-opus-9", displayName: "Default (recommended)", description: "Opus 9 · Best for everyday tasks" },
        { value: "opus", resolvedModel: "claude-opus-9", displayName: "Opus 9", description: "Most capable" },
        { value: "haiku", resolvedModel: "claude-haiku-9", displayName: "Haiku 9", description: "Fastest" },
      ];
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      const msg = JSON.parse(raw);
      if (msg.type === "user") {
        // The harness must never spend tokens to list models.
        process.stderr.write("fake-claude: unexpected user message\n");
        process.exit(9);
      }
      if (msg.type !== "control_request" || msg.request?.subtype !== "initialize" || mode === "hang") continue;
      if (mode === "noise") {
        process.stdout.write("warn: something odd\n");
        say({ type: "control_response", response: { subtype: "success", request_id: "someone-else", response: { models: [] } } });
      }
      if (mode === "error") say({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "Already initialized" } });
      else say({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [], models, account: { email: "x@y" } } } });
    }
  }
  process.exit(0);
}
const stdin = argv[0] === "-p" ? await new Response(Bun.stdin.stream()).text() : "";

if (env.FAKE_CLAUDE_RECORD) {
  const passEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("CLAUDE") || k === "HARNESS_MARKER"));
  appendFileSync(env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin, cwd: process.cwd(), env: passEnv }) + "\n");
}

const out = (line: string) => process.stdout.write(line + "\n");

if (argv[0] === "auth" && argv[1] === "status") {
  out("warn: ignoring extra certs from /nowhere.pem");
  out(env.FAKE_CLAUDE_AUTH ?? JSON.stringify({ loggedIn: false }));
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "login") {
  process.stderr.write("Opening browser to sign in…\n");
  if (env.FAKE_CLAUDE_LOGIN_URL) out(`If the browser didn't open, visit: ${env.FAKE_CLAUDE_LOGIN_URL}`);
  await Bun.sleep(Number(env.FAKE_CLAUDE_LOGIN_SLEEP ?? 0));
  out("Login successful.");
  process.exit(0);
}

const resumeIdx = argv.indexOf("--resume");
const resume = resumeIdx === -1 ? null : argv[resumeIdx + 1]!;
if (resume && resume === env.FAKE_CLAUDE_MISSING_SESSION) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  out(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: resume, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, errors: [`No conversation found with session ID: ${resume}`] }));
  process.exit(1);
}

const script = env.FAKE_CLAUDE_SCRIPT ? await Bun.file(env.FAKE_CLAUDE_SCRIPT).text() : "";
for (const raw of script.split("\n")) {
  if (!raw.trim()) continue;
  const line = JSON.parse(raw);
  if (typeof line.__sleep === "number") await Bun.sleep(line.__sleep);
  else if (typeof line.__stderr === "string") process.stderr.write(line.__stderr + "\n");
  else if (typeof line.__exit === "number") process.exit(line.__exit);
  else if (line.__echo_session) out(JSON.stringify({ type: "system", subtype: "init", session_id: resume ?? "new-session", tools: [] }));
  else out(raw);
}
process.exit(0);
