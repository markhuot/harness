// Pane sizing end to end in the built app, over the DevTools Protocol, against the mock service:
// a real divider drag scales every pane on each side of it, an ⌥-drag moves only the two touching
// it, ⌘= equalizes every pane but the board, and a pane dragged between two of its neighbours
// keeps every pane's size. panes.test.ts covers the math underneath.
//
//   bun run build && bun scripts/pane-resize-check.ts [--shots=<dir>]
import { join } from "node:path";
import { appDir, checker, launchApp, stopped, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const port = 7800 + Math.floor(Math.random() * 90);
const token = "resize-token";
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
  // Wide enough that every pane in the layouts below sits above its minimum width.
  await cdp("Emulation.setDeviceMetricsOverride", { width: 2000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until("board", () => js<boolean>(`!!document.querySelector(".card")`), 15000);

  const leaf = (id: string, content: object) => ({ type: "leaf", id, content });
  const A = leaf("a", { kind: "ticket", ticketKey: "NYTIMES-4", tab: "summaries" });
  const C = leaf("c", { kind: "ticket", ticketKey: "NYTIMES-5", tab: "summaries" });
  const layout = (sizes: number[], children = [leaf("b", { kind: "board" }), A, C]) => ({ root: { type: "split", id: "r", dir: "row", children, sizes }, focusedId: null, zoomedId: null });
  const setPanes = async (st: object) => {
    await js(`localStorage.setItem("harness.panes", ${JSON.stringify(JSON.stringify({ scopes: { "*": st } }))}); dispatchEvent(new StorageEvent("storage", { key: "harness.panes" }))`);
    await Bun.sleep(300);
  };
  await setPanes(layout([0.25, 0.5, 0.25]));
  await js(`location.hash = "#/board/all"`);
  await until("three panes", () => js<boolean>(`document.querySelectorAll(".pane").length === 3 && document.querySelectorAll(".pane-ticket .detail-key").length === 2`), 10000);
  await Bun.sleep(300);

  /** Each pane's label (ticket key or "board") and width, left to right. */
  const widths = () =>
    js<{ key: string; w: number }[]>(`[...document.querySelectorAll(".pane")].map(p => { const r = p.getBoundingClientRect();
      return { key: p.querySelector(".detail-key")?.textContent ?? "board", x: r.x, w: Math.round(r.width) }; }).sort((a, b) => a.x - b.x).map(({ key, w }) => ({ key, w }))`);
  const order = async () => (await widths()).map((p) => p.key).join(",");
  const near = (a: number, b: number, tol = 3) => Math.abs(a - b) <= tol;
  const ws = await js<number>(`document.querySelector(".pane-workspace").clientWidth`);
  const before = await widths();
  check("starts as board 25% | NYTIMES-4 50% | NYTIMES-5 25%", before.map((p) => p.key).join(",") === "board,NYTIMES-4,NYTIMES-5" && near(before[1]!.w, ws / 2), JSON.stringify(before));

  // CDP modifiers: Alt = 1, Meta = 4.
  const mouse = (type: string, x: number, y: number, modifiers = 0) =>
    cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, modifiers });
  /** Real pointer drag of the divider after child `index` of the root row by dx, in steps. */
  const dragDivider = async (index: number, dx: number, modifiers = 0) => {
    const r = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-divider="r:${index}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
    await mouse("mousePressed", r.x, r.y, modifiers);
    for (let i = 1; i <= 6; i++) await mouse("mouseMoved", r.x + (dx * i) / 6, r.y, modifiers);
    await mouse("mouseReleased", r.x + dx, r.y, modifiers);
    await Bun.sleep(300);
  };

  // 1. Dragging the right divider left grows the right pane and shrinks both others alike.
  await dragDivider(1, -200);
  const dragged = await widths();
  check(
    "dragging the right divider 200px left grows the right pane by 200px",
    near(dragged[2]!.w, before[2]!.w + 200),
    `${before[2]!.w} → ${dragged[2]!.w}`,
  );
  check(
    "…and the two panes left of it shrink together, keeping their proportions",
    dragged[0]!.w < before[0]!.w && dragged[1]!.w < before[1]!.w && Math.abs(dragged[0]!.w / dragged[1]!.w - before[0]!.w / before[1]!.w) < 0.01,
    JSON.stringify(dragged),
  );
  if (shots) await screenshot(join(shots, "resize-proportional.png"));

  // 2. ⌥-drag: only the two panes touching the divider change.
  await dragDivider(1, 120, 1);
  const alt = await widths();
  check("⌥-dragging the divider leaves the board alone", near(alt[0]!.w, dragged[0]!.w, 1), `${dragged[0]!.w} → ${alt[0]!.w}`);
  check("…and moves only the two panes touching it", near(alt[1]!.w, dragged[1]!.w + 120) && near(alt[2]!.w, dragged[2]!.w - 120), JSON.stringify(alt));

  // 3. ⌘= equalizes every pane but the board.
  await js(`document.querySelector(".pane-board")?.focus()`);
  await key("=", "Equal", 187, 4);
  await Bun.sleep(300);
  const eq = await widths();
  check("⌘= keeps the board's width", near(eq[0]!.w, alt[0]!.w, 1), `${alt[0]!.w} → ${eq[0]!.w}`);
  check("…and gives the other panes an even share", near(eq[1]!.w, eq[2]!.w, 1), JSON.stringify(eq));
  if (shots) await screenshot(join(shots, "resize-equalized.png"));

  // 4. Dragging the right pane between the board and the middle one keeps every pane's size.
  await setPanes(layout([0.25, 0.5, 0.25]));
  const start = await widths();
  const moved = await js<boolean>(`(async () => {
    const tick = () => new Promise(r => setTimeout(r, 60));
    const grip = document.querySelector('.pane[data-pane-id="c"] [data-testid=pane-grip]');
    const t = document.querySelector('.pane[data-pane-id="a"]').getBoundingClientRect();
    const dt = new DataTransfer();
    grip.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    await tick();
    const layer = document.querySelector("[data-testid=pane-drop-layer]");
    if (!layer) return false;
    const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: t.left + t.width * 0.1, clientY: t.top + t.height * 0.5 });
    layer.dispatchEvent(ev("dragenter"));
    const accepted = !layer.dispatchEvent(ev("dragover"));
    await tick();
    if (accepted) layer.dispatchEvent(ev("drop"));
    grip.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return accepted;
  })()`);
  await Bun.sleep(300);
  const after = await widths();
  check("dropping NYTIMES-5 on the left of NYTIMES-4 moves it there", moved && (await order()) === "board,NYTIMES-5,NYTIMES-4", await order());
  check(
    "…and every pane keeps its width (25% | 25% | 50%)",
    near(after[0]!.w, start[0]!.w) && near(after[1]!.w, start[2]!.w) && near(after[2]!.w, start[1]!.w),
    `${JSON.stringify(start)} → ${JSON.stringify(after)}`,
  );
  if (shots) await screenshot(join(shots, "resize-reordered.png"));
} catch (e) {
  check("run", false, (e as Error).message);
} finally {
  await app.close();
  mock.kill();
  await stopped(mock);
}
console.log(counter.failures ? `${counter.failures} failed` : "all pane resize checks passed");
process.exit(counter.failures ? 1 : 0);
