// Acceptance run against the INSTALLED app (~/Applications/Harness.app) and the REAL service
// (~/.harness), which has to be running already (a login item, or the app's child from an open
// app). The app finds the service itself; nothing is mocked.
//
//   bun scripts/acceptance.ts [driver=dummy] [projectDir=~/Sites/hello-harness]
//
// Drives the UI: New session pane → "hello world" → watches the card go In progress → Review →
// Approve → the complete run → Done, then prints the ticket's Activity.

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
// Installs leave the dummy driver out; with it set, the app's `service ensure` rewrites the
// launchd plist to add it (a child service gets it from the app's environment), and the next
// launch without it takes it back out.
if (driver === "dummy") env.HARNESS_DUMMY_DRIVER = "1";
else delete env.HARNESS_DUMMY_DRIVER;
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
  await until("New session pane", () => exists(".draft-pane .draft-prompt"));
  // The project, then the driver (its default model) under Options, then the prompt: ⌘↩ would do, the button is the same.
  await js(`(() => { const s = document.querySelector(".draft-pane .project-picker select");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, ${JSON.stringify(project.id)}); s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await js(`document.querySelector(".draft-pane [data-testid=draft-options]").click()`);
  await until("Options", () => exists(".draft-pane [data-testid=ticket-settings] [data-testid=phase-model-select] button"));
  await js(`document.querySelector(".draft-pane [data-testid=ticket-settings] [data-testid=phase-model-select] button").click()`);
  // The driver's Default row, in every phase column, so the whole ticket runs on it.
  const optionFor = (phase: string) => `[...document.querySelectorAll(".phase-combo-row")].find(r => r.dataset.row === ${JSON.stringify(driver)} + "\u0001")?.querySelector("[role=radio][data-phase=${phase}]")`;
  await until(`driver option ${driver}`, () => js<boolean>(`!!${optionFor("work")}`));
  for (const phase of ["plan", "work", "review", "complete"]) {
    await js(`${optionFor(phase)}.click()`);
    await Bun.sleep(100);
  }
  await js(`document.querySelector(".draft-pane .draft-prompt").focus()`);
  await cdp("Input.insertText", { text: "hello world" });
  console.log("  composer state:", await js(`JSON.stringify({ value: document.querySelector(".draft-pane .draft-prompt")?.value, options: document.querySelector(".draft-pane [data-testid=draft-options-summary]")?.textContent ?? "" })`));
  const before = new Set((await api<Ticket[]>("GET", "/tickets")).filter((t) => !t.draft).map((t) => t.key));
  await until("Start session", () => clickText(".draft-pane [data-testid=draft-start]", "Start session"));
  const ticket = await until("ticket created", async () => (await api<Ticket[]>("GET", "/tickets")).find((t) => !before.has(t.key) && !t.draft));
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
  await until("spec", () => exists("[data-testid=spec-doc]"));
  await shot("2-review");

  await until("Approve", () => clickText(".actions button", "Approve"));
  console.log("✓ human approved in the UI");
  await until("ticket done", async () => (await api<TicketDetail>("GET", `/tickets/${ticket.key}`)).ticket.status === "done", driver === "dummy" ? 30000 : 300000);
  await until("card in Done", () => column("Done", ticket.key));
  console.log(`✓ ${ticket.key} is Done on the board`);
  await shot("3-done");

  const d = await api<TicketDetail>("GET", `/tickets/${ticket.key}`);
  console.log("\nActivity:\n" + d.activity.map((a) => `  [${a.author} ${a.kind}] ${a.body.replace(/\n/g, "\n    ")}`).join("\n"));
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
