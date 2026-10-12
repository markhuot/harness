// The ticket settings' Pull requests row in the built app, against the REAL service (throwaway
// HARNESS_HOME): in a narrow panel each pull request is one line whose title is cut with an
// ellipsis, and the add field, its buttons and the hint stay on one line too. The panel is
// narrowed in place and one title is swapped for a long one, since titles come from GitHub.
//
//   bun run build && bun scripts/ticket-settings-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-settings-home-");
const projectDir = tempDir("harness-settings-project-");
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

const longTitle = "Split the secrets out of checkout and move the payment webhooks behind the queue so retries stop double charging";

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "settings", key: "PRS" });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Spec.", driver: "dummy", start: false });
  await api<Ticket>("PATCH", `/tickets/${ticket.key}`, {
    pullRequestUrls: ["https://github.com/acme/app/pull/318", "https://github.com/acme/app/pull/319"],
  });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, go } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("settings")`), 10000);
  await go(`#/board/${project.id}/ticket/${ticket.key}/details`);
  await until("the pull request rows render", () => js<number>(`document.querySelectorAll("[data-testid=pull-request-item]").length`).then((n) => n >= 2 && n), 10000);

  await js(`(() => {
    document.querySelector("[data-testid=ticket-settings]").style.width = "300px";
    document.querySelector("[data-testid=pull-request-title]").textContent = ${JSON.stringify(longTitle)};
  })()`);

  const m = await js<{ rows: number; rowHeights: number[]; titleTruncated: boolean; textOverflow: string; whiteSpace: string; addHeight: number; hintHeight: number; spills: boolean }>(`(() => {
    const items = [...document.querySelectorAll("[data-testid=pull-request-item]")];
    const title = document.querySelector("[data-testid=pull-request-title]");
    const addRow = document.querySelector(".pull-requests-add");
    const hint = document.querySelector(".pull-requests-hint");
    const dd = document.querySelector("[data-testid=pull-requests]");
    const s = getComputedStyle(title);
    return {
      rows: items.length,
      rowHeights: items.map((el) => el.getBoundingClientRect().height),
      titleTruncated: title.scrollWidth > title.clientWidth,
      textOverflow: s.textOverflow,
      whiteSpace: s.whiteSpace,
      addHeight: addRow.getBoundingClientRect().height,
      hintHeight: hint.getBoundingClientRect().height,
      spills: dd.scrollWidth > dd.clientWidth + 1,
    };
  })()`);
  check("both pull requests are listed", m.rows === 2, `rows ${m.rows}`);
  check("each pull request sits on one line", m.rowHeights.every((h) => h <= 26), `heights ${m.rowHeights.map((h) => Math.round(h)).join(" ")}`);
  check("a long title is cut with an ellipsis, not wrapped", m.titleTruncated && m.textOverflow === "ellipsis" && m.whiteSpace === "nowrap", `overflow ${m.textOverflow}, white-space ${m.whiteSpace}, truncated ${m.titleTruncated}`);
  check("the add field and its buttons share one line", m.addHeight <= 32, `height ${Math.round(m.addHeight)}`);
  check("the hint stays on one line", m.hintHeight <= 20, `hint height ${Math.round(m.hintHeight)}`);
  check("nothing spills past the panel", !m.spills, `spills ${m.spills}`);

  if (shots) {
    await js(`document.querySelector("[data-testid=pull-requests]")?.scrollIntoView({ block: "center" })`);
    await Bun.sleep(400);
    await app.screenshot(join(shots, `ticket-settings-${theme}.png`));
  }
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall ticket settings checks passed");
process.exit(counter.failures ? 1 : 0);
