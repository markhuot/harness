// Spec headings in the built app, against the REAL service (throwaway HARNESS_HOME): H1–H4 render
// at four strictly decreasing sizes, a heading after other content keeps its large top margin, and a
// heading straight after another heading (an H2 + H3 pair) sits close to it instead.
//
//   bun run build && bun scripts/spec-headings-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-headings-home-");
const projectDir = tempDir("harness-headings-project-");
Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: projectDir });

const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1" },
  stdout: "ignore",
  stderr: "inherit",
});

const counter = checker();
const { check } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "headings", key: "HEAD" });
  const spec = [
    "# Heading one",
    "Paragraph under the H1.",
    "## Heading two",
    "### Heading three straight after the H2",
    "Paragraph under the H3.",
    "#### Heading four",
    "Closing paragraph.",
  ].join("\n\n");
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec, driver: "dummy", start: false });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, go } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("headings")`), 10000);
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("the spec's headings render", () => js<number>(`document.querySelectorAll(".spec-doc .md h1, .spec-doc .md h2, .spec-doc .md h3, .spec-doc .md h4").length`).then((n) => n >= 4 && n), 10000);

  const m = await js<{ tag: string; size: number; marginTop: number }[]>(`[...document.querySelectorAll(".spec-doc .md h1, .spec-doc .md h2, .spec-doc .md h3, .spec-doc .md h4")].slice(0, 4).map((h) => {
    const s = getComputedStyle(h);
    return { tag: h.tagName, size: parseFloat(s.fontSize), marginTop: parseFloat(s.marginTop) };
  })`);
  const by = Object.fromEntries(m.map((h) => [h.tag, h]));
  check("all four heading levels render", m.length === 4, JSON.stringify(m));
  check("H1 > H2 > H3 > H4 in size", by.H1!.size > by.H2!.size && by.H2!.size > by.H3!.size && by.H3!.size > by.H4!.size, m.map((h) => `${h.tag}=${h.size}`).join(" "));
  check("a heading after a paragraph keeps its large top margin", by.H2 === undefined || by.H2.marginTop >= by.H2.size, `H2 margin ${by.H2?.marginTop}`);
  check("a heading straight after a heading sits close (H3 after H2)", by.H3!.marginTop <= 8, `H3 margin ${by.H3?.marginTop}`);
  check("a heading after a paragraph keeps its large top margin (H4 after H3's paragraph)", by.H4!.marginTop >= by.H4!.size, `H4 margin ${by.H4?.marginTop}`);

  if (shots) {
    await js(`document.querySelector(".spec-doc")?.scrollIntoView()`);
    await Bun.sleep(400);
    await app.screenshot(join(shots, `spec-headings-${theme}.png`));
  }
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall spec heading checks passed");
process.exit(counter.failures ? 1 : 0);
