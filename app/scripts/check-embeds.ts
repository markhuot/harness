// The real Mac app with page attachments in a spec (DESIGN.md "Embedded pages"), checked end to end:
// a throwaway service (dummy driver) whose ticket's agent embeds five pages through update_spec, and
// the built app against it over DevTools. It asserts what only the real Electron can show:
//
//   - each page loads through the harness-embed: scheme, with relative assets and a CDN script;
//   - the embed follows a page's height as it grows, and a removed page shows the placeholder;
//   - inside an embed, window.parent, the API without the token, a climb out of /embeds/<id>/,
//     every permission (camera, notifications, geolocation, clipboard) and top-level navigation
//     all fail, and the app window stays on its own page;
//   - full screen opens over the window, and Escape pressed inside the page's frame closes it;
//   - Settings → Appearance reaches the page: one declaring `color-scheme: light dark` sees the app's
//     appearance through prefers-color-scheme and draws on the app's surface, and one declaring
//     nothing stays light (black on white) in a dark app.
//
// bun app/scripts/check-embeds.ts [--out=<dir>] [--no-build]
//   --out     write screenshots there (default: a temp dir, printed at the end)
//   --no-build  use app/dist as it is

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TicketDetail } from "@harness/shared";
import type { Page } from "../../testing/lib/cdp";
import { startDaemon, type Daemon } from "../../testing/lib/daemon";
import { launchMac, type MacApp } from "../../testing/lib/mac";
import { killRecords, RunFile } from "../../testing/lib/procs";
import { until } from "../../testing/lib/wait";

const root = join(import.meta.dir, "..", "..");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-embeds-")));
const out = arg("out") ?? join(dir, "shots");
mkdirSync(out, { recursive: true });

const failures: string[] = [];
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(what);
};

// ---------------------------------------------------------------- the pages

const FLAME = `<!doctype html><html><head><meta charset="utf-8"><title>Flame graph</title>
<style>body{margin:0;font:12px -apple-system,sans-serif;background:#fff}h1{font-size:14px;margin:12px}svg{display:block}text{font-size:11px;fill:#222;pointer-events:none}rect{stroke:#fff}rect:hover{stroke:#000}</style></head>
<body><h1>service: handle /tickets (CPU, 2,140 samples)</h1><svg id="g" width="100%"></svg>
<script>
const tree = { n: "main", v: 2140, c: [
  { n: "http.handle", v: 1500, c: [
    { n: "router.match", v: 220, c: [] },
    { n: "orchestrator.ticketDetail", v: 980, c: [
      { n: "store.tickets.get", v: 310, c: [{ n: "sqlite.step", v: 280, c: [] }] },
      { n: "store.attachments.listByTicket", v: 420, c: [{ n: "sqlite.step", v: 360, c: [] }, { n: "JSON.parse", v: 50, c: [] }] },
      { n: "specDiff", v: 190, c: [{ n: "inlineTokens", v: 120, c: [] }] } ] },
    { n: "JSON.stringify", v: 260, c: [] } ] },
  { n: "ws.broadcast", v: 420, c: [{ n: "JSON.stringify", v: 300, c: [] }] },
  { n: "gc", v: 220, c: [] } ] };
const svg = document.getElementById("g"), W = 1000, H = 22;
let depth = 0;
const hue = (s) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 40;
function draw(node, x, w, d) {
  depth = Math.max(depth, d);
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  Object.entries({ x, y: d * H, width: Math.max(w - 1, 0), height: H - 1, fill: "hsl(" + (10 + hue(node.n)) + ",85%,58%)" }).forEach(([k, v]) => r.setAttribute(k, v));
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("x", x + 4); t.setAttribute("y", d * H + 14); t.textContent = w > 90 ? node.n + " (" + node.v + ")" : "";
  svg.append(r, t);
  let cx = x;
  for (const c of node.c) { const cw = (c.v / node.v) * w; draw(c, cx, cw, d + 1); cx += cw; }
}
draw(tree, 0, W, 0);
svg.setAttribute("viewBox", "0 0 " + W + " " + ((depth + 1) * H));
</script></body></html>`;

