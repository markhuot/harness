#!/usr/bin/env bun
// file-drop: a minimal harness watcher. Drop a JSON file into a folder and it shows up in the
// Inbox. Harness takes any text a watcher prints; this one follows watch-jira's habits: it
// blocks until there is work, prints one JSON object per line on stdout, and exits 0. Use it
// with mode "loop" (see file-drop.json); the files it prints together become one Inbox item.
//
//   bun file-drop.ts <dir> [--once] [--poll=2000]
//
// Each *.json file in <dir> must hold one object. `key` defaults to the file name
// (FOO-1.json → FOO-1) and `updated` to the file's mtime. Emitted files move to
// <dir>/processed/, unparseable ones to <dir>/failed/. Lines are written before files
// move, so a crash in between re-emits (at-least-once), never drops.
//
// Exit codes: 0 work emitted · 4 nothing to report (--once) · 2 bad usage · 1 failure.
//
// Try it:
//   mkdir -p ~/.harness/inbox
//   echo '{"summary":"Fix the footer links","description":"…"}' > ~/.harness/inbox/NYT-42.json

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const once = args.includes("--once");
const pollArg = args.find((a) => a.startsWith("--poll="));
const pollMs = pollArg ? Number(pollArg.slice("--poll=".length)) : 2000;
const positional = args.filter((a) => !a.startsWith("--"));

if (positional.length !== 1 || !Number.isFinite(pollMs) || pollMs < 100) {
  console.error("usage: file-drop <dir> [--once] [--poll=ms ≥ 100]");
  process.exit(2);
}

const raw = positional[0]!;
const dir = resolve(raw === "~" || raw.startsWith("~/") ? homedir() + raw.slice(1) : raw);
const processed = join(dir, "processed");
const failed = join(dir, "failed");

try {
  mkdirSync(processed, { recursive: true });
  mkdirSync(failed, { recursive: true });
} catch (err) {
  console.error(`file-drop: cannot prepare ${dir}: ${(err as Error).message}`);
  process.exit(1);
}

function pending(): { path: string; mtime: number }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime); // oldest first, like watch-jira
}

function moveTo(target: string, file: string): void {
  renameSync(file, join(target, `${Date.now()}-${basename(file)}`));
}

for (;;) {
  const files = pending();
  const lines: string[] = [];
  const emitted: string[] = [];

  for (const { path, mtime } of files) {
    let obj: unknown;
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      obj = null;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      console.error(`file-drop: ${basename(path)} is not a JSON object; moved to failed/`);
      moveTo(failed, path);
      continue;
    }
    const item = obj as Record<string, unknown>;
    lines.push(
      JSON.stringify({
        key: basename(path, ".json"),
        updated: new Date(mtime).toISOString(),
        ...item,
      }),
    );
    emitted.push(path);
  }

  if (lines.length) {
    await Bun.write(Bun.stdout, lines.join("\n") + "\n");
    for (const path of emitted) moveTo(processed, path);
    process.exit(0);
  }
  if (once) process.exit(4);
  await Bun.sleep(pollMs);
}
