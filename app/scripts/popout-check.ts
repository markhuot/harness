// Pop-out windows end to end in the built app, over the DevTools Protocol, against the mock
// service: pop a ticket pane out with its header button (the pane leaves the board, a new window
// shows just it), work in it, put it back on the board; pop a terminal out and check its shell and
// scrollback came along, then close the window (the shell dies with it); ⇧⌘O pops the focused pane
// out, and closing the pane in the window closes the window.
//
//   bun run build && bun scripts/popout-check.ts [--shots=<dir>]
import { join } from "node:path";
import { api as makeApi, appDir, checker, launchApp, stopped, until } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const port = 7700 + Math.floor(Math.random() * 90);
const token = "popout-token";
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
const { check, ...counter } = checker();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const project = (await api<{ id: string; key: string }[]>("GET", "/projects"))[0]!;
const ticket = await api<{ key: string }>("POST", "/tickets", { projectId: project.id, prompt: "Pop this ticket out into its own window", start: false });
const app = await launchApp({ baseUrl: base, token });
const { js, cdp, go, screenshot, frame, targets } = app;

type Window = Awaited<ReturnType<typeof frame>>;
const popouts = () => targets("page", "#/popout/");
const openPopout = async (): Promise<Window> => {
  const w = await frame("#/popout/", "page");
  await until("pop-out rendered", () => w.js<boolean>(`!!document.querySelector(".popout-window .pane")`), 15000);
  return w;
};
const shoot = async (w: Window, file: string) => {
  const r = await w.cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(file, Buffer.from(r.result.data, "base64"));
  console.log(`  📸 ${file}`);
};
const noPopouts = () => until("pop-out window closed", async () => (await popouts()).length === 0, 8000);

