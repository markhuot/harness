// Terminal panes end to end in the built app, over the DevTools Protocol, against the seeded
// world's service (which hosts the shells): open terminals from the sidebar's New ▾ menu and a
// project's context menu, type into them with real key events, and check the shell's folder,
// re-attaching after a board switch (history kept, nothing printed twice, the PTY resized to the
// remounted pane), exit + Restart, closing a pane (the shell keeps running) and ending a terminal,
// and the shared-session paths: a terminal made elsewhere (the iPhone's `openOnMac`) opens a pane
// in its project's scope, a closed pane stays closed through terminal.updated, a palette selection
// without a local pane goes to the terminal's project, and a smaller device draws the terminal
// smaller than the pane.
//
//   bun run build && bun scripts/terminal-pane-check.ts [--shots=<dir>]
//   bun run package && bun scripts/terminal-pane-check.ts --packaged   # out/Harness-darwin-<arch>/Harness.app
import { realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { bootWorld } from "./lib/world";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const world = await bootWorld();
const { base, token } = world;
const api = makeApi(base, token);
const counter = checker();
const { check } = counter;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A real folder, so `pwd` proves the shell started in the project (a missing one falls back to home).
// Removed at the end, or by tempDir's exit listener if the script dies first.
const projectDir = realpathSync(tempDir("harness-termproj-"));
const project = await api<{ id: string; name: string }>("POST", "/projects", { path: projectDir, key: "TRM", name: "Termproj" });
const app = await launchApp({ baseUrl: base, token, env: { HARNESS_MENU_AUTOPICK: "terminal" }, packaged: process.argv.includes("--packaged") });
const { js, cdp, go, screenshot, key, type } = app;

try {
  await until("sidebar", () => js<boolean>(`!!document.querySelector('[data-testid="new-menu"]')`), 15000);
  await until("the project in the sidebar", () => js<boolean>(`!!document.querySelector('[data-project-id="${project.id}"]')`), 15000);

  /** The session ids of the terminal panes on screen. */
  const shown = () => js<string[]>(`[...document.querySelectorAll("[data-terminal]")].map(e => e.dataset.terminal)`);
  /** Lines of a terminal's screen and scrollback (wrapped rows joined), read from ghostty-web's buffer (the canvas has no text). */
  const screen = (sid: string) =>
    js<string[]>(`(() => { const t = document.querySelector('[data-terminal="${sid}"] .terminal-host')?.harnessTerminal; if (!t) return [];
      const b = t.buffer.active; const out = [];
      for (let i = 0; i < b.length; i++) { const l = b.getLine(i); const text = l?.translateToString(true) ?? "";
        if (l?.isWrapped && out.length) out[out.length - 1] += text; else out.push(text); }
      return out; })()`);
  const size = (sid: string) => js<{ cols: number; rows: number }>(`(() => { const t = document.querySelector('[data-terminal="${sid}"] .terminal-host').harnessTerminal; return { cols: t.cols, rows: t.rows }; })()`);
  /** Type like a person: key events to the focused element (the terminal). */
  const typeKeys = async (text: string) => {
    for (const ch of text) {
      if (ch === "\n") {
        await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await cdp("Input.dispatchKeyEvent", { type: "char", key: "Enter", text: "\r" });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      } else {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
    }
  };
  /** Wait until the terminal's screen (or scrollback) has a line containing `needle`; returns the lines. */
  const waitOut = (sid: string, needle: string | RegExp, ms = 8000) =>
    until(`${sid} prints ${needle}`, async () => {
      const lines = await screen(sid);
      return lines.some((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l))) ? lines : null;
    }, ms);
  /** Wait for a line that is exactly `text` (output, not the typed command). */
  const waitLine = (sid: string, text: string, ms = 8000) => until(`${sid} has the line ${text}`, async () => ((await screen(sid)).includes(text) ? true : null), ms);
  const hasOutput = async (sid: string) => (await screen(sid)).some((l) => l.trim().length > 0);
  let menuShot = 0;
  const openFromSidebar = async () => {
    const before = new Set(await shown());
    await js(`document.querySelector('[data-testid="new-menu"]').click()`);
    await until("New ▾ menu", () => js<boolean>(`!!document.querySelector('[data-testid="new-terminal"]')`));
    if (shots && !menuShot++) await screenshot(join(shots, "new-menu.png"));
    await js(`document.querySelector('[data-testid="new-terminal"]').click()`);
    return until("a new terminal pane", async () => (await shown()).find((id) => !before.has(id)));
  };
  const focusTerminal = (sid: string) => js(`document.querySelector('[data-terminal="${sid}"] .terminal-host').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);

  // 1. A project board: New ▾ → New terminal opens a shell in the project's folder.
  await go(`#/board/${project.id}`);
  await until("project board", () => js<boolean>(`location.hash.startsWith("#/board/${project.id}")`));
  const t1 = await openFromSidebar();
  check("the terminal's id is the service's (t-<hex>)", /^t-[0-9a-f]{12}$/.test(t1), t1);
  const listed1 = await api<{ id: string; projectId: string | null; cwd: string }[]>("GET", "/terminals");
  check("the service lists it, on this project", listed1.some((t) => t.id === t1 && t.projectId === project.id), JSON.stringify(listed1));
  await until("prompt", () => hasOutput(t1), 10000);
  check("a new terminal takes the keyboard", await js<boolean>(`!!document.activeElement?.closest('[data-terminal="${t1}"]')`));
  await typeKeys("echo PID=$$; pwd\n");
  await waitLine(t1, projectDir);
  check("pwd on a project board is the project's folder", true, projectDir);
  const pid1 = Number(/^PID=(\d+)$/.exec((await screen(t1)).find((l) => /^PID=\d+$/.test(l)) ?? "")?.[1]);
  check("the shell is running", pid1 > 0 && alive(pid1), String(pid1));
  check("the shell's output is on screen", (await screen(t1)).some((l) => l.includes(projectDir)));
  if (shots) await screenshot(join(shots, "terminal-project.png"));

  // 1a. Keys: the terminal's keys are handled (default-prevented) by it; ⌘ menu
  //     shortcuts are left unhandled so the native menu gets them (CDP key events never reach the
  //     menu, so this checks the renderer's half).
  const prevented = (init: string) =>
    js<boolean>(`!document.querySelector('[data-terminal="${t1}"] .terminal-host').harnessTerminal.element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ${init} }))`);
  check("a terminal key goes to the terminal", await prevented(`key: "ArrowLeft", code: "ArrowLeft"`)); // harmless at an empty prompt
  check("⌘T, ⌘N and ⌘1 are left for the menu", !(await prevented(`key: "t", code: "KeyT", metaKey: true`)) && !(await prevented(`key: "n", code: "KeyN", metaKey: true`)) && !(await prevented(`key: "1", code: "Digit1", metaKey: true`)));

  // 2. Something interactive: less on the alternate screen, keys and all.
  const altScreen = () => js<boolean>(`document.querySelector('[data-terminal="${t1}"] .terminal-host').harnessTerminal.buffer.active.type === "alternate"`);
  check("the shell is on the normal screen", !(await altScreen()));
  await typeKeys("printf 'alpha\\nbeta\\n' | less\n");
  await until("less on the alternate screen", async () => (await altScreen()) && (await screen(t1)).some((l) => l === "beta"));
  await typeKeys("q");
  await until("back from less", async () => !(await altScreen()));
  check("a full-screen program runs and quits (alternate screen in and out)", true);

  // 2a. vim: insert mode, Escape back to normal mode (it reaches vim, not the workspace), :wq.
  await typeKeys("vim -u NONE -N vim-note.txt\n");
  await until("vim", altScreen, 8000);
  await typeKeys("ihello from vim");
  // Escape is vim's: the terminal handles it, so the workspace's Escape (end a zoom, close a pane) never sees it.
  await js(`window.__esc = 0; addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.defaultPrevented) window.__esc++; })`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await typeKeys(":wq\n");
  await until("vim quit", async () => !(await altScreen()), 8000);
  const note = await Bun.file(join(projectDir, "vim-note.txt")).text().catch(() => "");
  check("vim edits and saves (Escape reached vim)", note.trim() === "hello from vim", JSON.stringify(note));
  check("Escape went to vim, not the pane workspace", (await js<number>(`window.__esc`)) === 0 && (await shown()).includes(t1));

  // 2b. top redraws full screen and quits on q.
  await typeKeys("top -s 1\n");
  await until("top", altScreen, 8000);
  const topScreen = await until("top's header", async () => {
    const lines = await screen(t1);
    return lines.some((l) => /Processes:|PID/.test(l)) ? lines : null;
  }, 10000).catch(() => [] as string[]);
  check("top draws its screen", topScreen.some((l) => /Processes:|PID/.test(l)), topScreen.slice(0, 2).join(" | "));
  if (shots) await screenshot(join(shots, "terminal-top.png"));
  await typeKeys("q");
  await until("top quit", async () => !(await altScreen()), 8000);

  // 2b'. The host fills the pane body (less its inset), not just the shell's own height, so the rows follow the pane.
  const fill = await js<{ bodyH: number; hostH: number; rows: number; cellH: number }>(`(() => { const h = document.querySelector('[data-terminal="${t1}"] .terminal-host'); return { bodyH: h.parentElement.clientHeight, hostH: h.clientHeight, rows: h.harnessTerminal.rows, cellH: h.harnessTerminal.renderer.getMetrics().height }; })()`);
  check("the host fills the pane body, so the shell gets every row that fits", fill.hostH >= fill.bodyH - 12 && fill.rows === Math.floor(fill.hostH / fill.cellH), JSON.stringify(fill));

  // 2c. Zooming the pane resizes the PTY to the bigger terminal.
  await js(`document.querySelector('[data-terminal="${t1}"] [data-testid="pane-zoom"]').click()`);
  const small = await size(t1);
  await until("zoomed wider", async () => (await size(t1)).cols > small.cols || (await js<boolean>(`!!document.querySelector('[data-terminal="${t1}"]').closest(".zoomed")`)), 5000);
  await Bun.sleep(400);
  const big = await size(t1);
  await typeKeys("stty size\n");
  check("zoom reflows the terminal and the PTY follows", !!(await waitLine(t1, `${big.rows} ${big.cols}`).catch(() => "")), `${small.cols}→${big.cols} cols`);
  await js(`document.querySelector('[data-terminal="${t1}"] [data-testid="pane-zoom"]').click()`);
  await Bun.sleep(600);

  // 2d. Copy (Edit → Copy / ⌘C with a selection) and paste.
  const copied = await js<string>(`(() => { const host = document.querySelector('[data-terminal="${t1}"] .terminal-host'); const t = host.harnessTerminal;
    t.selectAll(); const dt = new DataTransfer(); host.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt }));
    t.clearSelection(); return dt.getData("text/plain"); })()`);
  check("copy puts the terminal's selection on the clipboard", copied.includes("stty size"), `${copied.length} chars`);
  await js(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", "echo pasted-$((20+3))\\n");
    const t = document.querySelector('[data-terminal="${t1}"] .terminal-host').harnessTerminal;
    (t.textarea ?? t.element).dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })); })()`);
  // zsh turns on bracketed paste, so the pasted newline is text, not Enter (as in any terminal).
  await waitOut(t1, "pasted-$((20+3))");
  await typeKeys("\n");
  check("paste types into the shell", !!(await waitLine(t1, "pasted-23").catch(() => "")));

  // 2e. Switching light/dark recreates the terminal in the new colors, history intact.
  const bgOf = () => js<string>(`document.querySelector('[data-terminal="${t1}"] .terminal-host').harnessTerminal.options.theme.background`);
  const bg1 = await bgOf();
  const dark = await js<boolean>(`document.documentElement.dataset.theme === "dark"`);
  await js(`harness.setTheme({ preference: ${JSON.stringify(dark ? "light" : "dark")} })`);
  await until("recolored", async () => (await bgOf().catch(() => bg1)) !== bg1, 8000).catch(() => false);
  check("a theme switch recolors the terminal", (await bgOf()) !== bg1, `${bg1} → ${await bgOf()}`);
  check("and keeps its history", (await screen(t1)).join("").includes("pasted-23"));
  if (shots) await screenshot(join(shots, `terminal-${dark ? "light" : "dark"}.png`));
  await js(`harness.setTheme({ preference: "system" })`);

  // 3. All projects: a terminal at home, via the same menu.
  await go("#/board/all");
  await until("t1 unmounted", async () => !(await shown()).includes(t1));
  const t2 = await openFromSidebar();
  await until("t2 prompt", () => hasOutput(t2), 10000);
  await typeKeys("pwd\n");
  check("pwd on All projects is home", !!(await waitLine(t2, homedir())));

  // 4. Back to the project while it prints: the terminal re-attaches to the same shell, keeps its
  //    history, and prints nothing twice. The sidebar is collapsed while away, so the pane comes
  //    back wider and the PTY has to follow it.
  await go(`#/board/${project.id}`);
  await until("t1 back", async () => (await shown()).includes(t1));
  await focusTerminal(t1);
  // A steady stream (a chunk every few ms) through the remount, so output lands while the pane is
  // re-attaching: that's what the drop-until-ensure-resolves rule is for.
  await typeKeys("for i in $(seq 1 600); do echo L$i; sleep 0.001; done; echo LOOP-DONE\n");
  await waitLine(t1, "L20");
  await go("#/board/all");
  await until("t1 away", async () => !(await shown()).includes(t1));
  const before = await js<number>(`document.querySelector(".main").clientWidth`);
  // CDP key events skip the native menu, so ⌃⌘S reaches the window listener only from outside the terminal (which keeps its ⌘ keys for the menu).
  await js(`document.activeElement?.blur()`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 | 4 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 | 4 });
  await until("sidebar collapsed", async () => (await js<number>(`document.querySelector(".main").clientWidth`)) > before);
  await go(`#/board/${project.id}`);
  await until("t1 back again", async () => (await shown()).includes(t1));
  await waitLine(t1, "LOOP-DONE", 30000);
  await until("screen shows LOOP-DONE", async () => (await screen(t1)).some((l) => l === "LOOP-DONE"), 5000).catch(() => false);
  const lines = (await screen(t1)).filter((l) => /^L\d+$/.test(l));
  const expected = Array.from({ length: 600 }, (_, i) => `L${i + 1}`);
  check("history survives the switch: every line once, in order", JSON.stringify(lines) === JSON.stringify(expected), `${lines.length} lines, first dup: ${lines.find((l, i) => lines.indexOf(l) !== i) ?? "none"}`);
  const all = await screen(t1);
  // Rows replayed into scrollback don't carry isWrapped, so a long path can span rows: search them joined.
  check("the prompt and earlier output are still there", all.join("").includes(projectDir), `${all.length} lines; first: ${JSON.stringify(all.slice(0, 3))}`);
  const want = await size(t1);
  await focusTerminal(t1);
  await typeKeys("stty size\n");
  const sized = await waitLine(t1, `${want.rows} ${want.cols}`).catch(() => "");
  check("the PTY follows the remounted pane's size", !!sized, `${want.rows} ${want.cols}`);
  check("same shell after the switch", alive(pid1));

  // 5. A project's context menu: New terminal in <project> (the native menu is auto-picked).
  await go("#/inbox");
  await until("inbox", () => js<boolean>(`location.hash.startsWith("#/inbox")`));
  await js(`document.querySelector('[data-project-id="${project.id}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("back on the project board", () => js<boolean>(`location.hash.startsWith("#/board/${project.id}")`));
  const t3 = await until("the context-menu terminal", async () => (await shown()).find((id) => id !== t1));
  await until("t3 prompt", () => hasOutput(t3), 10000);

  // 6. Exit shows the code; Restart gives a new shell in the same pane (a new terminal, same folder).
  await focusTerminal(t3);
  await typeKeys("exit 3\n");
  await until("exit overlay", () => js<boolean>(`!!document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-exit"]')`));
  check("an exited shell says so", (await js<string>(`document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-exit"]').textContent`)).includes("code 3"));
  await js(`document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-restart"]').click()`);
  const t3b = await until("the restarted terminal's pane", async () => (await shown()).find((id) => id !== t1 && id !== t3 && id !== t2));
  await until("restarted prompt", () => hasOutput(t3b), 10000);
  await focusTerminal(t3b);
  await typeKeys("echo again-$((40+2))\n");
  check("Restart starts a working shell", !!(await waitLine(t3b, "again-42")));

  // 7. Closing a pane leaves its shell running; End terminal hangs it up.
  await js(`document.querySelector('[data-terminal="${t1}"] [data-testid="pane-close"]').click()`);
  await until("t1 pane gone", async () => !(await shown()).includes(t1));
  await Bun.sleep(500);
  const afterClose = await api<{ id: string }[]>("GET", "/terminals");
  check("closing the pane keeps the shell and its terminal", afterClose.some((t) => t.id === t1) && alive(pid1), String(pid1));
  await js(`document.querySelector('[data-terminal="${t3b}"] button[title="More"]').click()`);
  await until("pane menu", () => js<boolean>(`[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "End terminal")`));
  await js(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "End terminal").click()`);
  await until("t3b pane gone", async () => !(await shown()).includes(t3b));
  const ended = await until("t3b ended on the service", async () => {
    const ids = (await api<{ id: string }[]>("GET", "/terminals")).map((t) => t.id);
    return !ids.includes(t3b) ? ids : null;
  });
  check("End terminal removes it from the service", !ended.includes(t3b) && ended.includes(t1) && ended.includes(t2), ended.join(","));

  // 8. A reload keeps the shells: the pane re-attaches to the same one with its history.
  await go("#/board/all");
  await until("t2 shown", async () => (await shown()).includes(t2));
  await js(`location.reload()`);
  await until("reloaded", () => js<boolean>(`!!document.querySelector('[data-testid="new-menu"]')`), 15000);
  await until("t2 back after the reload", async () => (await shown()).includes(t2), 15000);
  await waitLine(t2, homedir(), 10000);
  check("a reload re-attaches to the running shell, history restored from the snapshot", true);
  if (shots) await screenshot(join(shots, "terminal-after-reload.png"));

  // 9. A terminal made elsewhere (the iPhone's New Terminal) opens a pane on its project's board.
  await go("#/board/all");
  await Bun.sleep(1500); // this window's presence (platform mac) has to reach the service before it can be asked to open a pane
  const made = await api<{ id: string }>("POST", "/terminals", { projectId: project.id, deviceId: "iphone-test", openOnMac: true, cols: 62, rows: 18 });
  await go(`#/board/${project.id}`);
  await until("the pane opened for the iPhone's terminal", async () => (await shown()).includes(made.id), 10000);
  check("a terminal made with openOnMac gets a pane on its project's board", true, made.id);

  // 9a. A smaller device attached: the Mac draws the terminal at the smaller size, centered.
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.send(JSON.stringify({ type: "terminal.attach", id: made.id, deviceId: "iphone-test", cols: 40, rows: 12 }));
  await until("shrunk to the phone's size", async () => ((await size(made.id)).cols === 40 && (await size(made.id)).rows === 12 ? true : null), 10000);
  check("the terminal is drawn at the smaller device's size", true, JSON.stringify(await size(made.id)));
  check("the pane says it's shared at a smaller size", await js<boolean>(`!!document.querySelector('[data-terminal="${made.id}"] [data-testid="terminal-shared"]')`));
  if (shots) await screenshot(join(shots, "terminal-shared-smaller.png"));
  const hostBox = await js<{ w: number; h: number; tw: number }>(`(() => { const h = document.querySelector('[data-terminal="${made.id}"] .terminal-host'); const c = h.querySelector("canvas"); return { w: h.clientWidth, h: h.clientHeight, tw: c.clientWidth }; })()`);
  check("it stays centered with the rest of the pane empty", hostBox.tw < hostBox.w, JSON.stringify(hostBox));
  ws.send(JSON.stringify({ type: "terminal.detach", id: made.id }));
  await until("grown back once the phone leaves", async () => ((await size(made.id)).cols > 40 ? true : null), 10000);
  ws.close();

  // 10. A closed pane stays closed through terminal.updated (a title change).
  await js(`document.querySelector('[data-terminal="${made.id}"] [data-testid="pane-close"]').click()`);
  await until("made pane closed", async () => !(await shown()).includes(made.id));
  const ws2 = new WebSocket(`${base.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((r) => (ws2.onopen = () => r()));
  ws2.send(JSON.stringify({ type: "terminal.attach", id: made.id, deviceId: "iphone-test", cols: 80, rows: 24 }));
  ws2.send(JSON.stringify({ type: "terminal.write", id: made.id, data: "printf '\\033]0;renamed\\007'\r" }));
  await until("the service reports the new title", async () => ((await api<{ id: string; title: string }[]>("GET", "/terminals")).find((t) => t.id === made.id)?.title === "renamed" ? true : null), 10000);
  await Bun.sleep(1500);
  check("terminal.updated doesn't reopen a closed pane", !(await shown()).includes(made.id));
  ws2.close();

  // 11. The palette lists terminals (title, folder, program) and selecting one with no local pane goes to its project.
  await go("#/board/all");
  await until("all board", () => js<boolean>(`location.hash.startsWith("#/board/all")`), 5000);
  await Bun.sleep(600); // a terminal pane takes the focus a moment after it mounts
  await js(`document.activeElement?.blur()`);
  await key("k", "KeyK", 75, 4);
  await until("palette", () => js<boolean>(`!!document.querySelector("[data-testid=palette-input]")`), 5000);
  await type("[data-testid=palette-input]", "renamed");
  await until("the terminal's row", () => js<boolean>(`!!document.querySelector('[data-testid=palette-row][data-id="terminal:${made.id}"]')`), 5000);
  const rowText = await js<string>(`document.querySelector('[data-testid=palette-row][data-id="terminal:${made.id}"]').textContent`);
  check("the palette row shows the title and the folder", rowText.includes("renamed") && rowText.includes("~"), rowText);
  if (shots) await screenshot(join(shots, "terminal-palette.png"));
  await key("Enter", "Enter", 13);
  await until("went to the terminal's project", () => js<boolean>(`location.hash.startsWith("#/board/${project.id}")`), 5000);
  await until("its pane", async () => (await shown()).includes(made.id), 5000);
  check("selecting a terminal with no local pane opens it on its project's board", true);
} catch (e) {
  check("run", false, (e as Error).message);
} finally {
  await app.close();
  await world.stop();
  rmSync(projectDir, { recursive: true, force: true });
}
console.log(counter.failures ? `${counter.failures} failed` : "all terminal pane checks passed");
process.exit(counter.failures ? 1 : 0);
