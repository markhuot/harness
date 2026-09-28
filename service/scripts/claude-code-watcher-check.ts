// Manual end-to-end check of the generic-watcher scenario with the REAL claude-code driver (needs
// a logged-in `claude`; the only network traffic is the model's). Not part of `bun test`.
//
//   bun service/scripts/claude-code-watcher-check.ts [--model <id>]
//
// Boots service/src/daemon.ts with a throwaway HARNESS_HOME (never ~/.harness) and a temp
// project SHOP, then asks an agent in plain English for a watcher around a curl-style loop
// (src/orchestrator/__fixtures__/events-api.ts stands in for the API). It approves the agent's
// watcher approval cards the way a human would and checks that:
//   the watcher wraps the fixture and its prompt carries the rule;
//   each of the fixture's three events becomes an Inbox triage session carrying that prompt;
//   triage (claude-code too) dispatches E1 to SHOP and declines E2 and E3.
// Prints the transcript highlights. Exit code 0 only when every check passed; 2 (before
// booting anything) when `claude` isn't installed or logged in.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Project, Session, Settings, Ticket, TicketDetail, TranscriptEntry, Watcher } from "@harness/shared";
import { ClaudeCodeDriver } from "../src/drivers/claude-code";

const serviceDir = resolve(import.meta.dir, "..");
const fixture = join(serviceDir, "src/orchestrator/__fixtures__/events-api.ts");
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1] : undefined;

// Before booting anything: the driver's own availability and login check (`claude auth status`).
const settings: Settings = { defaultDriver: "claude-code", maxConcurrentRuns: 1, permissionMode: "ask", classifier: "off", defaultModels: {}, reviewModels: {}, anthropicApiKey: null };
const claude = await new ClaudeCodeDriver({ settings: () => settings }).info();
if (!claude.available || !claude.authenticated) {
  console.error(`claude isn't available: ${claude.detail}`);
  process.exit(2);
}
console.log(`claude: ${claude.detail}`);

const home = mkdtempSync(join(tmpdir(), "harness-watcher-check-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "harness-watcher-check-shop-"));
const state = join(home, "events-state");
const port = 7900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(serviceDir, "src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port) },
  stdout: "ignore",
  stderr: "inherit",
});

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1000);
  }
}

const textOf = (e: TranscriptEntry) => ("text" in e.content ? String(e.content.text) : "");
const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

