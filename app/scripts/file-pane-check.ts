// File panes end to end in the built app, against the REAL service (throwaway HARNESS_HOME) and a
// throwaway git project: a file link in a ticket's brief opens the file beside the ticket, scrolled
// to and highlighting its lines; another range reuses the pane; a dirty file has a Diff tab drawn by
// @pierre/diffs, a clean one doesn't; a gitignored file opens; and the pane survives a reload.
//
//   bun run build && bun scripts/file-pane-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-file-home-");
const projectDir = tempDir("harness-file-project-");
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: projectDir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
const lines = Array.from({ length: 120 }, (_, i) => `export const value${i + 1} = ${i + 1}; // line ${i + 1}`);
mkdirSync(join(projectDir, "src"), { recursive: true });
writeFileSync(join(projectDir, "src/app.ts"), lines.join("\n") + "\n");
writeFileSync(join(projectDir, "src/clean.ts"), "export function clean() {\n  return 1;\n}\n");
writeFileSync(join(projectDir, "src/long.ts"), Array.from({ length: 200 }, (_, i) => `const long${i + 1} = "row ${i + 1}";`).join("\n") + "\n");
writeFileSync(join(projectDir, ".gitignore"), "debug.log\n");
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "init");
// Uncommitted: line 15 changes and a function is added at the end.
writeFileSync(join(projectDir, "src/app.ts"), lines.map((l, i) => (i === 14 ? "export const value15 = 1500; // changed" : l)).join("\n") + "\nexport function added() {\n  return 42;\n}\n");
writeFileSync(join(projectDir, "debug.log"), "ignored by git\n");

const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1" },
  stdout: "ignore",
  stderr: "inherit",
});