const BUNDLE_INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Bundle</title>
<link rel="stylesheet" href="style.css">
<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>
</head><body><h1>Folder bundle</h1>
<p>Relative stylesheet: <b id="css">not loaded</b></p>
<p>Relative script (<code>lib/app.js</code>): <b id="js">not loaded</b></p>
<p>Relative JSON (<code>data/points.json</code>): <b id="json">not loaded</b></p>
<p>CDN script (canvas-confetti from jsDelivr): <b id="cdn">not loaded</b></p>
<canvas id="c" width="360" height="80"></canvas>
<script src="lib/app.js"></script></body></html>`;
const BUNDLE_CSS = `body{font:13px -apple-system,sans-serif;margin:14px;background:#f4f8ff}h1{font-size:16px;color:#1f4fbf}b.ok{color:#127a2a}#css::after{content:""}.css-probe{--loaded:1}`;
const BUNDLE_JS = `const ok = (id, text) => { const el = document.getElementById(id); el.textContent = text; el.className = "ok"; };
if (getComputedStyle(document.body).backgroundColor === "rgb(244, 248, 255)") ok("css", "loaded");
ok("js", "loaded");
fetch("data/points.json").then((r) => r.json()).then((d) => {
  ok("json", d.points.length + " points");
  const c = document.getElementById("c").getContext("2d");
  c.strokeStyle = "#1f4fbf"; c.lineWidth = 2; c.beginPath();
  d.points.forEach((p, i) => c.lineTo(10 + i * 38, 70 - p * 6));
  c.stroke();
});
if (typeof confetti === "function") ok("cdn", "loaded");
document.body.dataset.ready = "1";`;

const GROW = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px -apple-system,sans-serif;margin:12px}li{padding:6px;border-bottom:1px solid #ddd}</style></head>
<body><h1 style="font-size:15px">A page that grows</h1><ol id="l"></ol>
<script>let n = 0; const t = setInterval(() => { const li = document.createElement("li"); li.textContent = "Row " + (++n) + " added after " + n * 250 + " ms"; li.style.paddingBottom = (n % 3) * 4 + 6 + "px"; document.getElementById("l").append(li); if (n >= 24) clearInterval(t); }, 250);</script></body></html>`;

const probePage = (api: string) => `<!doctype html><html><head><meta charset="utf-8"><style>body{font:13px -apple-system,sans-serif;margin:12px}td{padding:4px 10px;border-bottom:1px solid #eee}.b{color:#127a2a}.a{color:#c0261b;font-weight:bold}</style></head>
<body><h1 style="font-size:15px">What this embedded page tried</h1><table id="t"></table>
<script>
const results = {}; window.__probe = results;
const labels = { parent: "Read window.parent's document", bridge: "Call the app's window.harness bridge", api: "Call the API without the token", escape: "Climb out of its own files (harness-embed://…/../../tickets)", camera: "Camera (getUserMedia)", notifications: "Notification permission", geolocation: "Geolocation", clipboard: "Read the clipboard", top: "Navigate the app window (top.location)" };
const render = () => { document.getElementById("t").innerHTML = Object.entries(labels).map(([k, l]) => { const v = results[k] ?? "…"; return "<tr><td>" + l + "</td><td class=" + (v.startsWith("blocked") ? "b" : v === "…" ? "" : "a") + ">" + v + "</td></tr>"; }).join(""); };
const set = (k, v) => { results[k] = String(v); render(); };
const blocked = (k) => (e) => set(k, "blocked: " + (e && (e.name || e.message) || e));
render();
try { void parent.document.title; set("parent", "ALLOWED"); } catch (e) { blocked("parent")(e); }
try { const h = parent.harness; set("bridge", h ? "ALLOWED" : "blocked: undefined"); } catch (e) { blocked("bridge")(e); }
fetch(${JSON.stringify(api)} + "/tickets").then((r) => set("api", r.ok ? "ALLOWED " + r.status : "blocked: " + r.status), blocked("api"));
fetch("harness-embed://" + location.host + "/%2e%2e/%2e%2e/tickets").then((r) => set("escape", r.ok ? "ALLOWED " + r.status : "blocked: " + r.status), blocked("escape"));
if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia({ video: true }).then(() => set("camera", "ALLOWED"), blocked("camera")); else set("camera", "blocked: no mediaDevices");
if (window.Notification) Notification.requestPermission().then((p) => set("notifications", p === "granted" ? "ALLOWED" : "blocked: " + p), blocked("notifications")); else set("notifications", "blocked: no Notification");
if (navigator.geolocation) navigator.geolocation.getCurrentPosition(() => set("geolocation", "ALLOWED"), (e) => set("geolocation", "blocked: code " + e.code)); else set("geolocation", "blocked: no geolocation");
if (navigator.clipboard) navigator.clipboard.readText().then(() => set("clipboard", "ALLOWED"), blocked("clipboard")); else set("clipboard", "blocked: no clipboard");
try { top.location.href = "https://example.com/"; setTimeout(() => results.top ?? set("top", "blocked: no navigation"), 500); } catch (e) { blocked("top")(e); }
</script></body></html>`;

// A page written for both appearances, as the agent instructions ask: it declares color-scheme and
// leaves the background to the canvas, and reports what prefers-color-scheme says.
const THEMED = `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>:root{color-scheme:light dark}body{margin:0;padding:16px;font:13px -apple-system,sans-serif}.dark{display:none}@media (prefers-color-scheme: dark){h1{color:#8ab4ff}.dark{display:inline}.light{display:none}}</style></head>
<body><h1 style="font-size:15px">Light and dark</h1><p>prefers-color-scheme: <b class="light">light</b><b class="dark">dark</b></p>
<script>window.__scheme = () => matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";</script></body></html>`;
// A page that declares nothing about color schemes.
const PLAIN = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;font:13px -apple-system,sans-serif"><h1 style="font-size:15px">No color-scheme</h1><p>Black on white in either appearance.</p></body></html>`;

function writePages(project: string, api: string) {
  const w = (path: string, text: string) => {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), text);
  };
  w("reports/flame.html", FLAME);
  w("reports/bundle/index.html", BUNDLE_INDEX);
  w("reports/bundle/style.css", BUNDLE_CSS);
  w("reports/bundle/lib/app.js", BUNDLE_JS);
  w("reports/bundle/data/points.json", JSON.stringify({ points: [1, 4, 3, 7, 6, 9, 8, 10, 7] }));
  w("reports/grow.html", GROW);
  w("reports/probe.html", probePage(api));
  w("reports/themed.html", THEMED);
  w("reports/plain.html", PLAIN);
  w("reports/gone.html", "<!doctype html><p>This page's files are removed before the app opens it.</p>");
}

const SPEC = [
  "## Profile of GET /tickets",
  "",
  "The flame graph from the profiling run; open [the flame graph](reports/flame.html) full screen to explore it.",
  "",
  "[Flame graph](reports/flame.html)",
  "",
  "[Folder bundle with a relative asset and a CDN script](reports/bundle)",
  "",
  "[A page that grows](reports/grow.html)",
  "",
  "[Security probe](reports/probe.html)",
  "",
  "[Light and dark](reports/themed.html)",
  "",
  "[No color scheme](reports/plain.html)",
  "",
  "[Removed report](reports/gone.html)",
  "",
  "Text after the embeds still renders.",
].join("\n");

// ---------------------------------------------------------------- the run

const runs = new RunFile(join(dir, "runs.jsonl"));
let daemon: Daemon | undefined;
let mac: MacApp | undefined;

async function frameTarget(m: MacApp, id: string): Promise<Page> {
  const t = await until(`the embed frame for ${id}`, 30_000, async () => {
    const { targetInfos } = await m.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    return targetInfos.find((x) => x.type === "iframe" && x.url.startsWith(`harness-embed://${id}/`));
  });
  return m.cdp.attach(t);
}

const shot = async (m: MacApp, name: string, selector?: string) => {
  if (selector) await m.main.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`);
  await new Promise((r) => setTimeout(r, 400));
  const path = join(out, `${name}.png`);
  await m.main.screenshot(path);
  return path;
};

try {
  if (!process.argv.includes("--no-build")) {
    const b = Bun.spawnSync(["bun", "run", "build"], { cwd: join(root, "app"), stdout: "inherit", stderr: "inherit" });
    if (b.exitCode !== 0) throw new Error("app build failed");
  }
  const project = join(dir, "project");
  daemon = await startDaemon(runs, join(dir, "home"));
  writePages(project, daemon.url);
  const phase = { driver: "dummy", model: null };
  await daemon.call("PATCH", "/settings", { classifier: "off", phaseModels: { plan: phase, work: phase, review: phase, adviser: phase, complete: phase } });
  const p = await daemon.call<{ id: string }>("POST", "/projects", { path: project, key: "EMB", name: "Embeds", useWorktrees: false, skipAgentReview: true });
  const tools = JSON.stringify([{ name: "update_spec", input: { base_revision: 1, note: "Embedded the profiling reports", spec: SPEC } }]);
  const ticket = await daemon.call<{ key: string }>("POST", "/tickets", { projectId: p.id, spec: `Profile it\n/tools ${tools}`, skipAgentReview: true });
  const detail = await until("the agent's spec with the pages in it", 60_000, async () => {
    const d = await daemon!.call<TicketDetail>("GET", `/tickets/${ticket.key}`);
    await new Promise((r) => setTimeout(r, 100));
    return d.ticket.spec.includes("attachment:") && (d.attachments ?? []).filter((a) => a.kind === "page").length >= 7 ? d : null;
  });
  const idOf = (caption: string) => new RegExp(`\\[${caption.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\(attachment:([^)]+)\\)`).exec(detail.ticket.spec)?.[1] ?? "";
  const ids = { flame: idOf("Flame graph"), bundle: idOf("Folder bundle with a relative asset and a CDN script"), grow: idOf("A page that grows"), probe: idOf("Security probe"), themed: idOf("Light and dark"), plain: idOf("No color scheme"), gone: idOf("Removed report") };
  check("the agent's links became page attachments", Object.values(ids).every(Boolean), JSON.stringify(ids));
  rmSync(join(daemon.home, "attachments", ids.gone), { recursive: true, force: true });

  mac = await launchMac(runs, { url: daemon.url, token: daemon.token, userData: join(dir, "mac-profile") });
  const main = mac.main;
  await main.evaluate(`location.hash = ${JSON.stringify(`#/board/all/ticket/${ticket.key}`)}`);
  await main.click("[data-testid=pane-zoom]");
  await main.waitFor("the spec with its embeds", `document.querySelectorAll('[data-testid=md-embed]').length === 7`, 60_000);
  const height = (id: string) => main.evaluate<number>(`document.querySelector('[data-embed-id="${id}"] iframe')?.getBoundingClientRect().height ?? 0`);

  // The flame graph: loaded through the scheme and sized to its own height (not the 360 default).
  await main.waitFor("the flame graph to report its height", `(() => { const f = document.querySelector('[data-embed-id="${ids.flame}"] iframe'); return f && f.getBoundingClientRect().height !== 360; })()`);
  const flame = await frameTarget(mac, ids.flame);
  check("the flame graph draws in its frame", (await flame.evaluate<number>("document.querySelectorAll('svg rect').length")) > 10);
  check("the flame graph's embed follows its height", (await height(ids.flame)) < 360, `${await height(ids.flame)}px`);
  console.log(`  screenshot ${await shot(mac, "01-flame-graph", ".md")}`);

  // The folder bundle: relative CSS, script and JSON, and a script from a CDN.
  const bundle = await frameTarget(mac, ids.bundle);
  const loaded = await until("the bundle's assets", 30_000, () => bundle.evaluate<Record<string, string> | null>(`document.body?.dataset.ready && document.getElementById("json").className === "ok" ? Object.fromEntries(["css", "js", "json", "cdn"].map((k) => [k, document.getElementById(k).textContent])) : null`));
  check("the bundle loads its relative stylesheet, script and JSON", loaded.css === "loaded" && loaded.js === "loaded" && loaded.json === "9 points", JSON.stringify(loaded));
  check("the bundle loads a CDN script", loaded.cdn === "loaded", loaded.cdn);
  console.log(`  screenshot ${await shot(mac, "02-folder-bundle", `[data-embed-id="${ids.bundle}"]`)}`);

  // The growing page: the embed grows with it.
  const first = await height(ids.grow);
  await main.waitFor("the growing page to finish growing", `document.querySelector('[data-embed-id="${ids.grow}"] iframe').getBoundingClientRect().height > 700`, 30_000);
  const last = await height(ids.grow);
  check("the embed follows a page that changes height", last > first, `${first}px → ${last}px`);
  console.log(`  screenshot ${await shot(mac, "03-growing-page", `[data-embed-id="${ids.grow}"]`)}`);

  // The probe: everything an embedded page shouldn't be able to do fails.
  const probe = await frameTarget(mac, ids.probe);
  const results = await until("the probe's results", 30_000, () => probe.evaluate<Record<string, string> | null>(`Object.keys(window.__probe ?? {}).length >= 9 ? window.__probe : null`));
  for (const [k, v] of Object.entries(results)) check(`embedded page: ${k} fails`, v.startsWith("blocked"), v);
  check("the app window stays on its own page", (await main.evaluate<string>("location.href")).startsWith("file://"));
  console.log(`  screenshot ${await shot(mac, "04-security-probe", `[data-embed-id="${ids.probe}"]`)}`);

  // Appearance: the frame follows Settings → Appearance without the app touching the page.
  const themed = await frameTarget(mac, ids.themed);
  await frameTarget(mac, ids.plain);
  // The color a few pixels inside an embed's top-left corner, from a screenshot of the window.
  const pixel = async (id: string) => {
    await main.evaluate(`document.querySelector('[data-embed-id="${id}"]').scrollIntoView({ block: "center" })`);
    await new Promise((r) => setTimeout(r, 300));
    const r = await main.evaluate<{ x: number; y: number }>(`(() => { const b = document.querySelector('[data-embed-id="${id}"] iframe').getBoundingClientRect(); return { x: b.x + 4, y: b.y + 4 }; })()`);
    const { data } = await main.send<{ data: string }>("Page.captureScreenshot", { format: "png", clip: { ...r, width: 2, height: 2, scale: 1 } });
    // Decoded inside the themed page: it has no CSP, unlike the app's window.
    return themed.evaluate<number[]>(`(async () => { const bytes = Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0)); const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" })); const c = new OffscreenCanvas(1, 1).getContext("2d"); c.drawImage(bmp, 0, 0); return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)]; })()`);
  };
  const luma = ([r = 0, g = 0, b = 0]: number[]) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  for (const appearance of ["dark", "light"] as const) {
    await main.evaluate(`window.harness.setTheme({ preference: "${appearance}" })`);
    await main.waitFor(`the app in ${appearance}`, `document.documentElement.dataset.theme === "${appearance}"`);
    await until(`the page to see ${appearance}`, 10_000, async () => (await themed.evaluate<string>("window.__scheme()")) === appearance || null).catch(() => {});
    const seen = await themed.evaluate<string>("window.__scheme()");
    check(`in ${appearance}, a light/dark page sees prefers-color-scheme: ${appearance}`, seen === appearance, seen);
    const surface = await pixel(ids.themed);
    check(`in ${appearance}, a light/dark page draws on a ${appearance} surface`, appearance === "dark" ? luma(surface) < 90 : luma(surface) > 200, `rgb(${surface})`);
    const plain = await pixel(ids.plain);
    check(`in ${appearance}, a page with no color-scheme stays on white`, luma(plain) > 240, `rgb(${plain})`);
    console.log(`  screenshot ${await shot(mac, `05-appearance-${appearance}`, `[data-embed-id="${ids.themed}"]`)}`);
  }
  await main.evaluate(`window.harness.setTheme({ preference: "system" })`);

  // The removed page: a placeholder with its caption and full-screen button; the spec goes on.
  await main.waitFor("the removed page's placeholder", `document.querySelector('[data-embed-id="${ids.gone}"] [data-testid=md-embed-failed]')`);
  check("a page that can't load shows the placeholder", true);
  check("the text after the embeds renders", await main.evaluate<boolean>(`document.body.innerText.includes("Text after the embeds still renders.")`));
  console.log(`  screenshot ${await shot(mac, "06-failed-placeholder", `[data-embed-id="${ids.gone}"]`)}`);

  // Full screen from the flame graph's button, then Escape pressed inside the page's frame.
  await main.evaluate(`document.querySelector('[data-embed-id="${ids.flame}"]').scrollIntoView({ block: "start" })`);
  await main.click(`[data-embed-id="${ids.flame}"] [data-testid=md-embed-full]`);
  await main.waitFor("the full-screen page", `document.querySelector('.overlay.embed-full iframe')`);
  await frameTarget(mac, ids.flame);
  console.log(`  screenshot ${await shot(mac, "07-full-screen")}`);
  const { x, y } = await main.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('.overlay.embed-full iframe').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height - 20 }; })()`);
  await main.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await main.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await main.waitFor("the page's frame to have the focus", `document.activeElement === document.querySelector('.overlay.embed-full iframe')`);
  // A real key press: DevTools' synthetic keys skip Electron's before-input-event, which is the path under test.
  // The launcher (node_modules/.bin/electron) runs the app as its child.
  const pid = Bun.spawnSync(["pgrep", "-P", String(mac.spawned.proc.pid)]).stdout.toString().trim().split("\n")[0] || mac.spawned.proc.pid;
  const key = Bun.spawnSync(["osascript", "-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`, "-e", "delay 0.3", "-e", 'tell application "System Events" to key code 53']);
  if (key.exitCode !== 0) throw new Error(`couldn't press Escape through System Events: ${key.stderr.toString().trim()}`);
  await main.waitFor("Escape in the frame to close full screen", `!document.querySelector('.overlay.embed-full')`);
  check("Escape pressed inside the full-screen page closes it", true);

  // The inline link opens the same full-screen view.
  await main.click(`[data-testid=md-embed-link]`);
  await main.waitFor("the inline link's full-screen page", `document.querySelector('.overlay.embed-full iframe')?.getAttribute('src') === 'harness-embed://${ids.flame}/'`);
  check("an inline page link opens it full screen", true);
  await main.click(`[data-testid=embed-full-close]`);
  await main.waitFor("the close button to close full screen", `!document.querySelector('.overlay.embed-full')`);
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
  console.error(e);
  if (mac) await mac.main.screenshot(join(out, "failure.png")).catch(() => {});
} finally {
  await mac?.quit().catch(() => {});
  await daemon?.stop().catch(() => {});
  await killRecords(runs.records());
  runs.remove();
}

console.log(`\nscreenshots: ${out}`);
if (failures.length) {
  console.error(`✗ ${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("✓ embeds: every check passed");