try {
  // 1. A ticket pane pops out with its header button.
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("ticket pane", () => js<boolean>(`!!document.querySelector(".pane-ticket [data-testid=pane-popout]")`), 15000);
  check("a ticket pane has a pop-out button beside Maximize", await js<boolean>(`(() => { const b = document.querySelector(".pane-ticket [data-testid=pane-popout]"); return b?.nextElementSibling?.dataset.testid === "pane-zoom"; })()`));
  check("the board has no pop-out button", !(await js<boolean>(`!!document.querySelector(".pane-board [data-testid=pane-popout]")`)));
  if (shots) await screenshot(join(shots, "popout-before.png"));
  await js(`document.querySelector(".pane-ticket [data-testid=pane-popout]").click()`);
  let pop = await openPopout();
  check("the ticket shows in its own window", (await pop.js<string>(`document.querySelector(".detail-key")?.textContent ?? ""`)) === ticket.key);
  await until("pane left the board", async () => !(await js<boolean>(`!!document.querySelector(".pane-ticket")`)));
  check("the ticket pane left the main window's board", true);
  check("the window is named for the ticket", (await until("title", () => pop.js<string>(`document.title.includes(${JSON.stringify(ticket.key)}) && document.title`))).length > 0);
  const clearsLights = (w: Window) => w.js<boolean>(`harness.platform !== "darwin" || parseFloat(getComputedStyle(document.querySelector(".pane .detail-titlebar")).paddingLeft) >= 80`);
  check("the ticket's header clears the traffic lights", await clearsLights(pop));
  check("the pop-out has Put back instead of Maximize", await pop.js<boolean>(`!!document.querySelector("[data-testid=pane-popin]") && !document.querySelector("[data-testid=pane-zoom]") && !document.querySelector("[data-testid=pane-grip]")`));

  // 2. The pane works as usual in its window: switching tabs.
  await pop.js(`document.querySelector('[data-tab="details"]').click()`);
  await until("details tab", () => pop.js<boolean>(`!!document.querySelector('[data-tab="details"].on')`));
  check("tabs switch in the pop-out", true);
  if (shots) await shoot(pop, join(shots, "popout-ticket.png"));

  // 3. Put back on the board: the window closes and the pane is back, focused, on its tab.
  await pop.js(`document.querySelector("[data-testid=pane-popin]").click()`);
  pop.close();
  await noPopouts();
  check("putting it back closes the window", true);
  const back = await until("pane back on the board", () => js<string>(`document.querySelector(".pane-ticket .detail-key")?.textContent`));
  check("the ticket is back on its board", back === ticket.key && (await js<string>(`location.hash`)).startsWith(`#/board/${project.id}`));
  check("it kept its tab", await js<boolean>(`!!document.querySelector('.pane-ticket [data-tab="details"].on')`));

  // 4. A terminal pops out with its shell: same shell, scrollback replayed.
  await js(`window.__out = {}; harness.terminal.onData((id, d) => { window.__out[id] = (window.__out[id] ?? "") + d; });`);
  await js(`document.querySelector('[data-testid="new-menu"]').click()`);
  await until("New ▾ menu", () => js<boolean>(`!!document.querySelector('[data-testid="new-terminal"]')`));
  await js(`document.querySelector('[data-testid="new-terminal"]').click()`);
  const sid = await until("terminal pane", () => js<string>(`document.querySelector("[data-terminal]")?.dataset.terminal`));
  await until("prompt", async () => (await js<string>(`window.__out[${JSON.stringify(sid)}] ?? ""`)).length > 0, 10000);
  await js(`harness.terminal.write(${JSON.stringify(sid)}, "echo PID=$$ MARK=$((6*7))\\r")`);
  const out = await until("shell output", async () => {
    const o = await js<string>(`window.__out[${JSON.stringify(sid)}] ?? ""`);
    return /PID=\d+ MARK=42/.test(o) ? o : null;
  });
  const pid = Number(/PID=(\d+) MARK=42/.exec(out)![1]);
  await js(`document.querySelector('[data-terminal="${sid}"] [data-testid=pane-popout]').click()`);
  pop = await openPopout();
  const lines = await until("scrollback in the pop-out", async () => {
    const l = await pop.js<string[]>(`(() => { const t = document.querySelector('[data-terminal="${sid}"] .terminal-host')?.harnessTerminal; if (!t) return [];
      const b = t.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? ""); return out; })()`);
    return l.some((x) => x.includes("MARK=42")) ? l : null;
  });
  check("the popped-out terminal shows the same shell's scrollback", lines.some((x) => x.includes(`PID=${pid} MARK=42`)));
  check("the shell kept running through the move", alive(pid) && (await js<string[]>(`harness.terminal.list()`)).includes(sid));
  check("the terminal's header clears the traffic lights", await clearsLights(pop));
  check("the terminal left the main window", !(await js<boolean>(`!!document.querySelector('[data-terminal="${sid}"]')`)));
  await pop.js(`harness.terminal.write(${JSON.stringify(sid)}, "echo FROM-POPOUT\\r")`);
  await until("typing in the pop-out", async () => (await pop.js<string[]>(`(() => { const b = document.querySelector('[data-terminal="${sid}"] .terminal-host').harnessTerminal.buffer.active; const o = []; for (let i = 0; i < b.length; i++) o.push(b.getLine(i)?.translateToString(true) ?? ""); return o; })()`)).some((x) => x === "FROM-POPOUT"));
  check("the shell answers in the pop-out", true);
  if (shots) await shoot(pop, join(shots, "popout-terminal.png"));

  // 5. Closing the window (not the pane) closes the pane too: the shell is killed.
  await pop.js(`window.close()`);
  pop.close();
  await noPopouts();
  const killed = await until("shell killed", async () => !(await js<string[]>(`harness.terminal.list()`)).includes(sid), 8000).catch(() => false);
  check("closing the window ends the shell", !!killed);
  await until("shell process gone", async () => !alive(pid), 5000).catch(() => false);
  check("the shell process is gone", !alive(pid), String(pid));
  check("the terminal didn't come back to the board", !(await js<boolean>(`!!document.querySelector('[data-terminal="${sid}"]')`)));

  // 6. ⇧⌘O pops the focused pane out; closing that pane closes its window.
  await js(`document.querySelector(".pane-ticket .detail-key").closest(".pane").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await js(`document.querySelector('.pane-ticket [data-tab="details"]').focus()`);
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "O", code: "KeyO", windowsVirtualKeyCode: 79, modifiers: 4 | 8 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "O", code: "KeyO", windowsVirtualKeyCode: 79, modifiers: 4 | 8 });
  pop = await openPopout();
  check("⇧⌘O pops the focused ticket out", (await pop.js<string>(`document.querySelector(".detail-key")?.textContent ?? ""`)) === ticket.key);
  await pop.js(`document.querySelector("[data-testid=pane-close]").click()`);
  pop.close();
  await noPopouts();
  check("closing the pane in a pop-out closes the window", true);
  check("a pane closed in its window is closed, not put back", !(await js<boolean>(`!!document.querySelector(".pane-ticket")`)));
  const stored = await js<string[]>(`Object.keys(JSON.parse(localStorage.getItem("harness.panes") ?? "{}").scopes ?? {}).filter((s) => s.startsWith("popout:"))`);
  check("no pop-out is left in the store", stored.length === 0, stored.join(","));
  if (shots) await screenshot(join(shots, "popout-after.png"));
} catch (e) {
  check("run", false, (e as Error).message);
} finally {
  await app.close();
  mock.kill();
  await stopped(mock);
}
console.log(counter.failures ? `${counter.failures} failed` : "all pop-out checks passed");
process.exit(counter.failures ? 1 : 0);
