// One-off REAL check of the claude-code driver's permission modes (not part of `bun test`).
// Needs a logged-in claude and network. Run from a clean env, like launchd does:
//   env -i HOME=$HOME PATH=$PATH USER=$USER bun service/scripts/claude-code-permissions-check.ts
// Checks:
//   1. auto on sonnet: init reports permissionMode "auto"; `git init` in the workdir runs with no
//      permission prompt reaching the harness
//   2. auto on haiku: the CLI downgrades to "default" and the driver emits the downgrade notice
//   3. read_only (dontAsk): reads work, a write is denied without a prompt, nothing is written
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, Settings } from "@harness/shared";
import { handleMcpRequest } from "../src/api/mcp";
import { ClaudeCodeDriver } from "../src/drivers/claude-code";
import type { DriverEvent, RunRequest } from "../src/drivers/types";
import { fakeBrowser, fakeContext, fakeOps } from "../src/tools/fakes";
import { toolsForRun } from "../src/tools/index";

const settings: Settings = { defaultDriver: "claude-code", maxConcurrentRuns: 1, permissionMode: "auto", classifier: "claude-cli", defaultModels: {}, reviewModels: {}, anthropicApiKey: null };
const driver = new ClaudeCodeDriver({ settings: () => settings });
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(ok ? "  ok " : "  FAIL", what);
  if (!ok) failures.push(what);
};

async function run(model: string, mode: PermissionMode, prompt: string) {
  const cwd = mkdtempSync(join(tmpdir(), "harness-cc-perm-"));
  writeFileSync(join(cwd, "README.md"), "# demo\n");
  const prompts: string[] = [];
  const ops = fakeOps({
    requestApproval: async (_c, tool) => {
      prompts.push(tool);
      return { behavior: "deny", message: "Denied by the check script." };
    },
  });
  const ctx = fakeContext({ cwd, ops, browser: fakeBrowser() });
  const tools = toolsForRun("work", driver);
  const server = Bun.serve({ port: 0, fetch: (req) => handleMcpRequest(req, { tools, ctx }) });
  const req: RunRequest = {
    runId: "check",
    kind: "work",
    prompt,
    systemPrompt: "",
    cwd,
    model,
    permissionMode: mode,
    state: null,
    tools,
    toolContext: ctx,
    mcp: { url: `http://127.0.0.1:${server.port}/mcp/check`, headers: {} },
    signal: AbortSignal.timeout(240_000),
  };
  const events: DriverEvent[] = [];
  try {
    for await (const ev of driver.run(req)) {
      events.push(ev);
      if (ev.type === "status" || ev.type === "permission" || ev.type === "tool_call") console.log("   ", JSON.stringify(ev).slice(0, 220));
    }
  } catch (err) {
    console.log("    run error:", err instanceof Error ? err.message : err);
  } finally {
    server.stop(true);
  }
  return { cwd, events, prompts };
}

console.log("1. auto · sonnet · git init");
const a = await run("sonnet", "auto", "Run `git init` in the current directory with Bash, then say done. Don't do anything else.");
check(existsSync(join(a.cwd, ".git")), "git repo created");
check(a.prompts.length === 0, `no permission prompt reached the harness (${a.prompts.join(",") || "none"})`);
check(!a.events.some((e) => e.type === "status" && /isn't available/.test(e.text)), "no downgrade notice");

console.log("2. auto · haiku · downgrade");
const b = await run("haiku", "auto", "Reply with the single word: ok");
const notice = b.events.find((e) => e.type === "status") as { text: string } | undefined;
check(!!notice && /^Auto mode isn't available for .*haiku/i.test(notice.text), `downgrade notice (${notice?.text ?? "none"})`);

console.log("3. read_only · sonnet · dontAsk");
const c = await run("sonnet", "read_only", "Read README.md, then create a file notes.txt containing 'hi' with the Write tool. Don't ask me anything; report what happened.");
check(c.events.some((e) => e.type === "tool_result" && e.name === "Read" && !e.result.isError), "Read succeeded");
check(!existsSync(join(c.cwd, "notes.txt")), "notes.txt was not written");
check(c.prompts.length === 0, "no permission prompt in read-only mode");

console.log(failures.length ? `FAILED: ${failures.join("; ")}` : "CLAUDE-CODE PERMISSIONS OK");
process.exit(failures.length ? 1 : 0);
