// The ticket header's context gauge against the mock service: the dial, its label and miss badge,
// the menu (Compact / New session / Limit…, the miss row, the ⓘ texts), the busy and compacting
// states, the estimated gauge, and the limit saved to Settings. A screenshot of each state.
//
//   bun run build && bun scripts/context-gauge-check.ts [screenshotDir] [--theme=dark]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots", "context-gauge"));
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
mkdirSync(shots, { recursive: true });

const port = 7700 + Math.floor(Math.random() * 90);
const token = "gauge-token";
const base = `http://127.0.0.1:${port}`;
const mock = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
  env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token, MOCK_QUIET: "1" },
  stdout: "ignore",
  stderr: "inherit",
});

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  await Bun.sleep(400);
  await app!.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const api = makeApi(base, token);
  app = await launchApp({ baseUrl: base, token, theme });
  const { js, exists, go, type } = app;
  const open = async (key: string) => {
    await go(`#/board/all/ticket/${key}`);
    await until(`${key} header`, () => js<boolean>(`document.querySelector("[data-testid=detail-key]")?.textContent.includes(${JSON.stringify(key)}) && !!document.querySelector("[data-testid=context-gauge]")`), 10000);
  };
  const text = (sel: string) => js<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim() ?? ""`);
  const attr = (sel: string, a: string) => js<string | null>(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(a)}) ?? null`);
  const menuTexts = () => js<string[]>(`[...document.querySelectorAll(".gauge-menu [role=menuitem]")].map(b => b.textContent.trim())`);
  const openMenu = async () => {
    await js(`document.querySelector("[data-testid=context-gauge]").click()`);
    await until("gauge menu", () => exists(".gauge-menu"));
  };
  const closeMenu = async () => {
    await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await until("menu closed", async () => !(await exists(".gauge-menu")));
  };
  const disabled = (testid: string) => js<boolean>(`document.querySelector("[data-testid=${testid}]")?.disabled === true`);

  // Normal: 82k of the default 250k, no badge, no spinner.
  await open("HARNESS-901");
  check("normal gauge reads 82k", (await text("[data-testid=gauge-label]")) === "82k", await text("[data-testid=gauge-label]"));
  check("…titled with the cached/fresh split", (await attr("[data-testid=context-gauge]", "aria-label")) === "Context 82k of 250k: 61k cached, 21k fresh");
  check("…no miss badge", !(await exists("[data-testid=gauge-miss-badge]")));
  check("…not red", (await attr("[data-testid=context-gauge]", "data-over")) === null);
  check("…the prefix tick is on the dial", await exists("[data-testid=gauge-prefix]"));
  await shot("normal");
  await openMenu();
  check("menu: Compact, New session, Limit…", (await menuTexts()).map((t) => t.replace(/\s+/g, " ")).join("|") === "Compact|New session|Limit… 250k", (await menuTexts()).join("|"));
  check("…no miss row without misses", !(await exists("[data-testid=gauge-miss-row]")));
  await js(`document.querySelector("[data-testid=gauge-info]").click()`);
  await until("info text", () => exists("[data-testid=gauge-info-text]"));
  check("the gauge ⓘ explains slate, amber and the tick", /Slate is read from the prompt cache/.test(await text("[data-testid=gauge-info-text]")));
  await shot("info");
  await closeMenu();

  // Over the limit, with misses.
  await open("HARNESS-902");
  check("over-limit gauge reads 320k and is red", (await text("[data-testid=gauge-label]")) === "320k" && (await attr("[data-testid=context-gauge]", "data-over")) === "true");
  check("miss badge says 3 misses", (await text("[data-testid=gauge-miss-badge]")) === "3 misses", await text("[data-testid=gauge-miss-badge]"));
  await openMenu();
  check("miss row reads 3 cache misses (377k tokens re-written)", (await text("[data-testid=gauge-miss-row] .gauge-miss-text span")) === "3 cache misses (377k tokens re-written)", await text("[data-testid=gauge-miss-row] .gauge-miss-text span"));
  await js(`document.querySelector("[data-testid=gauge-miss-info]").click()`);
  await until("miss info", () => exists("[data-testid=gauge-miss-info-text]"));
  check("the miss ⓘ names CLAUDE_CODE_PROMPT_CACHE_TTL", (await text("[data-testid=gauge-miss-info-text]")).includes("CLAUDE_CODE_PROMPT_CACHE_TTL=1h"));
  await shot("misses-menu");
  await js(`document.querySelector("[data-testid=gauge-miss-link]").click()`);
  await until("Settings → Drivers", () => js<boolean>(`location.hash.startsWith("#/settings")`));
  check("the miss row links to Settings' Drivers section", (await js<string>(`location.hash`)).includes("drivers"), await js<string>(`location.hash`));

  // Limit…: validated, saved through Settings, and the gauge follows.
  await open("HARNESS-902");
  await openMenu();
  await js(`document.querySelector("[data-testid=gauge-limit]").click()`);
  await until("limit modal", () => exists("[data-testid=gauge-limit-modal]"));
  await type("[data-testid=gauge-limit-input]", "5000");
  check("a limit under 10k is refused and Save is off", (await exists("[data-testid=gauge-limit-error]")) && (await disabled("gauge-limit-save")));
  await type("[data-testid=gauge-limit-input]", "400k");
  check("400k is accepted", !(await exists("[data-testid=gauge-limit-error]")) && !(await disabled("gauge-limit-save")));
  await js(`document.querySelector("[data-testid=gauge-limit-save]").click()`);
  await until("modal closed", async () => !(await exists("[data-testid=gauge-limit-modal]")));
  check("the service saved the limit", (await api<{ contextGaugeLimit?: number }>("GET", "/settings")).contextGaugeLimit === 400_000);
  await until("gauge under the new limit", async () => (await attr("[data-testid=context-gauge]", "data-over")) === null);
  check("320k is no longer red under a 400k limit", true);
  await api("PATCH", "/settings", { contextGaugeLimit: 250_000 });

  // Estimated (github-copilot): ~82k*, one tone, no misses, its own ⓘ.
  await open("HARNESS-904");
  check("estimated gauge reads ~82k*", (await text("[data-testid=gauge-label]")) === "~82k*", await text("[data-testid=gauge-label]"));
  check("…titled as an estimate", (await attr("[data-testid=context-gauge]", "aria-label")) === "Context about 82k of 250k (estimated from word count)");
  await openMenu();
  check("copilot offers New session but not Compact", (await menuTexts()).every((t) => !t.startsWith("Compact")) && (await menuTexts()).some((t) => t.startsWith("New session")));
  await js(`document.querySelector("[data-testid=gauge-info]").click()`);
  await until("estimate info", () => exists("[data-testid=gauge-info-text]"));
  check("…and explains that Copilot doesn't report tokens", (await text("[data-testid=gauge-info-text]")) === "Estimated from the conversation's word count; Copilot doesn't report tokens.");
  await shot("estimated");
  await closeMenu();

  // Fresh session.
  await open("HARNESS-905");
  check("a fresh session shows New", (await text("[data-testid=gauge-label]")) === "New");

  // A run is going: Compact and New session are greyed with the hint; Limit… still works.
  await open("HARNESS-906");
  await openMenu();
  check("busy: Compact and New session are disabled", (await disabled("gauge-compact")) && (await disabled("gauge-new")));
  check("…with Available when the run ends", (await text("[data-testid=gauge-compact]")).includes("Available when the run ends"));
  check("…and Limit… still enabled", !(await disabled("gauge-limit")));
  await closeMenu();

  // Compacting: spinner for the needle, gauge menu and the header's actions off, composer says so.
  await open("HARNESS-903");
  check("compacting: spinner instead of the needle", (await exists("[data-testid=gauge-spinner]")) && !(await exists(".gauge-needle")));
  check("…the gauge button is disabled", await disabled("context-gauge"));
  check("…every action in the header is disabled", await js<boolean>(`[...document.querySelectorAll("[data-testid=ticket-actions] button")].every(b => b.matches(":disabled"))`));
  check("…the composer is disabled and says Compacting…", await js<boolean>(`(() => { const t = document.querySelector("[data-testid=composer] textarea"); return !!t && t.disabled && t.placeholder === "Compacting…"; })()`));
  check("…with a spinner and Send off", (await exists("[data-testid=composer-compacting]")) && (await disabled("composer-send")));
  await shot("compacting");

  // New session confirms first, then clears the context (mock route).
  await open("HARNESS-901");
  await openMenu();
  await js(`document.querySelector("[data-testid=gauge-new]").click()`);
  await until("confirm", () => exists("[data-testid=gauge-new-modal]"));
  check("New session asks first and nothing changed yet", (await text("[data-testid=gauge-label]")) === "82k");
  await js(`document.querySelector("[data-testid=gauge-new-confirm]").click()`);
  await until("session cleared", async () => (await text("[data-testid=gauge-label]")) === "New");
  check("confirming clears the gauge to New", true);

  // A refusal (409) is an error toast, not a crash: the ticket is busy server-side.
  let refused = "";
  try {
    await api("POST", "/tickets/HARNESS-906/session", { action: "new" });
  } catch (e) {
    refused = String(e);
  }
  check("the service refuses a session action while busy (409)", refused.includes("run is going"), refused);

  // Settings carries the same limit.
  await go("#/settings/general");
  await until("settings", () => js<boolean>(`document.body.textContent.includes("Context gauge limit")`), 10000);
  check("Settings has a Context gauge limit field", true);
} catch (e) {
  console.error(e);
  c.fail();
} finally {
  await app?.close();
  mock.kill();
  await mock.exited;
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall checks passed");
process.exit(c.failures ? 1 : 0);
