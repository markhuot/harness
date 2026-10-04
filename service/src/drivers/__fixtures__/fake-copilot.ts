#!/usr/bin/env bun
// Fake `copilot` CLI for driver tests.
//
// Env:
//   FAKE_COPILOT_RECORD  file to append one JSON line per invocation: { argv, cwd }
//   FAKE_COPILOT_SCRIPT  JSONL file replayed on stdout for `-p` runs. Control lines:
//                          {"__stderr": "text"}  {"__exit": code}  {"__sleep": ms}
//   FAKE_COPILOT_HELP    file printed by `help config`
//   FAKE_COPILOT_LOGIN   text printed by `login` (then it sleeps 5s)
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const env = process.env;

if (env.FAKE_COPILOT_RECORD) appendFileSync(env.FAKE_COPILOT_RECORD, JSON.stringify({ argv, cwd: process.cwd() }) + "\n");

if (argv[0] === "help" && argv[1] === "config") {
  process.stdout.write(env.FAKE_COPILOT_HELP ? readFileSync(env.FAKE_COPILOT_HELP, "utf8") : "");
  process.exit(0);
}
if (argv[0] === "login") {
  process.stdout.write(env.FAKE_COPILOT_LOGIN ?? "");
  await Bun.sleep(5000);
  process.exit(0);
}
if (argv[0] === "-p") {
  let code = 0;
  for (const line of (env.FAKE_COPILOT_SCRIPT ? readFileSync(env.FAKE_COPILOT_SCRIPT, "utf8") : "").split("\n")) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (typeof msg.__stderr === "string") process.stderr.write(msg.__stderr);
    else if (typeof msg.__exit === "number") code = msg.__exit;
    else if (typeof msg.__sleep === "number") await Bun.sleep(msg.__sleep);
    else process.stdout.write(line + "\n");
  }
  process.exit(code);
}
process.exit(2);
