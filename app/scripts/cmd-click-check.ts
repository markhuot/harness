// ⌘-click on a board card end to end in the built app, over the DevTools Protocol, against the mock
// service: with tickets stacked beside the board, a ⌘-click opens the card in a new pane on the far
// right of the window, running its full height, and leaves the other panes open; a plain click
// still replaces the ticket pane beside the board. panes.test.ts covers the tree math underneath.
//
//   bun run build && bun scripts/cmd-click-check.ts [--shots=<dir>]
import { join } from "node:path";
import { appDir, checker, launchApp, stopped, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const port = 7800 + Math.floor(Math.random() * 90);
const token = "cmd-click-token";
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
const { js, cdp, screenshot } = app;

try {
  await cdp("Emulation.setDeviceMetricsOverride", { width: 2000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until("board", () => js<boolean>(`!!document.querySelector(".card")`), 15000);

  // board | (NYTIMES-4 over NYTIMES-5)
  const leaf = (id: string, content: object) => ({ type: "leaf", id, content });
  const st = {
    root: {
      type: "split",
      id: "r",
      dir: "row",
      sizes: [0.6, 0.4],
      children: [
        leaf("b", { kind: "board" }),
        { type: "split", id: "c", dir: "column", sizes: [0.5, 0.5], children: [leaf("a", { kind: "ticket", ticketKey: "NYTIMES-4", tab: "spec" }), leaf("d", { kind: "ticket", ticketKey: "NYTIMES-5", tab: "spec" })] },
      ],
    },
    focusedId: null,
    zoomedId: null,
  };
  await js(`localStorage.setItem("harness.panes", ${JSON.stringify(JSON.stringify({ scopes: { "*": st } }))}); dispatchEvent(new StorageEvent("storage", { key: "harness.panes" }))`);
  await js(`location.hash = "#/board/all"`);
  await until("three panes", () => js<boolean>(`document.querySelectorAll(".pane").length === 3 && document.querySelectorAll(".pane-ticket .detail-key").length === 2`), 10000);
  await Bun.sleep(300);

  /** Every pane's label (ticket key or "board") and rect, left to right then top to bottom. */
  const panes = () =>
    js<{ key: string; x: number; y: number; w: number; h: number }[]>(`[...document.querySelectorAll(".pane")].map(p => { const r = p.getBoundingClientRect();
      return { key: p.querySelector(".detail-key")?.textContent ?? "board", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).sort((a, b) => a.x - b.x || a.y - b.y)`);
  // A card that isn't open yet.
  const target = await js<string>(`[...document.querySelectorAll(".card")].map(c => c.dataset.key).find(k => k && k !== "NYTIMES-4" && k !== "NYTIMES-5")`);
  const click = async (key: string, modifiers: number) => {
    const p = await js<{ x: number; y: number }>(`(() => { const el = document.querySelector('.card[data-key="${key}"]'); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 12 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
    // CDP modifiers: Meta = 4.
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1, modifiers });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1, modifiers });
    await Bun.sleep(400);
  };

  await click(target, 4);
  const after = await panes();
  const workspace = await js<{ y: number; h: number; right: number }>(`(() => { const r = document.querySelector(".pane-workspace").getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), right: Math.round(r.right) }; })()`);
  const last = after.at(-1)!;
  check(`⌘-click on ${target} adds a fourth pane, keeping the others`, after.map((p) => p.key).join(",") === `board,NYTIMES-4,NYTIMES-5,${target}`, JSON.stringify(after));
  check("…on the far right of the window", Math.abs(last.x + last.w - workspace.right) <= 2, JSON.stringify({ last, workspace }));
  check("…running its full height", Math.abs(last.y - workspace.y) <= 2 && Math.abs(last.h - workspace.h) <= 2, JSON.stringify({ last, workspace }));
  check("…and focused", await js<boolean>(`document.querySelector(".pane.active .detail-key")?.textContent === ${JSON.stringify(target)}`), "");
  if (shots) await screenshot(join(shots, "cmd-click.png"));

  // A plain click still follows the click-a-card rule: it replaces the top ticket beside the board.
  const other = await js<string>(`[...document.querySelectorAll(".card")].map(c => c.dataset.key).find(k => k && !["NYTIMES-4", "NYTIMES-5", ${JSON.stringify(target)}].includes(k))`);
  await click(other, 0);
  check(`a plain click on ${other} replaces NYTIMES-4 beside the board`, (await panes()).map((p) => p.key).join(",") === `board,${other},NYTIMES-5,${target}`, JSON.stringify(await panes()));
} catch (e) {
  check("run", false, (e as Error).message);
} finally {
  await app.close();
  mock.kill();
  await stopped(mock);
}
console.log(counter.failures ? `${counter.failures} failed` : "all ⌘-click checks passed");
process.exit(counter.failures ? 1 : 0);
