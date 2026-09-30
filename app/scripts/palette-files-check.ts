// The command palette's file browser end to end in the built app, against the REAL service
// (throwaway HARNESS_HOME) and a throwaway git project: ⌘P opens the palette on "@" with the
// project as its root; git-ignored files (node_modules, .env) are found and open in the file pane;
// `path:40-42` opens at those lines; an empty query lists the files opened last; a focused ticket
// pane becomes the root; the All projects board asks for one; and a path-like query without a
// prefix adds a few files after the commands.
//
//   bun run build && bun scripts/palette-files-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-palette-home-");
const projectDir = tempDir("harness-palette-project-");
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: projectDir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
mkdirSync(join(projectDir, "src/components"), { recursive: true });
mkdirSync(join(projectDir, "node_modules/leftpad"), { recursive: true });
writeFileSync(join(projectDir, "src/app.ts"), Array.from({ length: 80 }, (_, i) => `export const value${i + 1} = ${i + 1};`).join("\n") + "\n");
writeFileSync(join(projectDir, "src/components/Button.tsx"), "export const Button = () => null;\n");
writeFileSync(join(projectDir, ".gitignore"), "node_modules/\n.env\n");
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "init");
writeFileSync(join(projectDir, "node_modules/leftpad/index.js"), "module.exports = (s, n) => s.padStart(n);\n");
writeFileSync(join(projectDir, ".env"), "SECRET=shh\n");

