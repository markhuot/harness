// Integration against the REAL service: boots service/src/daemon.ts with a throwaway
// HARNESS_HOME (never ~/.harness), launches the built app against it, and walks a dummy-driver
// ticket through the whole lifecycle in the UI, plus a /browse ticket for the live browser tab and a
// worktree ticket for the git plugin's Changes tab.
//
//   bun run build && bun scripts/real-service.ts [screenshotDir] [--theme=dark]
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Project, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";
import { checkChangesTab } from "./lib/changes-check";

const shots = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots", "real"));
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
mkdirSync(shots, { recursive: true });

const home = mkdtempSync(join(tmpdir(), "harness-real-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "harness-real-project-"));
const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DELAY_MS: process.env.HARNESS_DUMMY_DELAY_MS ?? "70" },
  stdout: "inherit",
  stderr: "inherit",
});

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
let changesRepo: string | null = null;
const shot = async (name: string) => {
  await Bun.sleep(350); // let fade-in animations settle
  await app!.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "hello", key: "HELLO" });

  app = await launchApp({ baseUrl: base, token, theme });
  const { js, exists, type, cmdEnter, clickText, go } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("hello")`), 10000);
  check("connected to the real service", await exists(".conn.on"));

  // --- 1. New session from the composer, dummy driver, start immediately.
  await go(`#/board/${project.id}`);
  await go("#/compose");
  await until("composer", () => exists(".new-session-prompt"));
  await js(`(() => { const s = [...document.querySelectorAll(".modal-foot select")][0];
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, "dummy");
    s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await type(".new-session-prompt", "hello world");
  await cmdEnter();
  const created = await until("ticket created", async () => (await api<Ticket[]>("GET", "/tickets")).find((t) => t.description.includes("hello world")));
  check("composer created a dummy ticket", created.driver === "dummy", `${created.key} driver=${created.driver}`);

  // --- 2. Live stream with caret while in progress.
  await go(`#/board/${project.id}/ticket/${created.key}/transcript`);
  const streamed = await until("streaming caret", async () => (await exists(".t-assistant.streaming .caret")) && (await js<string>(`document.querySelector(".t-assistant.streaming")?.textContent ?? ""`)), 15000);
  check("assistant text streams with a caret", streamed.includes("Hello"), streamed.slice(0, 60));
  await shot("1-streaming");
  const cardInProgress = await js<boolean>(
    `[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "In progress")?.textContent.includes(${JSON.stringify(created.key)})`,
  );
  check("card sits in In progress while working", cardInProgress);

  // --- 3. Moves to Review by itself; agent review approves.
  await until("agent review approved", async () => {
    const t = (await api<TicketDetail>("GET", `/tickets/${created.key}`)).ticket;
    return t.status === "review" && t.agentReview === "approved" && !t.busy;
  }, 30000);
  const inReview = await until("card in Review column", () =>
    js<boolean>(`[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Review")?.textContent.includes(${JSON.stringify(created.key)})`),
  );
  check("card moved to Review live", inReview);
  const persisted = await until("streamed text replaced by entry", async () => !(await exists(".t-assistant.streaming")) && (await exists(".t-assistant")));
  check("streaming preview replaced by the persisted message", persisted);
  const toolRows = await js<string[]>(`[...document.querySelectorAll(".t-tool-name")].map(e => e.textContent)`);
  check("tool calls render in the transcript", toolRows.some((n) => /submit_for_review|post_summary/.test(n)), toolRows.join(","));
  await shot("2-transcript");

  // --- 4. Summaries tab, then Approve → the complete run starts by itself (autoComplete) → Done.
  await go(`#/board/${project.id}/ticket/${created.key}`);
  await until("summaries", () => exists(".summary"));
  const summaryText = await js<string>(`document.querySelector(".summary-list")?.textContent ?? ""`);
  check("agent summaries render", summaryText.length > 10, summaryText.slice(0, 80));
  await shot("3-review");
  check("Approve clicked", await until("Approve button", () => clickText(".actions button", "Approve")));
  const done = await until("ticket done", async () => (await api<TicketDetail>("GET", `/tickets/${created.key}`)).ticket.status === "done", 30000);
  check("approving runs the complete agent step by itself and lands in Done", done);
  const runs = (await api<TicketDetail>("GET", `/tickets/${created.key}`)).runs.map((r) => r.kind);
  check("the complete run followed the approval", runs.at(-1) === "complete", runs.join(","));
  const inDone = await until("card in Done", () =>
    js<boolean>(`[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Done")?.textContent.includes(${JSON.stringify(created.key)})`),
  );
  check("card moved to Done live", inDone);
  check("composer hidden once done", !(await exists(".composer")));
  await shot("5-done");

  // --- 5. Browser: a /browse ticket drives real headless Chrome; JPEG frames render.
  const browse = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: "/browse https://example.com", driver: "dummy", start: true });
  await go(`#/board/${project.id}/ticket/${browse.key}/browser`);
  const frame = await until(
    "browser frame drawn",
    () => js<boolean>(`(() => { const c = document.querySelector(".browser-canvas"); if (!c || !c.width) return false;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0, dark = 0;
      for (let i = 0; i < d.length; i += 4 * 101) { if (d[i + 3] > 0) n++; if (d[i + 3] > 0 && d[i] < 100) dark++; }
      return n > 50 && dark > 5; })()`),
    45000,
  ).catch(() => false);
  const url = await js<string>(`document.querySelector(".browser-url-input")?.value ?? ""`);
  const stats = await js<object>(`window.__harnessBrowser`);
  check("real Chrome JPEG screencast draws on the canvas (with dark text pixels)", !!frame, `${url} ${JSON.stringify(stats)}`);
  check("waiting/empty state gone once a frame arrives", !(await exists(".browser-empty")));
  await Bun.sleep(800);
  await shot("6-browser");
  const transcript = await api<TranscriptEntry[]>("GET", `/sessions/${browse.sessionId}/transcript?after=0`);
  check("agent's browser tools ran", transcript.some((e) => e.content.type === "tool_call" && e.content.name.includes("browser_open")));

  // --- 6. Git plugin: a worktree ticket edits files via /bash; the Changes tab (plugin iframe) shows them.
  changesRepo = (await checkChangesTab({ api, app, check, shot })).repo;

  await go(`#/board/${project.id}`);
  await Bun.sleep(600);
  await shot("7-board");
} catch (e) {
  c.fail();
  console.error("✗", (e as Error).message);
  if (app) await shot("failure").catch(() => {});
} finally {
  app?.close();
  daemon.kill();
  await daemon.exited;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  if (changesRepo) rmSync(changesRepo, { recursive: true, force: true });
}
console.log(c.failures ? `${c.failures} check(s) failed` : "all checks passed");
process.exit(c.failures ? 1 : 0);