try {
  await until("the service", async () => (await fetch(`${base}/health`)).ok, 20_000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const json = (await res.json()) as { data?: T; error?: string };
    if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
    return json.data as T;
  };

  await call("PATCH", "/settings", { defaultDriver: "claude-code", permissionMode: "ask" });
  const shop = await call<Project>("POST", "/projects", { path: projectDir, key: "SHOP", name: "Shop", useWorktrees: false });
  const loop = `while true; do ${process.execPath} ${fixture} --state ${state}; sleep 2; done`;
  const prompt = [
    `Add a watcher that runs this loop, which polls our events API: \`${loop}\``,
    "If an event is assigned to me (mark) and has actionable next steps, dispatch it to an agent in project SHOP. Otherwise ignore it.",
  ].join("\n\n");
  const ticket = await call<Ticket>("POST", "/tickets", { projectId: shop.id, prompt, title: "Add an events watcher", start: true, ...(model ? { model } : {}) });
  console.log(`Created ${ticket.key}; waiting for the agent (claude-code${model ? `, ${model}` : ""})…`);

  // Approve the agent's watcher calls like a human would; deny anything else.
  const approved: string[] = [];
  const denied: string[] = [];
  const settled = await until(
    "the setup ticket to finish",
    async () => {
      const d = await call<TicketDetail>("GET", `/tickets/${ticket.key}`);
      const t = d.ticket;
      const pa = t.pendingApproval;
      if (pa) {
        const ok = /^(mcp__harness__)?(create_watcher|update_watcher|run_watcher)$/.test(pa.toolName);
        (ok ? approved : denied).push(`${pa.toolName}: ${pa.summary ?? JSON.stringify(pa.input)}`);
        await call("POST", `/tickets/${ticket.key}/approval`, ok ? { decision: "allow_once" } : { decision: "deny", message: "Not needed for this watcher." });
        return undefined;
      }
      return !t.busy && (t.status === "review" || t.status === "done" || t.status === "blocked") ? t : undefined;
    },
    10 * 60_000,
  );
  console.log(`\n${ticket.key} ended in ${settled.status}${settled.blockedReason ? ` (asks: ${settled.blockedReason})` : ""}`);
  for (const a of approved) console.log(`  approved ${short(a, 400)}`);
  for (const a of denied) console.log(`  denied   ${short(a, 400)}`);
  const work = await call<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript`);
  console.log("  transcript highlights:");
  for (const e of work) {
    if (e.content.type === "tool_call") console.log(`    → ${e.content.name} ${short(JSON.stringify(e.content.input))}`);
    else if (e.content.type === "tool_result" && e.content.isError) console.log(`    ✗ ${e.content.name}: ${short(JSON.stringify(e.content.output))}`);
  }
  const lastText = [...work].reverse().find((e) => e.role === "assistant" && e.content.type === "text");
  if (lastText) console.log(`    says: ${short(textOf(lastText), 300)}`);

  check("the agent ended in review", settled.status === "review", settled.status);
  check("a human approval was asked for create_watcher", approved.some((a) => a.includes("create_watcher")));
  const watchers = await call<Watcher[]>("GET", "/watchers");
  const w = watchers.find((x) => `${x.command} ${(x.args ?? []).join(" ")}`.includes("events-api.ts"));
  check("a watcher wraps the fixture loop", !!w, w ? short(w.command, 200) : `${watchers.length} watcher(s)`);
  check("the watcher is enabled", !!w?.enabled);
  check("the watcher's prompt names mark and SHOP", !!w && /mark/i.test(w.prompt ?? "") && /SHOP/.test(w.prompt ?? ""), short(w?.prompt ?? "(none)", 300));

  // Triage runs on claude-code as well: give it time for three items.
  const done = (s: Session) => s.triageStatus && s.triageStatus !== "triaging" && !s.busy;
  const sessions = await until(
    "three triaged Inbox items",
    async () => {
      const all = (await call<Session[]>("GET", "/sessions")).filter((s) => s.kind === "triage");
      return all.length >= 3 && all.every(done) ? all : undefined;
    },
    10 * 60_000,
  ).catch(async (err) => {
    console.log(`  ${(err as Error).message}`);
    return (await call<Session[]>("GET", "/sessions")).filter((s) => s.kind === "triage");
  });
  console.log("\nInbox:");
  const outcome: Record<string, string> = {};
  for (const s of sessions) {
    const entries = await call<TranscriptEntry[]>("GET", `/sessions/${s.id}/transcript`);
    const first = entries.find((e) => e.role === "user");
    const text = first ? textOf(first) : "";
    const id = text.match(/"id":"(E\d)"/)?.[1] ?? "?";
    outcome[id] = s.triageStatus ?? "?";
    check(`${s.key} (${id}) carries the watcher's prompt`, !!w?.prompt && text.includes(w.prompt));
    console.log(`  ${s.key} ${id}: ${s.triageStatus} — ${short(s.outcome ?? "", 200)}`);
  }
  check("three Inbox items, one per event", Object.keys(outcome).sort().join() === "E1,E2,E3", Object.keys(outcome).join());
  check("E1 (mark, with next steps) was dispatched", outcome.E1 === "dispatched", outcome.E1);
  check("E2 (assigned to sam) was declined", outcome.E2 === "declined", outcome.E2);
  check("E3 (mark, FYI only) was declined", outcome.E3 === "declined", outcome.E3);
  const tickets = await call<Ticket[]>("GET", "/tickets");
  const dispatched = tickets.filter((t) => t.key !== ticket.key);
  check("exactly one new ticket, in SHOP", dispatched.length === 1 && dispatched[0]!.projectId === shop.id, dispatched.map((t) => `${t.key} ${short(t.title, 80)}`).join("; "));
  const after = (await call<Watcher[]>("GET", "/watchers")).find((x) => x.id === w?.id);
  check("the watcher ran without an error", !!after?.lastRunAt && !after.lastError, after?.lastError ?? "");
} catch (err) {
  check("the check ran to the end", false, (err as Error).message);
} finally {
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
