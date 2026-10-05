// Browser size controls end-to-end against a REAL daemon and real headless Chrome (temp HARNESS_HOME,
// random port; never ~/.harness). The test page reports its own viewport and pointer type in its
// title, so every check reads what the page actually got: Desktop, Mobile, Mobile at 1280 × 800,
// Responsive (and that the pane drives nothing without it), and a click on a small link while the
// frame is pinch-zoomed.
//
//   bun run build && bun scripts/browser-size-real.ts [screenshotDir]
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "browser-size-real"));
mkdirSync(shots, { recursive: true });
const home = tempDir("harness-size-home-");
const projectDir = tempDir("harness-size-project-");
const port = 7900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;

// The link sits at page (628–652, 393–407): 24 × 14 CSS px, small enough that a click mapped
// through the wrong rect misses it.
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>…</title>
<body style="margin:0;height:100vh;background:linear-gradient(135deg,#fde68a,#93c5fd)">
<a id="l" href="/clicked" style="position:absolute;left:628px;top:393px;width:24px;height:14px;background:#c33"></a>
<script>// The layout viewport: on Mobile, Chrome zooms out to fit the link (past 393), which innerWidth would report.
const t = () => document.title = document.documentElement.clientWidth + "x" + document.documentElement.clientHeight + " " + (matchMedia("(pointer: coarse)").matches ? "coarse" : "fine");
t(); addEventListener("resize", t);</script>`;
const pages = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => new Response(new URL(req.url).pathname === "/clicked" ? "<title>clicked</title>clicked" : PAGE, { headers: { "content-type": "text/html" } }),
});

const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "5" },
  stdout: "inherit",
  stderr: "inherit",
});

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "size", key: "SIZE" });
  app = await launchApp({ baseUrl: base, token });
  const a = app;
  const { js, cdp } = a;
  const shot = (name: string) => a.screenshot(join(shots, `${name}.png`));
  await until("app connected", () => a.exists(".conn.on"), 15000);

  const calls = [{ name: "browser_open", input: { url: `http://127.0.0.1:${pages.port}/` } }];
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `/tools ${JSON.stringify(calls)}`, driver: "dummy", start: true });
  await a.go(`#/board/${project.id}/ticket/${ticket.key}/browser`);
  await until("size controls", () => a.exists("[data-testid=browser-responsive]"), 30000);

  const title = () => js<string>(`document.querySelector(".browser-title")?.textContent ?? ""`);
  const titleIs = (want: string | RegExp) =>
    until(`page title ${want}`, async () => (typeof want === "string" ? (await title()) === want : want.test(await title())), 15000).then(
      () => true,
      () => false,
    );
  const click = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const look = () => js<string>(`document.querySelector("[data-testid=browser-responsive]").className.split(" ").pop()`);
  const stage = () => js<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector(".browser-stage").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const enterSide = async (label: "Width" | "Height", value: string) => {
    await a.type(`[aria-label=${label}]`, value);
    await a.key("Enter", "Enter", 13);
  };

  // 1. A new tab is Desktop 1280 × 800, and opening the (narrower) pane doesn't resize it.
  check("the page opens at Desktop 1280 × 800 with a fine pointer", await titleIs("1280x800 fine"), await title());
  await Bun.sleep(1500);
  check("the pane leaves it at 1280 × 800 without Responsive", (await title()) === "1280x800 fine", `${await title()} (stage ${JSON.stringify(await stage())})`);
  await shot("1-desktop");

  // 2. Mobile: 393 × 852 with a coarse pointer.
  await click("[data-testid=browser-device-mobile]");
  check("Mobile lays the page out at 393 × 852 with a coarse pointer", await titleIs("393x852 coarse"), await title());
  await Bun.sleep(600);
  await shot("2-mobile");

  // 3. Mobile at 1280 × 800: still touch.
  await enterSide("Width", "1280");
  await enterSide("Height", "800");
  check("Mobile at 1280 × 800 keeps the coarse pointer", await titleIs("1280x800 coarse"), await title());
  await Bun.sleep(600);
  await shot("3-mobile-1280x800");

  // 4. Responsive: the page follows this pane, and only while it's on.
  await click("[data-testid=browser-device-desktop]");
  check("Desktop resets to 1280 × 800 fine", await titleIs("1280x800 fine"), await title());
  await click("[data-testid=browser-responsive]");
  let s = await stage();
  check("Responsive lays the page out at the pane's size", (await titleIs(`${Math.round(s.w)}x${Math.round(s.h)} fine`)) && (await look()) === "owned", `${await title()} vs ${Math.round(s.w)}x${Math.round(s.h)}`);
  await js(`document.querySelector(".browser-stage").style.marginRight = "160px"`);
  s = await stage();
  check("…and follows it as the pane changes", await titleIs(`${Math.round(s.w)}x${Math.round(s.h)} fine`), `${await title()} vs ${Math.round(s.w)}x${Math.round(s.h)}`);
  await Bun.sleep(600);
  await shot("4-responsive");

  // 5. Editing width × height turns Responsive off; the pane stops driving the page.
  await enterSide("Width", "1000");
  check("editing the width switches Responsive off", await until("off", async () => (await look()) === "off").then(() => true, () => false));
  await js(`document.querySelector(".browser-stage").style.marginRight = "0px"`);
  await Bun.sleep(1500);
  check("…and the page keeps 1000 wide as the pane changes", /^1000x\d+ fine$/.test(await title()), await title());

  // 6. Pinch-zoom on the link, then click it while zoomed.
  await click("[data-testid=browser-device-desktop]");
  check("back to Desktop 1280 × 800", await titleIs("1280x800 fine"), await title());
  await Bun.sleep(800);
  s = await stage();
  const scale = Math.min(s.w / 1280, s.h / 800);
  const lx = s.x + (s.w - 1280 * scale) / 2 + 640 * scale;
  const ly = s.y + (s.h - 800 * scale) / 2 + 400 * scale;
  for (let i = 0; i < 8; i++) await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: lx, y: ly, deltaX: 0, deltaY: -20, modifiers: 2 });
  const pct = await until("zoomed", () => js<string | null>(`document.querySelector(".browser-zoom")?.textContent ?? null`)).catch(() => null);
  check("a pinch zooms the frame", !!pct && Number(pct.replace("%", "")) > 200, String(pct));
  check("…without zooming or resizing the page", (await title()) === "1280x800 fine", await title());
  await Bun.sleep(600);
  await shot("6-zoomed-on-link");
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: lx, y: ly });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: lx, y: ly, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: lx, y: ly, button: "left", clickCount: 1 });
  check("clicking the 24 × 14 link while zoomed follows it", await titleIs("clicked"), `${await title()} ${await js<string>(`document.querySelector(".browser-url-input").value`)}`);} catch (e) {
  c.fail();
  console.error("✗", (e as Error).stack ?? (e as Error).message);
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  await app?.close();
  daemon.kill();
  await daemon.exited;
  pages.stop(true);
  cleanupTempDirs();
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall real browser size checks passed");
process.exit(c.failures ? 1 : 0);
