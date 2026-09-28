// Drive the terminal bridge (window.harness.terminal) in a real app over the DevTools Protocol:
// spawn a shell, echo through it, re-attach with scrollback, exit codes, input validation, and no
// shells left behind after the app quits. The renderer needs no service for this.
//
//   bun run build && bun scripts/terminal-check.ts              # dev build (electron .)
//   bun run package && bun scripts/terminal-check.ts --packaged # out/Harness-darwin-<arch>/Harness.app
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDir, checker, until } from "./lib/drive";

const packaged = process.argv.includes("--packaged");
const cdpPort = 9300 + Math.floor(Math.random() * 600);
const bin = packaged ? join(appDir, "out", `Harness-darwin-${process.arch}`, "Harness.app", "Contents", "MacOS", "Harness") : join(appDir, "..", "node_modules", ".bin", "electron");
const proc = Bun.spawn([bin, ...(packaged ? [] : [appDir]), `--remote-debugging-port=${cdpPort}`], {
  env: { ...process.env, HARNESS_URL: "http://127.0.0.1:9", HARNESS_TOKEN: "x", HARNESS_USER_DATA: mkdtempSync(join(tmpdir(), "harness-term-")) },
  stdout: "ignore",
  stderr: "ignore",
});

const target = await until(
  "devtools target",
  async () => {
    const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    return list.find((t) => t.type === "page" && t.url.startsWith("file://"));
  },
  15000,
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  pending.get(msg.id)?.(msg);
};
const js = <T = unknown>(expression: string) =>
  new Promise<T>((resolve, reject) => {
    const n = ++seq;
    pending.set(n, (res) => (res.result?.exceptionDetails ? reject(new Error(res.result.exceptionDetails.exception?.description)) : resolve(res.result?.result?.value)));
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });

const checks = checker();
const { check } = checks;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

await until("bridge", () => js<boolean>("!!window.harness?.terminal"));
await js(`window.__out = {}; window.__exits = {};
  harness.terminal.onData((id, d) => { window.__out[id] = (window.__out[id] ?? "") + d; });
  harness.terminal.onExit((id, e) => { window.__exits[id] = e; });`);

const first = await js<{ created: boolean; pid: number; cwd: string }>(`harness.terminal.ensure("t1", { cwd: "~", cols: 80, rows: 24 })`);
check("ensure spawns a shell in home", first.created && first.pid > 0 && first.cwd === process.env.HOME, JSON.stringify(first));
check("write → data", await js(`harness.terminal.write("t1", "echo hi-$((6*7)) $TERM\\r")`) === true);
const out = await until("echo output", async () => {
  const o = await js<string>(`window.__out.t1 ?? ""`);
  return o.includes("hi-42 xterm-256color") ? o : null;
});
check("output streams to the renderer", out.includes("hi-42 xterm-256color"));
const again = await js<{ created: boolean; pid: number; scrollback: string }>(`harness.terminal.ensure("t1", { cols: 80, rows: 24 })`);
check("ensure re-attaches (same pid) with scrollback", !again.created && again.pid === first.pid && again.scrollback.includes("hi-42"));
check("resize", (await js(`harness.terminal.resize("t1", 120, 40)`)) === true);
await js(`harness.terminal.write("t1", "stty size\\r")`);
const sized = await until("stty size", async () => (await js<string>(`window.__out.t1`)).includes("40 120")).catch(() => false);
check("resize reaches the pty", sized);

await js(`harness.terminal.ensure("t2", { cwd: "/definitely/not/here", cols: 80, rows: 24 })`);
await js(`harness.terminal.write("t2", "exit 5\\r")`);
const exit = await until("exit event", () => js<{ exitCode: number } | undefined>(`window.__exits.t2`));
check("exit event carries the exit code", exit.exitCode === 5, JSON.stringify(exit));
check("an exited session stays listed", JSON.stringify(await js(`harness.terminal.list()`)) === '["t1","t2"]');
check("kill forgets it", (await js(`harness.terminal.kill("t2")`)) === true && JSON.stringify(await js(`harness.terminal.list()`)) === '["t1"]');

const rejected = await js<string>(`harness.terminal.ensure("../bad id", { cols: 80, rows: 24 }).then(() => "accepted", (e) => String(e))`);
check("main rejects a malformed id", rejected.includes("terminal id"), rejected);
const badSize = await js<string>(`harness.terminal.resize("t1", 0, 1e9).then(() => "accepted", (e) => String(e))`);
check("main rejects a bad size", badSize.includes("cols"), badSize);

// Quitting the app ends every shell, busy or idle.
const t3 = await js<{ pid: number }>(`harness.terminal.ensure("t3", { cols: 80, rows: 24 })`);
await js(`harness.terminal.write("t3", "sleep 600\\r")`);
await Bun.sleep(300);
ws.close();
proc.kill("SIGTERM");
await proc.exited;
await until("shells gone after quit", async () => !alive(first.pid) && !alive(t3.pid), 5000).catch(() => false);
check("no shells survive the app", !alive(first.pid) && !alive(t3.pid), `t1 ${alive(first.pid)} t3 ${alive(t3.pid)}`);
console.log(checks.failures ? `${checks.failures} failed` : "all terminal checks passed");
process.exit(checks.failures ? 1 : 0);
