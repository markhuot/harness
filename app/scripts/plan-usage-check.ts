// The sidebar's plan-usage gauges in the built app, against the mock service (GET /usage, and PUT
// /mock/usage to push a usage.updated): rows and their colours in both modes, the ⓘ popover, the
// filter menu, an unreadable driver, the one-line Hide state, and that filter and mode persist.
// planUsage.test.ts covers the maths underneath.
//
//   bun run build && bun scripts/plan-usage-check.ts [--shots=<dir>]
import { join } from "node:path";
import { appDir, checker, launchApp, stopped, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const port = 7900 + Math.floor(Math.random() * 90);
const token = "usage-token";
const base = `http://127.0.0.1:${port}`;
const mock = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
  env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token, MOCK_QUIET: "1" },
  stdout: "ignore",
  stderr: "inherit",
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(base + "/health")).ok) break;
  } catch {}
  await Bun.sleep(100);
}
const counter = checker();
const { check } = counter;
const app = await launchApp({ baseUrl: base, token });
const { js, cdp, key, screenshot } = app;

try {
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 2, mobile: false });
  await until("usage rows", () => js<boolean>(`document.querySelectorAll('[data-testid="plan-usage-row"]').length === 3`), 15000);
  const shot = async (name: string) => shots && (await Bun.sleep(150), await screenshot(join(shots, `plan-usage-${name}.png`)));
  const rows = () =>
    js<{ w: string; cls: string; text: string; reset: string; fill: string; tick: boolean }[]>(
      `[...document.querySelectorAll('[data-testid="plan-usage-row"]')].map(r => ({ w: r.dataset.window, cls: r.className, text: r.querySelector(".plan-usage-text").textContent, reset: r.querySelector(".plan-usage-reset").textContent, fill: r.querySelector(".plan-usage-fill").style.width, tick: !!r.querySelector(".plan-usage-tick") }))`,
    );
  const clickText = (sel: string, text: string) =>
    js<boolean>(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent.includes(${JSON.stringify(text)})); el?.click(); return !!el; })()`);
  const push = (drivers: unknown) => fetch(`${base}/mock/usage`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ drivers }) });
  const t = Date.now();
  const H = 3_600_000;
  const win = (id: string, label: string, usedPercent: number, resetsIn: number, windowSeconds: number) => ({ id, label, usedPercent, resetsAt: t + resetsIn, windowSeconds });
  const claude = (windows: unknown[]) => ({ driver: "claude-code", name: "Claude Code", status: "ok", error: null, fetchedAt: t - 180_000, windows });

  // Used so far: neutral 5-hour, amber Weekly, red limited Premium requests.
  const r0 = await rows();
  check("three rows: 5-hour, Weekly, Premium requests", r0.map((r) => r.w).join() === "five_hour,seven_day,monthly", JSON.stringify(r0));
  check("5-hour is neutral with 42% used and a relative reset", r0[0]!.cls.includes("tone-neutral") && r0[0]!.text === "42% used" && /^resets in 2h 14m$/.test(r0[0]!.reset), JSON.stringify(r0[0]));
  check("Weekly at 78% is amber with a weekday reset", r0[1]!.cls.includes("tone-amber") && /^resets \w{3} /.test(r0[1]!.reset), JSON.stringify(r0[1]));
  check("Premium requests at 100% is red, full, and 'Limited until'", r0[2]!.cls.includes("tone-red") && r0[2]!.fill === "100%" && r0[2]!.reset.startsWith("Limited until"), JSON.stringify(r0[2]));
  check("the sidebar foot carries it above Settings", await js<boolean>(`(() => { const f = document.querySelector(".sidebar-foot"); return f.firstElementChild.classList.contains("plan-usage") })()`));
  check("the tooltip says when it was updated", await js<boolean>(`document.querySelector('[data-testid="plan-usage-row"]').title.includes("updated 3m ago")`));
  await shot("used");

  // ⓘ
  await js(`document.querySelector('[data-testid="plan-usage-info"]').click()`);
  await until("info popover", () => js<boolean>(`!!document.querySelector(".plan-usage-info-text")`), 3000);
  check("ⓘ explains the usage limits", await js<boolean>(`document.querySelector(".plan-usage-info-text").textContent.startsWith("How much of your plan's usage limits")`));
  await shot("info");
  await key("Escape", "Escape", 27);
  await until("info closed", () => js<boolean>(`!document.querySelector(".plan-usage-info-text")`), 3000);

  // Filter menu
  await js(`document.querySelector('[data-testid="plan-usage-menu"]').click()`);
  await until("menu", () => js<boolean>(`!!document.querySelector('[role="menuitemradio"]')`), 3000);
  check("menu offers All drivers, both drivers, Hide, and both modes", await js<boolean>(`[...document.querySelectorAll('[role="menuitemradio"]')].map(e => e.textContent.trim().replace("✓", "").trim()).join("|") === "All drivers|Claude Code|GitHub Copilot|Hide|Used so far|Projected at reset"`));
  await shot("menu");
  await clickText('[role="menuitemradio"]', "GitHub Copilot");
  await until("filtered", () => js<boolean>(`document.querySelectorAll('[data-testid="plan-usage-row"]').length === 1`), 3000);
  check("filtering to Copilot leaves its one row", (await rows())[0]!.w === "monthly");
  check("the filter is saved per device", await js<boolean>(`JSON.parse(localStorage.getItem("harness.layout")).usageFilter === "github-copilot"`));
  await js(`document.querySelector('[data-testid="plan-usage-menu"]').click()`);
  await until("menu", () => js<boolean>(`!!document.querySelector('[role="menuitemradio"]')`), 3000);
  await clickText('[role="menuitemradio"]', "All drivers");

  // Projected at reset, with a pushed usage.updated: green, amber, red, too early.
  await push([
    claude([
      win("seven_day", "Weekly", 50, 0.2 * 604800_000, 604800), // 80% gone → 63%: green
      win("seven_day_opus", "Weekly · Opus", 46, 0.5 * 604800_000, 604800), // 92%: amber
      win("seven_day_sonnet", "Weekly · Sonnet", 50, 0.75 * 604800_000, 604800), // 200%: red
      win("five_hour", "5-hour", 2, 4.8 * H, 18000), // 4% gone: too early
    ]),
  ]);
  await until("pushed rows", () => js<boolean>(`document.querySelectorAll('[data-testid="plan-usage-row"]').length === 4`), 5000);
  await js(`document.querySelector('[data-testid="plan-usage-menu"]').click()`);
  await until("menu", () => js<boolean>(`!!document.querySelector('[role="menuitemradio"]')`), 3000);
  await clickText('[role="menuitemradio"]', "Projected at reset");
  await until("projected", () => js<boolean>(`!!document.querySelector(".plan-usage-tick")`), 3000);
  const p = await rows();
  check("projected: 50% used 80% through the week is 'on pace for 63%', green, with the tick", p[0]!.text === "on pace for 63% · 50% used" && p[0]!.cls.includes("tone-green") && p[0]!.tick, JSON.stringify(p[0]));
  check("projected: 92% is amber", p[1]!.cls.includes("tone-amber") && p[1]!.text.startsWith("on pace for 92%"), JSON.stringify(p[1]));
  check("projected: 200% is red and fills the bar", p[2]!.cls.includes("tone-red") && p[2]!.fill === "100%", JSON.stringify(p[2]));
  check("the first 10% of a window shows used so far, 'too early to project', no tick", p[3]!.text === "2% used · too early to project" && !p[3]!.tick && p[3]!.fill === "2%", JSON.stringify(p[3]));
  check("63% projected fills 1.2 × 62.5 − 40 = 35% of the bar", Math.abs(parseFloat(p[0]!.fill) - 35) < 0.5, p[0]!.fill);
  check("the accessibility label says how far through the week", await js<boolean>(`document.querySelector('[data-testid="plan-usage-row"]').title.includes("80% of the week gone")`));
  check("the mode is saved per device", await js<boolean>(`JSON.parse(localStorage.getItem("harness.layout")).usageMode === "projected"`));
  await shot("projected");
  await js(`document.querySelector('[data-testid="plan-usage-info"]').click()`);
  await until("info", () => js<boolean>(`!!document.querySelector(".plan-usage-info-text")`), 3000);
  check("projected mode adds its sentence to ⓘ", await js<boolean>(`document.querySelector(".plan-usage-info-text").textContent.includes("The tick marks using exactly 100% by the reset.")`));
  await key("Escape", "Escape", 27);

  // A window already at 100% is red and Limited until, even in Projected.
  await push([claude([win("five_hour", "5-hour", 100, 2 * H, 18000)])]);
  await until("limited", () => js<boolean>(`document.querySelector(".plan-usage-reset")?.textContent.startsWith("Limited until")`), 5000);
  check("100% used in Projected mode is red with no tick", (await rows())[0]!.cls.includes("tone-red") && !(await rows())[0]!.tick);

  // Unreadable driver: the reason, no bar.
  await push([{ driver: "claude-code", name: "Claude Code", status: null, error: "Sign in to Claude Code to see plan usage", fetchedAt: t, windows: [] }]);
  await until("note", () => js<boolean>(`!!document.querySelector('[data-testid="plan-usage-note"]')`), 5000);
  check("an unreadable driver shows its reason and no bar", (await js<string>(`document.querySelector('[data-testid="plan-usage-note"]').textContent`)) === "Sign in to Claude Code to see plan usage" && (await rows()).length === 0);
  await shot("unreadable");

  // Hide collapses to a one-line header.
  await push([claude([win("five_hour", "5-hour", 42, 2 * H, 18000)])]);
  await until("row", () => js<boolean>(`document.querySelectorAll('[data-testid="plan-usage-row"]').length === 1`), 5000);
  await js(`document.querySelector('[data-testid="plan-usage-menu"]').click()`);
  await until("menu", () => js<boolean>(`!!document.querySelector('[role="menuitemradio"]')`), 3000);
  await clickText('[role="menuitemradio"]', "Hide");
  await until("hidden", () => js<boolean>(`document.querySelectorAll('[data-testid="plan-usage-row"]').length === 0`), 3000);
  check("Hide leaves the header with its menu", await js<boolean>(`!!document.querySelector('.plan-usage-head [data-testid="plan-usage-menu"]') && document.querySelector(".plan-usage").children.length === 1`));
  await shot("hidden");

  // No plan anywhere: no section.
  await push([]);
  await until("gone", () => js<boolean>(`!document.querySelector('[data-testid="plan-usage"]')`), 5000);
  check("no drivers with a plan means no section", true);
} catch (e) {
  check("run", false, (e as Error).message);
} finally {
  await app.close();
  mock.kill();
  await stopped(mock);
}
console.log(counter.failures ? `${counter.failures} failed` : "all plan usage checks passed");
process.exit(counter.failures ? 1 : 0);