const counter = checker();
const { check } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  if (!shots || !app) return;
  await Bun.sleep(400);
  await app.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "files", key: "FILES" });
  const brief = [
    "Look at [app.ts:10-20](harness://file/src/app.ts#L10-L20) first,",
    "then [the tail](harness://file/src/app.ts#L100-L104), [long.ts:150-152](src/long.ts#L150-L152), [clean.ts](src/clean.ts#L2),",
    "the log [debug.log](debug.log) and [a missing one](harness://file/nope.ts).",
  ].join(" ");
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: brief, driver: "dummy", start: false });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("files")`), 10000);
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("the brief's file links render", () => js<number>(`document.querySelectorAll('.pane-ticket [data-testid="file-link"]').length`).then((n) => n >= 6 && n), 10000); // the dummy plan run may repeat them

  const clickLink = (text: string) =>
    js<boolean>(`(() => { const a = [...document.querySelectorAll('.pane-ticket [data-testid="file-link"]')].find(e => e.textContent.includes(${JSON.stringify(text)})); a?.click(); return !!a; })()`);
  /** Lines pierre marks selected in the file pane, and where line `n` sits relative to the scroller. */
  const fileState = (n: number) =>
    js<{ selected: number[]; top: number; height: number; panes: number } | null>(`(() => {
      const body = document.querySelector('[data-testid="file-body"]');
      const host = body?.querySelector("diffs-container");
      const doc = host?.shadowRoot;
      if (!doc) return null;
      const sel = [...doc.querySelectorAll('[data-selected-line][data-line]')].map(e => Number(e.dataset.line));
      const el = doc.querySelector('[data-line="${n}"]');
      if (!el) return null;
      const b = body.getBoundingClientRect();
      return { selected: [...new Set(sel)], top: el.getBoundingClientRect().top - b.top, height: b.height, panes: document.querySelectorAll('[data-testid="pane-file"]').length };
    })()`);

  // 0. The viewer's chunk failing to load shows an error in the pane (the rest of the workspace
  // stays up), and Reload window brings the pane back with the viewer once it's reachable.
  await app.cdp("Network.enable");
  await app.cdp("Network.setBlockedURLs", { urls: ["*FileViewer-*"] });
  check("clicked app.ts:10-20 (viewer chunk blocked)", await clickLink("app.ts:10-20"));
  const failed = await until("viewer load error in the pane", () => js<string>(`document.querySelector('.file-pane [data-testid="file-problem"]')?.textContent ?? ""`), 10000).catch(() => "");
  check("a chunk that won't load shows an error state in the pane", failed.includes("Couldn't show this file"), failed);
  check("the ticket pane survives the failed chunk", await exists('[data-testid="pane-ticket"] .detail'));
  await app.cdp("Network.setBlockedURLs", { urls: [] });
  check("the error offers Reload window", (await js<string>(`document.querySelector('[data-testid="file-retry"]')?.textContent ?? ""`)).includes("Reload window"));
  await js(`document.querySelector('[data-testid="file-retry"]').click()`);
  check("reloading restores the pane with the viewer", !!(await until("viewer after reload", () => js<boolean>(`!!document.querySelector('[data-testid="file-body"] diffs-container')`), 15000).catch(() => false)));
  await until("brief links after reload", () => js<number>(`document.querySelectorAll('.pane-ticket [data-testid="file-link"]').length`).then((n) => n >= 6 && n), 10000);

  // 1. A ranged link opens the file beside the ticket, highlighted and scrolled to.
  check("clicked app.ts:10-20", await clickLink("app.ts:10-20"));
  const opened = await until("file pane shows lines 10-20 selected", async () => {
    const s = await fileState(10);
    return s && s.selected.includes(10) && s.selected.includes(20) && s;
  }, 10000);
  check("opens one file pane", opened.panes === 1);
  check("lines 10–20 are highlighted (and only those)", opened.selected.length === 11 && Math.min(...opened.selected) === 10 && Math.max(...opened.selected) === 20, JSON.stringify(opened.selected));
  const order = await js<string[]>(`[...document.querySelectorAll(".pane")].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(p => p.dataset.testid)`);
  check("the file pane docks right of the ticket", order.join(",") === "pane-board,pane-ticket,pane-file", order.join(","));
  check("line 10 is in view", opened.top >= 0 && opened.top < opened.height, `top=${opened.top} height=${opened.height}`);
  check("syntax colored (pierre tokens)", await js<boolean>(`(() => { const d = document.querySelector('[data-testid="file-body"] diffs-container')?.shadowRoot; return !!d && [...d.querySelectorAll('[data-line] span[style]')].length > 20; })()`));
  check("modified badge", (await js<string>(`document.querySelector('[data-testid="file-git-state"]')?.textContent ?? ""`)) === "modified");
  check("Diff tab offered for a dirty file", await exists('.file-tabs [data-tab="diff"]'));
  await shot("file-pane-range");

  // 2. Another range of the same file reuses the pane and scrolls there.
  check("clicked the tail link", await clickLink("the tail"));
  const tail = await until("lines 100-104 selected", async () => {
    const s = await fileState(100);
    return s && s.selected.includes(100) && !s.selected.includes(10) && s;
  });
  check("still one file pane", tail.panes === 1);
  check("line 100 scrolled into view", tail.top >= 0 && tail.top < tail.height, `top=${tail.top}`);

  // 2b. Clicking a line number picks that line (a real mouse click), without scrolling away.
  const num = await js<{ x: number; y: number; scroll: number } | null>(`(() => {
    const body = document.querySelector('[data-testid="file-body"]');
    const el = body.querySelector("diffs-container").shadowRoot.querySelector('[data-column-number="102"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, scroll: body.scrollTop };
  })()`);
  if (num) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await app.cdp("Input.dispatchMouseEvent", { type, x: num.x, y: num.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    const picked = await until("line 102 picked", async () => {
      const s = await fileState(102);
      return s && s.selected.length === 1 && s.selected[0] === 102 && s;
    }).catch(() => null);
    check("clicking a line number selects that line", !!picked, JSON.stringify(picked?.selected));
    const stored = await js<string>(`localStorage.getItem("harness.panes") ?? ""`);
    check("the picked line is kept with the pane", stored.includes('"startLine":102') && !stored.includes('"endLine":104'));
    check("picking a line doesn't scroll", Math.abs((await js<number>(`document.querySelector('[data-testid="file-body"]').scrollTop`)) - num.scroll) < 2);
  } else check("line number 102 rendered", false);

  // 3. The Diff tab renders the working-tree diff with pierre.
  await js(`document.querySelector('.file-tabs [data-tab="diff"]').click()`);
  const diff = await until("diff renders", () =>
    js<{ adds: number; dels: number } | null>(`(() => {
      const d = document.querySelector('[data-testid="file-body"][data-tab="diff"] diffs-container')?.shadowRoot;
      if (!d) return null;
      const adds = d.querySelectorAll('[data-line-type="change-addition"]').length, dels = d.querySelectorAll('[data-line-type="change-deletion"]').length;
      return adds && dels ? { adds, dels } : null;
    })()`), 10000);
  check("diff shows additions and deletions", diff.adds >= 4 && diff.dels >= 1, JSON.stringify(diff));
  await shot("file-pane-diff");

  // 3b. Another file replaces app.ts beside the ticket. Its header must never sit over app.ts's
  // text or diff, and it scrolls to its own range. A MutationObserver watches every frame.
  await js(`(() => {
    window.__staleFile = [];
    const look = () => {
      const pane = document.querySelector(".file-pane");
      if (pane?.querySelector(".file-name")?.textContent !== "long.ts") return; // what the header says, not data-file
      const d = pane.querySelector('[data-testid="file-body"] diffs-container')?.shadowRoot;
      const text = (d?.textContent ?? "") + (pane.querySelector(".file-plain")?.textContent ?? "");
      if (text.includes("export const value")) window.__staleFile.push(text.slice(0, 80));
    };
    window.__staleObs = new MutationObserver(look);
    window.__staleObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  })()`);
  check("clicked long.ts:150-152", await clickLink("long.ts:150-152"));
  const long = await until("long.ts shows 150-152 selected", async () => {
    const s = await fileState(150);
    return s && s.selected.includes(150) && s.selected.includes(152) && s;
  }, 10000);
  const stale = await js<string[]>(`(window.__staleObs.disconnect(), window.__staleFile)`);
  check("B's header never shows A's contents or diff", stale.length === 0, stale.slice(0, 2).join(" | "));
  check("B opens on the File tab", await js<boolean>(`document.querySelector('[data-testid="file-body"]').dataset.tab === "file"`));
  check("B replaced A (still one file pane)", long.panes === 1);
  check("B scrolls to its range", long.top >= 0 && long.top < long.height, `top=${long.top} height=${long.height}`);
  check("B's range is exactly 150-152", long.selected.length === 3, JSON.stringify(long.selected));

  // 4. A clean file: no Diff tab; the link replaces the file pane beside the ticket.
  check("clicked clean.ts", await clickLink("clean.ts"));
  await until("clean.ts shown", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "src/clean.ts"`));
  await until("clean.ts loaded", () => js<boolean>(`!!document.querySelector('[data-testid="file-body"] diffs-container')`));
  check("clean file: no Diff tab", !(await exists(".file-tabs")));
  check("clean file: no git badge", !(await exists('[data-testid="file-git-state"]')));
  check("still one file pane (replaced beside the ticket)", (await js<number>(`document.querySelectorAll('[data-testid="pane-file"]').length`)) === 1);

  // 5. A gitignored file opens, marked ignored.
  check("clicked debug.log", await clickLink("debug.log"));
  await until("debug.log opens", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "debug.log" && !!document.querySelector('[data-testid="file-ignored"]')`));
  check("ignored file shows its contents", await until("contents", () => js<boolean>(`(document.querySelector('[data-testid="file-body"] diffs-container')?.shadowRoot?.textContent ?? document.querySelector(".file-plain")?.textContent ?? "").includes("ignored by git")`)));

  // 6. A missing file says so.
  check("clicked the missing link", await clickLink("a missing one"));
  const problem = await until("missing file message", () => js<string>(`document.querySelector('[data-testid="file-problem"]')?.textContent ?? ""`));
  check("missing file: not found", problem.includes("not found"), problem);

  // 7. Persisted: reload and the pane is back (on app.ts with its range).
  check("clicked app.ts:10-20 again", await clickLink("app.ts:10-20"));
  await until("app.ts back", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "src/app.ts"`));
  await js(`location.reload()`);
  const back = await until("file pane restored after reload", async () => {
    const s = await fileState(10);
    return s && s.selected.includes(10) && s;
  }, 15000);
  check("restored after reload with its range", back.selected.length === 11, JSON.stringify(back.selected));

  // 8. Escape closes the focused file pane.
  await js(`document.querySelector('[data-testid="pane-file"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await app.key("Escape", "Escape", 27);
  await until("Escape closed it", () => js<boolean>(`!document.querySelector('[data-testid="pane-file"]')`));
  check("Escape closes the file pane", true);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
  await shot("file-pane-failure").catch(() => {});
  const text = await app?.js<string>(`document.querySelector(".main")?.innerText.slice(0, 1500) ?? ""`).catch(() => "");
  if (text) console.log(`--- on screen ---\n${text}`);
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall file pane checks passed");
process.exit(counter.failures ? 1 : 0);
