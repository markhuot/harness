// Browser size controls and pinch-zoom end-to-end against the mock service: Desktop | Mobile,
// width × height, the Responsive switch (and who owns it), and a trackpad pinch that zooms the frame
// without reaching the page, with clicks still landing on the right page pixel while zoomed.
//
//   bun run build && bun scripts/browser-size-check.ts [screenshotDir]
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv[2] ?? join(appDir, "out", "screenshots", "browser-size"));
mkdirSync(shots, { recursive: true });
const port = 7700 + Math.floor(Math.random() * 90);
const token = "size-token";
const base = `http://127.0.0.1:${port}`;
const inputs: Record<string, any>[] = [];

const mock = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
  env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token, MOCK_QUIET: "1" },
  stdout: "pipe",
  stderr: "inherit",
});
void (async () => {
  const dec = new TextDecoder();
  const reader = mock.stdout.getReader();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = (rest + dec.decode(value)).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) if (l.includes("[browser.input")) inputs.push(JSON.parse(l.slice(l.indexOf("{"))));
  }
})();

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
let other: WebSocket | null = null;
try {
  await waitHealthy(base, 15000);
  const api = makeApi(base, token);
  const sessionId = (await api<{ session: { id: string } }>("GET", "/tickets/NYTIMES-1")).session.id;
  app = await launchApp({ baseUrl: base, token });
  const a = app;
  const { js, cdp } = a;
  const shot = (name: string) => a.screenshot(join(shots, `${name}.png`));
  const since = (n: number, type: string) => inputs.slice(n).filter((i) => i.type === type);
  const fields = () => js<{ w: string; h: string; device: string; responsive: string; title: string; zoom: string | null }>(`(() => ({
    w: document.querySelector("[aria-label=Width]").value,
    h: document.querySelector("[aria-label=Height]").value,
    device: document.querySelector(".browser-device [aria-pressed=true]")?.getAttribute("aria-label") ?? "",
    responsive: document.querySelector("[data-testid=browser-responsive]").className.split(" ").pop(),
    title: document.querySelector("[data-testid=browser-responsive]").title,
    zoom: document.querySelector(".browser-zoom")?.textContent ?? null,
  }))()`);
  const click = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  /** Type into a size field and press Enter. */
  const enterSide = async (label: "Width" | "Height", value: string) => {
    await a.type(`[aria-label=${label}]`, value);
    await a.key("Enter", "Enter", 13);
  };

  const stageSize = () => js<{ w: number; h: number }>(`(() => { const s = document.querySelector(".browser-stage"); return { w: Math.round(s.clientWidth), h: Math.round(s.clientHeight) }; })()`);

  await until("app connected", () => a.exists(".conn.on"), 15000);
  await js(`location.hash = "#/board/all/ticket/NYTIMES-1/browser"`);
  await until("size button", () => a.exists("[data-testid=browser-size-toggle]"), 10000);
  await until("frame drawn", () => js<boolean>(`window.__harnessBrowser.drawn > 0`), 10000);
  await Bun.sleep(1200);

  // 0. The bar: the size row starts closed behind Size, Annotate is an icon, and there's no Live.
  check("the size row starts closed", !(await a.exists("[data-testid=browser-size-row]")) && (await js<string>(`document.querySelector("[data-testid=browser-size-toggle]").getAttribute("aria-pressed")`)) === "false");
  check("Annotate is icon-only, labelled", (await js<string>(`(() => { const b = document.querySelector("[data-testid=browser-annotate]"); return b.textContent.trim() + "|" + b.getAttribute("aria-label"); })()`)) === "|Annotate");
  check("no Live/Idle indicator", !(await a.exists(".browser-live")));
  await click("[data-testid=browser-size-toggle]");
  await until("size row open", () => a.exists("[data-testid=browser-responsive]"));
  check("Size is pressed while the row is open", (await js<string>(`document.querySelector("[data-testid=browser-size-toggle]").getAttribute("aria-pressed")`)) === "true");
  await js(`location.reload()`);
  await until("reloaded", () => a.exists("[data-testid=browser-size-toggle]"), 15000);
  check("the open row survives a renderer reload", await until("row after reload", () => a.exists("[data-testid=browser-responsive]"), 5000).catch(() => false));
  await until("frame drawn after reload", () => js<boolean>(`window.__harnessBrowser.drawn > 0`), 10000);
  await Bun.sleep(1200);

  // 1. A new tab is Desktop and Responsive, following the pane that watches it: this one, which
  //    sends its stage size without being resized. (The page from before the reload owned it until
  //    its socket closed, then handed it on.)
  await until("owned after the reload", async () => (await fields()).responsive === "owned", 8000).catch(() => {});
  await Bun.sleep(600);
  let f = await fields();
  let st = await stageSize();
  check("a new tab is Desktop, Responsive and owned by the pane watching it", f.device === "Desktop" && f.responsive === "owned", JSON.stringify(f));
  const handed = since(0, "resize").at(-1);
  check("the pane it's handed to sends its stage size", handed?.width === st.w && handed?.height === st.h && f.w === String(st.w), `${JSON.stringify(handed)} stage ${JSON.stringify(st)} fields ${JSON.stringify(f)}`);
  await shot("1-desktop");

  // 2. Mobile resets to 393 × 852; clicking it again resends (it reloads even in the same mode).
  let n = inputs.length;
  await click("[data-testid=browser-device-mobile]");
  await until("mobile size", async () => (await fields()).w === "393");
  await click("[data-testid=browser-device-mobile]");
  await until("second device input", async () => since(n, "device").length === 2);
  f = await fields();
  check("Mobile sends device and shows 393 × 852, Mobile pressed", f.device === "Mobile" && f.h === "852" && since(n, "device").every((i) => i.device === "mobile"), JSON.stringify(f));
  await Bun.sleep(800);
  await shot("2-mobile");

  // 3. Mobile at 1280 × 800: the size inputs keep the mode.
  n = inputs.length;
  await enterSide("Width", "1280");
  await until("width sent", async () => since(n, "size").length === 1);
  await enterSide("Height", "800");
  await until("height sent", async () => since(n, "size").length === 2);
  f = await fields();
  check("width × height sends size and keeps Mobile", f.device === "Mobile" && f.w === "1280" && f.h === "800", `${JSON.stringify(f)} ${JSON.stringify(since(n, "size"))}`);
  n = inputs.length;
  await enterSide("Width", "12");
  await until("clamped width", async () => since(n, "size").length === 1);
  check("a side below 100 is clamped before it's sent", since(n, "size")[0]?.width === 100, JSON.stringify(since(n, "size")));
  await enterSide("Width", "1280");
  await Bun.sleep(800);
  await shot("3-mobile-1280x800");

  // 4. Responsive: switched on with this stage's size; the pane then drives the tab.
  await click("[data-testid=browser-device-desktop]");
  await until("desktop", async () => (await fields()).device === "Desktop");
  n = inputs.length;
  const stage = await js<{ w: number; h: number }>(`(() => { const s = document.querySelector(".browser-stage"); return { w: s.clientWidth, h: s.clientHeight }; })()`);
  await click("[data-testid=browser-responsive]");
  await until("owned", async () => (await fields()).responsive === "owned");
  const on = since(n, "responsive")[0];
  check("Responsive sends on with the stage size and lights up", on?.on === true && on.width === Math.round(stage.w) && on.height === Math.round(stage.h), JSON.stringify(on));
  n = inputs.length;
  await js(`document.querySelector(".browser-stage").style.marginRight = "240px"`);
  const resized = await until("resize sent", async () => since(n, "resize")[0]).catch(() => undefined);
  check("the owner's stage size is sent as it changes", !!resized && resized.width === Math.round(stage.w) - 240, JSON.stringify(resized));
  await Bun.sleep(800);
  await shot("4-responsive-owned");

  // 5. Editing width × height turns Responsive off, and the pane stops driving the tab.
  await enterSide("Width", "1024");
  await until("responsive off", async () => (await fields()).responsive === "off");
  n = inputs.length;
  await js(`document.querySelector(".browser-stage").style.marginRight = "0px"`);
  await Bun.sleep(900);
  check("after editing the size, resizing the pane sends nothing", since(n, "resize").length === 0, JSON.stringify(since(n, "resize")));

  // 6. Another window switches Responsive on: this pane shows it dimmed-lit and doesn't drive it.
  other = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((r) => (other!.onopen = r));
  const tabId = await js<number>(`Number(document.querySelector(".browser-tab-select[aria-selected=true]").dataset.tabId)`);
  other.send(JSON.stringify({ type: "browser.subscribe", sessionId, tabId, viewerId: "other" }));
  other.send(JSON.stringify({ type: "browser.input", sessionId, viewerId: "other", tabId, input: { type: "responsive", on: true, width: 700, height: 500 } }));
  await until("following", async () => (await fields()).responsive === "following");
  f = await fields();
  check("another window's Responsive shows dimmed-lit, titled Following another window", f.title === "Following another window" && f.w === "700", JSON.stringify(f));
  n = inputs.length;
  await js(`document.querySelector(".browser-stage").style.marginRight = "120px"`);
  await Bun.sleep(900);
  check("a following pane sends no resize", since(n, "resize").length === 0, JSON.stringify(since(n, "resize")));
  await shot("6-following");
  await click("[data-testid=browser-responsive]");
  await until("taken over", async () => (await fields()).responsive === "owned");
  check("clicking the dimmed switch takes ownership (on, with this stage)", since(n, "responsive")[0]?.on === true, JSON.stringify(since(n, "responsive")));
  await js(`document.querySelector(".browser-stage").style.marginRight = "0px"`);
  await Bun.sleep(900);

  // 6b. The other window takes it back, then leaves: the tab comes back to this pane, which sends
  //     its stage size though its stage didn't change (the tab is still at the other window's).
  other.send(JSON.stringify({ type: "browser.input", sessionId, viewerId: "other", tabId, input: { type: "responsive", on: true, width: 700, height: 500 } }));
  await until("following again", async () => (await fields()).w === "700");
  n = inputs.length;
  other.close();
  other = null;
  await until("handed back", async () => (await fields()).responsive === "owned");
  st = await stageSize();
  const back = await until("resize after the handoff", async () => since(n, "resize")[0]).catch(() => undefined);
  check("a pane handed Responsive when the owner leaves sends its unchanged stage size", back?.width === st.w && back?.height === st.h, `${JSON.stringify(back)} stage ${JSON.stringify(st)}`);
  check("and the tab follows it", await until("tab at the stage size", async () => (await fields()).w === String(st.w)).catch(() => false));

  // 7. Pinch-zoom: a ctrl wheel zooms the frame around the cursor and never reaches the page.
  await click("[data-testid=browser-device-desktop]");
  await until("desktop size", async () => (await fields()).w === "1280");
  await Bun.sleep(1000);
  const r = await js<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector(".browser-canvas").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const ax = Math.round(r.x + r.w * 0.4);
  const ay = Math.round(r.y + r.h * 0.5);
  const clickAt = async (x: number, y: number) => {
    const m = inputs.length;
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return until("click forwarded", async () => inputs.slice(m).find((i) => i.type === "mouse" && i.action === "down"));
  };
  const before = await clickAt(ax, ay);
  const beforeOff = await clickAt(ax + 100, ay);
  n = inputs.length;
  for (let i = 0; i < 6; i++) await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: ax, y: ay, deltaX: 0, deltaY: -20, modifiers: 2 });
  await until("zoomed", async () => (await fields()).zoom !== null);
  const pct = Number((await fields()).zoom?.replace("%", ""));
  check("a pinch zooms the frame (badge shows the zoom)", pct > 200 && pct <= 400, String(pct));
  check("a pinch never reaches the page", since(n, "mouse").every((i) => i.action !== "wheel"), JSON.stringify(since(n, "mouse")));
  const after = await clickAt(ax, ay);
  const afterOff = await clickAt(ax + 100, ay);
  check("the page point under the pinch stays under it (a click there lands on the same pixel)", Math.abs(after.x - before.x) <= 1 && Math.abs(after.y - before.y) <= 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  const ratio = (beforeOff.x - before.x) / (afterOff.x - after.x);
  check("while zoomed, clicks map through the zoomed frame (100 px spans 1/zoom as many page px)", Math.abs(ratio - pct / 100) < 0.1, `ratio ${ratio.toFixed(2)} vs ${pct}%`);
  await Bun.sleep(400);
  await shot("7-zoomed");

  // 8. While zoomed, a plain scroll pans the frame instead of scrolling the page.
  n = inputs.length;
  await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: ax, y: ay, deltaX: 0, deltaY: 120 });
  await Bun.sleep(200);
  const panned = await clickAt(ax, ay);
  check("a scroll while zoomed pans the frame, not the page", since(n, "mouse").every((i) => i.action !== "wheel") && panned.y > after.y, `${JSON.stringify(after)} → ${JSON.stringify(panned)}`);

  // 9. ⌥-double-click goes back to 1× without clicking the page.
  n = inputs.length;
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", clickCount: 1, modifiers: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: ax, y: ay, button: "left", clickCount: 1, modifiers: 1 });
  const m2 = inputs.length;
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: ax, y: ay, button: "left", clickCount: 2, modifiers: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: ax, y: ay, button: "left", clickCount: 2, modifiers: 1 });
  await until("unzoomed", async () => (await fields()).zoom === null);
  await Bun.sleep(300);
  check("⌥-double-click resets the zoom and its second click stays off the page", inputs.slice(m2).every((i) => i.type !== "mouse" || (i.action !== "down" && i.action !== "up")), JSON.stringify(inputs.slice(m2)));
  const reset = await clickAt(ax, ay);
  check("back at 1×, clicks land where they did before zooming", Math.abs(reset.x - before.x) <= 1 && Math.abs(reset.y - before.y) <= 1, JSON.stringify(reset));
  void n;

  // 10. A new frame size drops the zoom.
  for (let i = 0; i < 4; i++) await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: ax, y: ay, deltaX: 0, deltaY: -20, modifiers: 2 });
  await until("zoomed again", async () => (await fields()).zoom !== null);
  await click("[data-testid=browser-device-mobile]");
  await until("zoom dropped on a new size", async () => (await fields()).zoom === null).then(() => check("a new device size resets the zoom", true)).catch(() => check("a new device size resets the zoom", false));

  // 11. A narrow pane (420 px): with the row closed the bar is back, forward, reload, the URL, Size
  //     and Annotate, and the URL field keeps most of the width.
  await js(`document.querySelector(".browser").style.width = "420px"`);
  await click("[data-testid=browser-size-toggle]");
  await until("row closed", async () => !(await a.exists("[data-testid=browser-size-row]")));
  await Bun.sleep(600);
  const urlW = await js<number>(`document.querySelector(".browser-url").getBoundingClientRect().width`);
  check("in a 420 px pane the URL field is readable (over 200 px wide)", urlW > 200, `${Math.round(urlW)} px`);
  await shot("11-narrow-row-closed");
  await click("[data-testid=browser-size-toggle]");
  await until("row open", () => a.exists("[data-testid=browser-size-row]"));
  const rowFits = await js<boolean>(`(() => { const r = document.querySelector("[data-testid=browser-size-row]"); return r.scrollWidth <= r.clientWidth; })()`);
  check("the size row fits a 420 px pane", rowFits);
  await Bun.sleep(600);
  await shot("12-narrow-row-open");

  // 12. Enough tabs to overflow the strip: the chips scroll, + stays at the strip's end.
  for (let i = 0; i < 5; i++) {
    const before = await js<number>(`document.querySelectorAll(".browser-tab-select").length`);
    await click("[data-testid=browser-new-tab]");
    await until("another tab", async () => (await js<number>(`document.querySelectorAll(".browser-tab-select").length`)) > before);
  }
  await Bun.sleep(800);
  const strip = await js<{ overflow: boolean; plusIn: boolean; plusOutsideScroller: boolean }>(`(() => {
    const tabs = document.querySelector(".browser-tabs");
    const strip = document.querySelector(".browser-tab-strip").getBoundingClientRect();
    const plus = document.querySelector("[data-testid=browser-new-tab]");
    const p = plus.getBoundingClientRect();
    tabs.scrollLeft = 0;
    return { overflow: tabs.scrollWidth > tabs.clientWidth, plusIn: p.left >= strip.left && p.right <= strip.right + 0.5 && p.width > 0, plusOutsideScroller: !tabs.contains(plus) };
  })()`);
  check("with the strip overflowing, + stays visible at its end, outside the scrolling chips", strip.overflow && strip.plusIn && strip.plusOutsideScroller, JSON.stringify(strip));
  await shot("13-strip-overflow");
} catch (e) {
  c.fail();
  console.error("✗", (e as Error).stack ?? (e as Error).message);
  if (app) await app.screenshot(join(shots, "failure.png")).catch(() => {});
} finally {
  other?.close();
  await app?.close();
  mock.kill();
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall browser size checks passed");
process.exit(c.failures ? 1 : 0);
