// One-off check against the REAL claude CLI: print the model list the claude-code driver
// offers (initialize control request; no tokens spent). Not part of `bun test`.
//   bun service/scripts/claude-models.ts                  # list models
//   bun service/scripts/claude-models.ts --resume-check   # also: haiku run, then --resume with --model sonnet
//                                                          # (spends a few haiku/sonnet tokens)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@harness/shared";
import { cleanClaudeEnv, ClaudeCodeDriver, resolveClaudeBin } from "../src/drivers/claude-code";
import { ModelListError } from "../src/drivers/types";

const driver = new ClaudeCodeDriver({ settings: () => ({}) as Settings });
const started = Date.now();
try {
  const models = await driver.listModels();
  console.log(`claude-code models (${Date.now() - started} ms):`);
  for (const m of models) console.log(`  ${m.default ? "*" : " "} ${m.id.padEnd(22)} ${m.name}${m.description ? ` — ${m.description}` : ""}`);
} catch (err) {
  console.log(`FAILED: ${(err as Error).message}`);
  if (err instanceof ModelListError) console.log(`fallback: ${err.fallback.map((m) => m.id).join(", ")}`);
  process.exit(1);
}

if (process.argv.includes("--resume-check")) {
  const cwd = mkdtempSync(join(tmpdir(), "harness-resume-"));
  const env = cleanClaudeEnv(process.env);
  const run = async (model: string, prompt: string, resume?: string) => {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model, ...(resume ? ["--resume", resume] : [])];
    const proc = Bun.spawn([resolveClaudeBin(), ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const lines = out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const init = lines.find((l) => l.type === "system" && l.subtype === "init");
    const result = lines.find((l) => l.type === "result");
    return { session: init?.session_id as string, initModel: init?.model as string, used: Object.keys(result?.modelUsage ?? {}), text: result?.result as string };
  };
  const a = await run("haiku", "Reply with just the word: pineapple");
  console.log(`run 1 --model haiku: session ${a.session}, init.model ${a.initModel}, modelUsage ${a.used.join(", ")}`);
  const b = await run("sonnet", "What word did you just reply with? One word.", a.session);
  console.log(`run 2 --resume --model sonnet: session ${b.session}, init.model ${b.initModel}, modelUsage ${b.used.join(", ")}, answer: ${b.text}`);
  const ok = b.session === a.session && /sonnet/.test(b.initModel ?? "") && /pineapple/i.test(b.text ?? "");
  console.log(ok ? "RESUME WITH NEW MODEL OK" : "RESUME CHECK FAILED");
  process.exit(ok ? 0 : 1);
}
