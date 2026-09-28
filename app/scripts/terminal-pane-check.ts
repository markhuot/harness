// Terminal panes end to end in the built app, over the DevTools Protocol, against the mock
// service: open terminals from the sidebar's New ▾ menu and a project's context menu, type into
// them with real key events, and check the shell's folder, re-attaching after a board switch
// (history kept, nothing printed twice, the PTY resized to the remounted pane), exit + Restart,
// closing (the shell dies), and the startup reconcile after a reload. scripts/terminal-check.ts
// covers the bridge underneath.
//
//   bun run build && bun scripts/terminal-pane-check.ts [--shots=<dir>]
//   bun run package && bun scripts/terminal-pane-check.ts --packaged   # out/Harness-darwin-<arch>/Harness.app
import { realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const port = 7700 + Math.floor(Math.random() * 90);
const token = "term-token";
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
const { js, cdp, go, screenshot } = app;

try {
  await until("sidebar", () => js<boolean>(`!!document.querySelector('[data-testid="new-menu"]')`), 15000);
  await js(`window.__out = {}; harness.terminal.onData((id, d) => { window.__out[id] = (window.__out[id] ?? "") + d; });`);

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
  const waitOut = (sid: string, needle: string | RegExp, ms = 8000) =>
    until(`${sid} prints ${needle}`, async () => {
      const o = await js<string>(`window.__out[${JSON.stringify(sid)}] ?? ""`);
      return (typeof needle === "string" ? o.includes(needle) : needle.test(o)) ? o : null;
    }, ms);
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
  check("the terminal's session id is t:<uuid>", /^t:[0-9a-f-]{36}$/.test(t1), t1);
  await until("prompt", async () => (await js<string>(`window.__out[${JSON.stringify(t1)}] ?? ""`)).length > 0, 10000);
  check("a new terminal takes the keyboard", await js<boolean>(`!!document.activeElement?.closest('[data-terminal="${t1}"]')`));
  await typeKeys("echo PID=$$; pwd\n");
  // pwd's own output line (the path can also show up earlier, in a title escape sequence).
  const pwdOut = await waitOut(t1, `\r\n${projectDir}\r\n`);
  check("pwd on a project board is the project's folder", pwdOut.includes(`\n${projectDir}\r`), projectDir);
  const pid1 = Number(/PID=(\d+)/.exec(pwdOut)?.[1]);
  check("the shell is running", pid1 > 0 && alive(pid1), String(pid1));
  check("the shell's output is on screen", (await screen(t1)).some((l) => l.includes(projectDir)));
  if (shots) await screenshot(join(shots, "terminal-project.png"));

  // 1a. Keys: the terminal's keys are handled (default-prevented) by it; ⌘ menu
  //     shortcuts are left unhandled so the native menu gets them (CDP key events never reach the
  //     menu, so this checks the renderer's half).
  const prevented = (init: string) =>
    js<boolean>(`!document.querySelector('[data-terminal="${t1}"] .terminal-host').dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ${init} }))`);
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

  // 2c. Zooming the pane resizes the PTY to the bigger terminal.
  await js(`document.querySelector('[data-terminal="${t1}"] [data-testid="pane-zoom"]').click()`);
  const small = await size(t1);
  await until("zoomed wider", async () => (await size(t1)).cols > small.cols || (await js<boolean>(`!!document.querySelector('[data-terminal="${t1}"]').closest(".zoomed")`)), 5000);
  await Bun.sleep(400);
  const big = await size(t1);
  await typeKeys("stty size\n");
  check("zoom reflows the terminal and the PTY follows", !!(await waitOut(t1, `${big.rows} ${big.cols}`).catch(() => "")), `${small.cols}→${big.cols} cols`);
  await js(`document.querySelector('[data-terminal="${t1}"] [data-testid="pane-zoom"]').click()`);

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
  check("paste types into the shell", (await waitOut(t1, "\r\npasted-23").catch(() => "")).includes("pasted-23"));

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
  await until("t2 prompt", async () => (await js<string>(`window.__out[${JSON.stringify(t2)}] ?? ""`)).length > 0, 10000);
  await typeKeys("pwd\n");
  check("pwd on All projects is home", (await waitOut(t2, `\r\n${homedir()}\r\n`)).includes(`\n${homedir()}\r`));

  // 4. Back to the project while it prints: the terminal re-attaches to the same shell, keeps its
  //    history, and prints nothing twice. The sidebar is collapsed while away, so the pane comes
  //    back wider and the PTY has to follow it.
  await go(`#/board/${project.id}`);
  await until("t1 back", async () => (await shown()).includes(t1));
  await focusTerminal(t1);
  // A steady stream (a chunk every few ms) through the remount, so output lands while the pane is
  // re-attaching: that's what the drop-until-ensure-resolves rule is for.
  await typeKeys("for i in $(seq 1 600); do echo L$i; sleep 0.001; done; echo LOOP-DONE\n");
  await waitOut(t1, "L20\r\n");
  await go("#/board/all");
  await until("t1 away", async () => !(await shown()).includes(t1));
  const before = await js<number>(`document.querySelector(".main").clientWidth`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 | 4 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: 2 | 4 });
  await until("sidebar collapsed", async () => (await js<number>(`document.querySelector(".main").clientWidth`)) > before);
  await go(`#/board/${project.id}`);
  await until("t1 back again", async () => (await shown()).includes(t1));
  await waitOut(t1, "LOOP-DONE\r\n", 30000);
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
  const sized = await waitOut(t1, `${want.rows} ${want.cols}`).catch(() => "");
  check("the PTY follows the remounted pane's size", !!sized, `${want.rows} ${want.cols}`);
  check("same shell after the switch", alive(pid1));

  // 5. A project's context menu: New terminal in <project> (the native menu is auto-picked).
  await go("#/inbox");
  await until("inbox", () => js<boolean>(`location.hash.startsWith("#/inbox")`));
  await js(`document.querySelector('[data-project-id="${project.id}"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
  await until("back on the project board", () => js<boolean>(`location.hash.startsWith("#/board/${project.id}")`));
  const t3 = await until("the context-menu terminal", async () => (await shown()).find((id) => id !== t1));
  await until("t3 prompt", async () => (await js<string>(`window.__out[${JSON.stringify(t3)}] ?? ""`)).length > 0, 10000);

  // 6. Exit shows the code; Restart gives a new shell in the same pane.
  await focusTerminal(t3);
  await typeKeys("exit 3\n");
  await until("exit overlay", () => js<boolean>(`!!document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-exit"]')`));
  check("an exited shell says so", (await js<string>(`document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-exit"]').textContent`)).includes("code 3"));
  await js(`window.__out[${JSON.stringify(t3)}] = ""; document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-restart"]').click()`);
  await until("restarted", async () => !(await js<boolean>(`!!document.querySelector('[data-terminal="${t3}"] [data-testid="terminal-exit"]')`)) && (await js<string>(`window.__out[${JSON.stringify(t3)}] ?? ""`)).length > 0, 10000);
  await focusTerminal(t3);
  await typeKeys("echo again-$((40+2))\n");
  check("Restart starts a working shell", (await waitOut(t3, "again-42")).includes("again-42"));

  // 7. Closing a terminal pane ends its shell.
  await js(`document.querySelector('[data-terminal="${t1}"] [data-testid="pane-close"]').click()`);
  await until("t1 pane gone", async () => !(await shown()).includes(t1));
  const listed = await until("t1 killed", async () => {
    const ids = await js<string[]>(`harness.terminal.list()`);
    return !ids.includes(t1) ? ids : null;
  });
  check("closing the pane forgets the session", !listed.includes(t1) && listed.includes(t2) && listed.includes(t3), listed.join(","));
  await until("shell process gone", async () => !alive(pid1), 5000).catch(() => false);
  check("closing the pane kills the shell", !alive(pid1), String(pid1));

  // 8. A reload kills shells no pane shows (an orphan), and keeps the ones that are still open.
  await js(`harness.terminal.ensure("t:orphan", { cols: 80, rows: 24 })`);
  await js(`location.reload()`);
  await until("reloaded", () => js<boolean>(`!!document.querySelector('[data-testid="new-menu"]')`), 15000);
  const afterReload = await until("orphan reconciled", async () => {
    const ids = await js<string[]>(`harness.terminal.list()`);
    return !ids.includes("t:orphan") ? ids : null;
  });
  check("startup reconcile kills the orphan and keeps open terminals", afterReload.includes(t2) && afterReload.includes(t3), afterReload.join(","));
  if (shots) await screenshot(join(shots, "terminal-after-reload.png"));
} catch (e) {
  check("run", false, (e as Error).message);
} finally {
  await app.close();
  mock.kill();
  await stopped(mock);
  rmSync(projectDir, { recursive: true, force: true });
}
console.log(counter.failures ? `${counter.failures} failed` : "all terminal pane checks passed");
process.exit(counter.failures ? 1 : 0);