const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port) },
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
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, prompt: "Nothing to do", driver: "dummy", start: false });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, key, type } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("files")`), 10000);
  await go(`#/board/${project.id}`);
  await until("board", () => exists('[data-testid="pane-board"]'), 10000);
  // The board pane focused, so the palette's origin is the board.
  await js(`document.querySelector('[data-testid="pane-board"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);

  const openFiles = async () => {
    await key("p", "KeyP", 80, 4);
    await until("palette on @", () => js<boolean>(`document.querySelector("[data-testid=palette-input]")?.value === "@"`));
  };
  const rowsOf = () => js<{ id: string; kind: string; path?: string; text: string }[]>(`[...document.querySelectorAll("[data-testid=palette-row]")].map(r => ({ id: r.dataset.id, kind: r.dataset.kind, path: r.dataset.path, text: r.textContent }))`);
  const search = async (q: string, path: string) => {
    await type("[data-testid=palette-input]", q);
    return until(`${path} for ${q}`, async () => {
      const rows = await rowsOf();
      return rows.some((r) => r.path === path) && rows;
    });
  };
  const selectAndEnter = async (path: string) => {
    const i = (await rowsOf()).findIndex((r) => r.path === path);
    for (let n = 0; n < i; n++) await key("ArrowDown", "ArrowDown", 40);
    await key("Enter", "Enter", 13);
  };
  const paneFile = () => js<string | null>(`document.querySelector(".file-pane")?.dataset.file ?? null`);

  // 1. ⌘P: the palette opens on "@", naming the project it searches.
  await openFiles();
  check("⌘P opens the palette in files mode with the input focused", await js<boolean>(`document.activeElement?.matches("[data-testid=palette-input]")`));
  const rootText = await js<string>(`document.querySelector("[data-testid=palette-root]")?.textContent ?? ""`);
  check("the header names the project searched", rootText.includes("files"), rootText);
  check("an empty query with nothing opened yet asks for a name", (await js<string>(`document.querySelector("[data-testid=palette-empty]")?.textContent ?? ""`)).includes("Type to find a file"));

  // 2. A file under node_modules (git-ignored) is found, drawn as name + dimmed folder with the
  // matched letters marked, and opens in the file pane.
  const nm = await search("@leftpad/index", "node_modules/leftpad/index.js");
  check("only files come back in files mode", nm.every((r) => r.kind === "file"), JSON.stringify(nm));
  const drawn = await js<{ name: string; dir: string; marks: number }>(`(() => {
    const r = document.querySelector('[data-testid=palette-row][data-path="node_modules/leftpad/index.js"]');
    return { name: r.querySelector(".palette-file-name").textContent, dir: r.querySelector(".palette-file-dir").textContent, marks: r.querySelectorAll("mark").length };
  })()`);
  check("the row shows the name, then its folder", drawn.name === "index.js" && drawn.dir === "node_modules/leftpad/", JSON.stringify(drawn));
  check("matched characters are highlighted", drawn.marks > 0, JSON.stringify(drawn));
  check("the node_modules row is tagged ignored", await js<boolean>(`!!document.querySelector('[data-testid=palette-row][data-path="node_modules/leftpad/index.js"] [data-testid=palette-ignored]')`));
  await shot("palette-files-ignored");
  await selectAndEnter("node_modules/leftpad/index.js");
  await until("palette closed", async () => !(await exists("[data-testid=palette]")));
  check("Enter opens node_modules/leftpad/index.js in the file pane", (await until("file pane", paneFile)) === "node_modules/leftpad/index.js");
  check("the pane marks it ignored", !!(await until("ignored badge", () => exists('[data-testid="file-ignored"]')).catch(() => false)));

  // 3. .env (git-ignored) opens too.
  await openFiles();
  await search("@.env", ".env");
  const tagged = (path: string) => js<boolean>(`!!document.querySelector('[data-testid=palette-row][data-path=${JSON.stringify(path)}] [data-testid=palette-ignored]')`);
  check("the .env row is tagged ignored", await tagged(".env"));
  await shot("palette-files-env-tag");
  await selectAndEnter(".env");
  check(".env opens in the file pane", !!(await until(".env pane", async () => (await paneFile()) === ".env").catch(() => false)));
  check("opened over a file pane, it replaces that pane", (await js<number>(`document.querySelectorAll('[data-testid="pane-file"]').length`)) === 1);
  check(".env's contents show", !!(await until(".env contents", () => js<boolean>(`(document.querySelector('[data-testid="file-body"] diffs-container')?.shadowRoot?.textContent ?? document.querySelector(".file-plain")?.textContent ?? "").includes("SECRET=shh")`)).catch(() => false)));
  await shot("palette-files-env-opened");

  // 4. path:start-end opens at those lines.
  await openFiles();
  const ranged = await search("@src/app.ts:40-42", "src/app.ts");
  check("the row shows the lines it opens at", ranged.find((r) => r.path === "src/app.ts")!.text.includes(":40-42"));
  check("the tracked src/app.ts row isn't tagged ignored", !(await tagged("src/app.ts")));
  await selectAndEnter("src/app.ts");
  const selected = await until("lines 40-42 selected", async () => {
    const sel = await js<number[] | null>(`(() => { const d = document.querySelector('[data-testid="file-body"] diffs-container')?.shadowRoot; return d ? [...new Set([...d.querySelectorAll('[data-selected-line][data-line]')].map(e => Number(e.dataset.line)))] : null; })()`);
    return sel && sel.includes(40) && sel;
  }, 10000).catch(() => [] as number[]);
  check("src/app.ts:40-42 opens with exactly lines 40–42 highlighted", selected.length === 3 && Math.min(...selected) === 40 && Math.max(...selected) === 42, JSON.stringify(selected));
  await shot("palette-files-lines");

  // 5. An empty query lists the files opened last, most recent first.
  await openFiles();
  const recent = await until("recents", async () => {
    const rows = await rowsOf();
    return rows.length >= 3 && rows;
  });
  check("recent files, most recent first", recent.slice(0, 3).map((r) => r.path).join(",") === "src/app.ts,.env,node_modules/leftpad/index.js", JSON.stringify(recent.map((r) => r.path)));
  check("the header says they're recent", (await js<string>(`document.querySelector("[data-testid=palette-root]")?.textContent ?? ""`)).includes("Recently opened"));
  await shot("palette-files-recent");
  await key("Escape", "Escape", 27);

  // 6. Without a prefix, a path-like query adds a few files; a word doesn't.
  await key("k", "KeyK", 75, 4);
  await until("palette", () => exists("[data-testid=palette-input]"));
  await type("[data-testid=palette-input]", "components/but");
  const mixed = await until("a file row in the unprefixed palette", async () => {
    const rows = await rowsOf();
    return rows.some((r) => r.kind === "file") && rows;
  }).catch(() => [] as Awaited<ReturnType<typeof rowsOf>>);
  check("a path-like query shows its files without @", mixed.some((r) => r.path === "src/components/Button.tsx"), JSON.stringify(mixed));
  check("at most five of them", mixed.filter((r) => r.kind === "file").length <= 5);
  await type("[data-testid=palette-input]", "settings");
  await Bun.sleep(500);
  check("a plain word shows no files", (await rowsOf()).every((r) => r.kind !== "file"));
  await key("Escape", "Escape", 27);

  // 7. A focused ticket pane is the root.
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("ticket pane", () => exists('[data-testid="pane-ticket"]'), 10000);
  await js(`document.querySelector('[data-testid="pane-ticket"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await openFiles();
  const ticketRoot = await js<string>(`document.querySelector("[data-testid=palette-root]")?.textContent ?? ""`);
  check("with a ticket pane focused, the ticket's files are searched", ticketRoot.includes(ticket.key), ticketRoot);
  await search("@button", "src/components/Button.tsx");
  await shot("palette-files-ticket");
  await key("Escape", "Escape", 27);

  // 8. The All projects board with only the board says to pick a project.
  await go(`#/board/all`);
  await until("all board", () => exists('[data-testid="pane-board"]'), 10000);
  await js(`document.querySelector('[data-testid="pane-board"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await openFiles();
  const hint = await js<string>(`document.querySelector("[data-testid=palette-empty]")?.textContent ?? ""`);
  check("All projects without a focused ticket asks for a project", hint.includes("open a project's board"), hint);
  await key("Escape", "Escape", 27);
} catch (e) {
  check("no exception", false, (e as Error).stack ?? String(e));
  await shot("palette-files-failure").catch(() => {});
  const text = await app?.js<string>(`document.querySelector(".main")?.innerText.slice(0, 1500) ?? ""`).catch(() => "");
  if (text) console.log(`--- on screen ---\n${text}`);
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall palette file checks passed");
process.exit(counter.failures ? 1 : 0);
