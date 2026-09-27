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
