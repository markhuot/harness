// The Details tab's Agent notes field against the seeded world (the real daemon): collapsed on open, expanded and
// collapsed by its toggle, hidden on a ticket with no notes. A screenshot of each state.
//
//   bun run build && bun scripts/agent-notes-check.ts [screenshotDir] [--theme=dark]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootWorld } from "./lib/world";
import { appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots", "agent-notes"));
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
mkdirSync(shots, { recursive: true });

const world = await bootWorld();
const { base, token } = world;

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  await Bun.sleep(400);
  await app!.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  app =await launchApp({ baseUrl: base, token, theme });
  const { js, exists, go } = app;
  const openDetails = async (key: string) => {
    await go(`#/board/all/ticket/${key}/details`);
    await until(`${key} details`, () => js<boolean>(`document.querySelector("[data-testid=detail-key]")?.textContent.includes(${JSON.stringify(key)}) === true`), 10000);
  };
  const toggle = `document.querySelector("[data-testid=agent-notes] .agent-notes-toggle")`;
  const expanded = () => js<string | null>(`${toggle}?.getAttribute("aria-expanded") ?? null`);

  // NYTIMES-1 has agent notes in the seeded world.
  await openDetails("NYTIMES-1");
  await until("agent-notes field", () => exists("[data-testid=agent-notes]"), 10000);
  check("the notes field is collapsed on open", (await expanded()) === "false", String(await expanded()));
  check("…with its body hidden", !(await exists("[data-testid=agent-notes] .agent-notes")));
  await shot("collapsed");

  await js(`${toggle}.click()`);
  await until("notes expanded", () => exists("[data-testid=agent-notes] .agent-notes"), 5000);
  check("the toggle expands the notes", (await expanded()) === "true", String(await expanded()));
  check("…showing the rendered notes", await js<boolean>(`document.querySelector("[data-testid=agent-notes] .agent-notes")?.textContent.includes("Where things live") === true`));
  await shot("expanded");

  await js(`${toggle}.click()`);
  await until("notes collapsed again", async () => !(await exists("[data-testid=agent-notes] .agent-notes")), 5000);
  check("the toggle collapses the notes again", (await expanded()) === "false", String(await expanded()));

  // A ticket without notes has no field at all. NYTIMES-2 is in planning and has none.
  await openDetails("NYTIMES-2");
  await until("NYTIMES-2 details", () => js<boolean>(`document.querySelector("[data-testid=detail-key]")?.textContent.includes("NYTIMES-2") === true`), 10000);
  check("a ticket with no notes shows no Agent notes field", !(await exists("[data-testid=agent-notes]")));
} catch (e) {
  console.error(e);
  c.fail();
} finally {
  await app?.close();
  await world.stop();
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall checks passed");
process.exit(c.failures ? 1 : 0);
