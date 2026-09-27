// Acceptance run against the INSTALLED app (~/Applications/Harness.app) and the REAL launchd
// service (~/.harness). The app finds the service itself via `service ensure`; nothing is mocked.
//
//   bun scripts/acceptance.ts [driver=dummy] [projectDir=~/Sites/hello-harness]
//
// Drives the UI: composer → "hello world" → watches the card go In progress → Review →
// Approve → Complete → Done, then prints the agent's summaries.

import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Project, Ticket, TicketDetail } from "@harness/shared";
import { api as mkApi, until } from "./lib/drive";

const driver = process.argv[2] ?? "dummy";
const projectDir = process.argv[3] ?? join(homedir(), "Sites", "hello-harness");
const appBin = join(homedir(), "Applications", "Harness.app", "Contents", "MacOS", "Harness");
const base = "http://127.0.0.1:7717";
const token = readFileSync(join(homedir(), ".harness", "token"), "utf8").trim();
const api = mkApi(base, token);
const shots = join(import.meta.dir, "..", "out", "screenshots", "acceptance");
mkdirSync(shots, { recursive: true });
mkdirSync(projectDir, { recursive: true });

// The folder picker is a native dialog, so register the project over the API (same call the UI makes).
const projects = await api<Project[]>("GET", "/projects");
const project = projects.find((p) => p.path === projectDir) ?? (await api<Project>("POST", "/projects", { path: projectDir }));
console.log(`project ${project.key} → ${project.path}`);

const cdpPort = 9500 + Math.floor(Math.random() * 300);
const env = { ...process.env } as Record<string, string>;
delete env.HARNESS_URL;
delete env.HARNESS_TOKEN;
const proc = Bun.spawn([appBin, `--remote-debugging-port=${cdpPort}`], { env, stdout: "ignore", stderr: "ignore" });

const target = await until(
  "app window",
  async () => {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as any[];
      return list.find((t) => t.type === "page" && t.url.startsWith("file://"));
    } catch {}
  },
  30000,
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id) pending.get(msg.id)?.(msg);
};
const cdp = (method: string, params: object = {}) =>
  new Promise<any>((r) => {
    const n = ++id;
    pending.set(n, r);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const js = async <T = unknown>(expression: string): Promise<T> => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value as T;
const exists = (sel: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const clickText = (sel: string, text: string) =>
  js<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text)}) && !e.disabled); if (!el) return false; el.click(); return true; })()`);
const shot = async (name: string) => {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `${driver}-${name}.png`), Buffer.from(r.result.data, "base64"));
};
const column = (title: string, key: string) =>
  js<boolean>(`[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === ${JSON.stringify(title)})?.textContent.includes(${JSON.stringify(key)})`);

let failed = false;
try {
  await until("connected to the service", () => exists(".conn.on"), 45000);
  console.log("✓ app connected to the launchd service on its own");

  await js(`location.hash = ${JSON.stringify(`#/board/${project.id}`)}`);
  await js(`location.hash = "#/compose"`);
  await until("composer", () => exists(".new-session-prompt"));
  await until(`driver option ${driver}`, () => js<boolean>(`[...document.querySelectorAll(".modal-foot select option")].some(o => o.value === ${JSON.stringify(driver)})`));
  await Bun.sleep(300);
  await js(`(() => { const s = [...document.querySelectorAll(".modal-foot select")].find(s => [...s.options].some(o => o.value === ${JSON.stringify(driver)}));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(driver)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await js(`document.querySelector(".new-session-prompt").focus()`);
  await cdp("Input.insertText", { text: "hello world" });
  console.log("  composer state:", await js(`JSON.stringify({ tag: document.querySelector(".new-session-prompt")?.tagName, value: document.querySelector(".new-session-prompt")?.value, driver: [...document.querySelectorAll(".modal-foot select")].map(s => s.value) })`));
  const before = new Set((await api<Ticket[]>("GET", "/tickets")).map((t) => t.key));
  await until("Start session", () => clickText(".modal-foot button", "Start session"));
  const ticket = await until("ticket created", async () => (await api<Ticket[]>("GET", "/tickets")).find((t) => !before.has(t.key)));
  console.log(`✓ composer created ${ticket.key} (driver ${ticket.driver}, status ${ticket.status})`);

  await until("card In progress", () => column("In progress", ticket.key), 15000).catch(() => undefined);
  await shot("1-in-progress");

  const reviewed = await until(
    "agent finished + agent review",
    async () => {
      const t = (await api<TicketDetail>("GET", `/tickets/${ticket.key}`)).ticket;
      if (t.status === "blocked") return t;
      return t.status === "review" && t.agentReview !== "pending" && !t.busy ? t : undefined;
    },
    driver === "dummy" ? 30000 : 300000,
  );
  if (reviewed.status === "blocked") throw new Error(`blocked: ${reviewed.blockedReason}`);
  console.log(`✓ moved to review (agent review: ${reviewed.agentReview})`);
  await until("card in Review", () => column("Review", ticket.key));
  await js(`location.hash = ${JSON.stringify(`#/board/${project.id}/ticket/${ticket.key}`)}`);
  await until("summaries", () => exists(".summary"));
  await shot("2-review");

  await until("Approve", () => clickText(".actions button", "Approve"));
  console.log("✓ human approved in the UI");
  await until("Complete", () => clickText(".actions button", "Complete"));
  await until("complete modal", () => exists(".modal"));
  await clickText(".modal-foot button", "Complete");
  await until("ticket done", async () => (await api<TicketDetail>("GET", `/tickets/${ticket.key}`)).ticket.status === "done", driver === "dummy" ? 30000 : 300000);
  await until("card in Done", () => column("Done", ticket.key));
  console.log(`✓ ${ticket.key} is Done on the board`);
  await shot("3-done");

  const d = await api<TicketDetail>("GET", `/tickets/${ticket.key}`);
  console.log("\nSummaries:\n" + d.summaries.map((s) => `  [${s.author}] ${s.body.replace(/\n/g, "\n    ")}`).join("\n"));
  const firstReply = (await api<any[]>("GET", `/sessions/${d.session.id}/transcript`)).find((e) => e.role === "assistant" && e.content.type === "text");
  console.log(`\nAgent response: ${firstReply?.content.text}`);
} catch (err) {
  failed = true;
  console.error("✗", err instanceof Error ? err.message : err);
  await shot("failure").catch(() => {});
} finally {
  ws.close();
  proc.kill(); // closing the app must NOT stop the service
  await Bun.sleep(1000);
  const health = await fetch(base + "/health").then((r) => r.ok).catch(() => false);
  console.log(health ? "✓ service still running after the app quit" : "✗ service died with the app");
  process.exit(failed || !health ? 1 : 0);
}
