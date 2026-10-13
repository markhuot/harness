// File panes end to end in the built app, against the REAL service (throwaway HARNESS_HOME) and a
// throwaway git project: a file link in a ticket's spec opens the file beside the ticket, scrolled
// to and highlighting its lines; another range reuses the pane; a dirty file has a Diff tab in the
// merge view, a clean one doesn't; the editor edits and saves (Cmd+S, the button, save on blur) and
// never drops unsaved edits; it follows theme changes; and the pane survives a reload.
//
//   bun run build && bun scripts/file-pane-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { startDaemon } from "@harness/shared/testing/daemon";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";

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
const crlf = Array.from({ length: 30 }, (_, i) => `const crlf${i + 1} = ${i + 1};`).join("\r\n") + "\r\n";
writeFileSync(join(projectDir, "src/crlf.ts"), crlf);
writeFileSync(join(projectDir, ".gitignore"), "debug.log\n");
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "init");
// Uncommitted: line 15 changes and a function is added at the end.
writeFileSync(join(projectDir, "src/app.ts"), lines.map((l, i) => (i === 14 ? "export const value15 = 1500; // changed" : l)).join("\n") + "\nexport function added() {\n  return 42;\n}\n");
writeFileSync(join(projectDir, "debug.log"), "ignored by git\n");

const daemon = await startDaemon({ home, delayMs: 15, logs: "inherit" });
const { port, base } = daemon;

const counter = checker();
const { check } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  if (!shots || !app) return;
  await Bun.sleep(400);
  await app.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  const { token } = daemon;
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "files", key: "FILES" });
  const spec = [
    "Look at [app.ts:10-20](harness://file/src/app.ts#L10-L20) first,",
    "then [the tail](harness://file/src/app.ts#L100-L104), [long.ts:150-152](src/long.ts#L150-L152), [clean.ts](src/clean.ts#L2),",
    "the log [debug.log](debug.log), [crlf.ts](src/crlf.ts) and [a missing one](harness://file/nope.ts).",
  ].join(" ");
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec, driver: "dummy", start: false });

  // Not forced (HARNESS_THEME would pin it): the theme step flips it live.
  app = await launchApp({ baseUrl: base, token, env: {} });
  const { js, exists, go } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("files")`), 10000);
  await js(`harness.setTheme({ preference: ${JSON.stringify(theme)} })`);
  await until("theme applied", () => js<boolean>(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`), 5000);
  await go("#/settings");
  check("the Settings toggle exists", !!(await until("settings", () => js<boolean>(`!!document.querySelector('[aria-label="Save files on blur"]')`), 10000).catch(() => false)));
  check("it starts off", (await api<{ saveOnBlur?: boolean }>("GET", "/settings")).saveOnBlur !== true);
  await js(`document.querySelector('[aria-label="Save files on blur"]').click()`);
  const flipped = await until("the toggle saves the setting", async () => (await api<{ saveOnBlur?: boolean }>("GET", "/settings")).saveOnBlur === true, 5000).catch(() => false);
  check("flipping the toggle sets saveOnBlur on the service", !!flipped);
  await api("PATCH", "/settings", { saveOnBlur: false });
  await go(`#/board/${project.id}/ticket/${ticket.key}`);
  await until("the spec's file links render", () => js<number>(`document.querySelectorAll('.pane-ticket [data-testid="file-link"]').length`).then((n) => n >= 7 && n), 10000); // the dummy plan run may repeat them

  const clickLink = (text: string) =>
    js<boolean>(`(() => { const a = [...document.querySelectorAll('.pane-ticket [data-testid="file-link"]')].find(e => e.textContent.includes(${JSON.stringify(text)})); a?.click(); return !!a; })()`);
  /** The editor's state: the lines marked as the linked range, whether there is a selection, and where line `n` sits in the scroller. */
  const fileState = (n: number) =>
    js<{ revealed: string[]; empty: boolean; top: number; height: number; panes: number; doc: string } | null>(`(() => {
      const view = document.querySelector('[data-testid="file-editor"] .cm-content')?.cmTile?.root?.view;
      if (!view) return null;
      const revealed = [...document.querySelectorAll('.cm-revealed-line')].map(e => e.textContent);
      let top = -1e9, height = 0;
      const el = [...document.querySelectorAll('.cm-line')].find(e => e.textContent.includes("value${n} =") || e.textContent.includes('"row ${n}"'));
      const sc = document.querySelector('[data-testid="file-editor"] .cm-scroller');
      if (el && sc) { const b = sc.getBoundingClientRect(); top = el.getBoundingClientRect().top - b.top; height = b.height; }
      return { revealed, empty: view.state.selection.main.empty, top, height, panes: document.querySelectorAll('[data-testid="pane-file"]').length, doc: view.state.doc.toString() };
    })()`);
  const editorDoc = () => js<string>(`document.querySelector('[data-testid="file-editor"] .cm-content')?.cmTile?.root?.view.state.doc.toString() ?? ""`);
  /** Real typing: focus the editor with the cursor at the very start, then insert text like the keyboard would. */
  const typeInEditor = async (text: string) => {
    await js(`(() => { const v = document.querySelector('[data-testid="file-editor"] .cm-content').cmTile.root.view; v.focus(); v.dispatch({ selection: { anchor: 0 } }); })()`);
    await app!.cdp("Input.insertText", { text });
  };
  const onDisk = (file: string) => readFileSync(join(projectDir, file), "utf8");
  const dirty = () => exists('[data-testid="file-dirty"]');
  const settings = (body: object) => api("PATCH", "/settings", body);
  // confirm() dialogs: answer each with the next queued choice, recording what was asked.
  const asked: string[] = [];
  const answers: boolean[] = [];
  await app.cdp("Page.enable");
  app.on((method, p) => {
    if (method === "Page.javascriptDialogOpening") {
      asked.push(p.message);
      void app!.cdp("Page.handleJavaScriptDialog", { accept: answers.shift() ?? false });
    }
  });

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
  check("reloading restores the pane with the editor", !!(await until("editor after reload", () => js<boolean>(`!!document.querySelector('[data-testid="file-editor"] .cm-editor')`), 15000).catch(() => false)));
  await until("spec links after reload", () => js<number>(`document.querySelectorAll('.pane-ticket [data-testid="file-link"]').length`).then((n) => n >= 7 && n), 10000);

  // 1. A ranged link opens the file beside the ticket, highlighted and scrolled to, with no selection.
  check("clicked app.ts:10-20", await clickLink("app.ts:10-20"));
  const opened = await until("file pane highlights lines 10-20", async () => {
    const s = await fileState(10);
    return s && s.revealed.length === 11 && s;
  }, 10000);
  check("opens one file pane", opened.panes === 1);
  check("lines 10–20 are highlighted (and only those)", opened.revealed[0]!.includes("value10 =") && opened.revealed[10]!.includes("value20 ="), JSON.stringify(opened.revealed));
  check("no selection is left", opened.empty);
  const order = await js<string[]>(`[...document.querySelectorAll(".pane")].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(p => p.dataset.testid)`);
  check("the file pane docks right of the ticket", order.join(",") === "pane-board,pane-ticket,pane-file", order.join(","));
  const fileRight = await js<number[]>(`[document.querySelector('[data-testid="pane-file"]').getBoundingClientRect().right, document.querySelector(".pane-workspace").getBoundingClientRect().right]`);
  check("…on the workspace's right edge", Math.abs(fileRight[0]! - fileRight[1]!) <= 2, fileRight.join(" vs "));
  check("line 10 is in view", opened.top >= 0 && opened.top < opened.height, `top=${opened.top} height=${opened.height}`);
  check("syntax colored", await js<boolean>(`document.querySelectorAll('[data-testid="file-editor"] .cm-line span[class]').length > 20`));
  check("modified badge", (await js<string>(`document.querySelector('[data-testid="file-git-state"]')?.textContent ?? ""`)) === "modified");
  check("Diff tab offered for a dirty file", await exists('.file-tabs [data-tab="diff"]'));
  check("Save is disabled while clean, with no dirty marker", (await js<boolean>(`document.querySelector('[data-testid="file-save"]').disabled`)) && !(await dirty()));
  await shot("file-pane-range");

  // 2. Another range of the same file reuses the pane and scrolls there.
  check("clicked the tail link", await clickLink("the tail"));
  const tail = await until("lines 100-104 highlighted", async () => {
    const s = await fileState(100);
    return s && s.revealed.length === 5 && s;
  });
  check("still one file pane", tail.panes === 1);
  check("line 100 scrolled into view", tail.top >= 0 && tail.top < tail.height, `top=${tail.top}`);
  check("still no selection", tail.empty);

  // 3. Editing: typing marks the pane dirty, Cmd+S writes the file (and only then).
  const before = onDisk("src/app.ts");
  await typeInEditor("// edited\n");
  await until("dirty marker", dirty, 5000);
  check("typing enables Save", !(await js<boolean>(`document.querySelector('[data-testid="file-save"]').disabled`)));
  check("typing alone doesn't touch the file", onDisk("src/app.ts") === before);
  await app.key("s", "KeyS", 83, 4);
  await until("saved", async () => !(await dirty()), 5000);
  check("Cmd+S writes the edit to disk", onDisk("src/app.ts") === "// edited\n" + before, onDisk("src/app.ts").slice(0, 40));
  check("Save is disabled again", await js<boolean>(`document.querySelector('[data-testid="file-save"]').disabled`));
  await shot("file-pane-edited");
  await typeInEditor("// by button\n");
  await until("dirty again", dirty, 5000);
  await js(`document.querySelector('[data-testid="file-save"]').click()`);
  await until("saved by the button", async () => !(await dirty()), 5000);
  check("the Save button writes too", onDisk("src/app.ts").startsWith("// by button\n// edited\n"));

  // 4. An unsaved edit survives the app regaining focus (and what's on disk doesn't replace it); a
  // clean editor takes the disk's copy silently.
  await typeInEditor("// unsaved\n");
  await until("dirty", dirty, 5000);
  writeFileSync(join(projectDir, "src/app.ts"), "// from outside\n" + onDisk("src/app.ts"));
  await js(`window.dispatchEvent(new Event("focus"))`);
  await Bun.sleep(800);
  check("focus keeps a dirty editor's edits", (await editorDoc()).startsWith("// unsaved\n"));
  await app.key("s", "KeyS", 83, 4); // last write wins
  await until("saved", async () => !(await dirty()), 5000);
  check("saving over a newer disk copy wins", onDisk("src/app.ts").startsWith("// unsaved\n"));
  writeFileSync(join(projectDir, "src/app.ts"), "// reloaded\n" + onDisk("src/app.ts"));
  await js(`window.dispatchEvent(new Event("focus"))`);
  await until("clean editor reloads", async () => (await editorDoc()).startsWith("// reloaded\n"), 5000);
  check("a silent reload isn't an edit", !(await dirty()));

  // 5. Save on blur (Settings → General): the editor losing focus saves, and so does the app.
  await settings({ saveOnBlur: true });
  await until("setting reaches the app", () => js<boolean>(`!!document.querySelector('[data-testid="file-editor"]')`), 5000);
  await Bun.sleep(500);
  await typeInEditor("// blur one\n");
  await js(`document.querySelector('[data-testid="file-editor"] .cm-content').blur()`);
  await until("saved on editor blur", async () => onDisk("src/app.ts").startsWith("// blur one\n"), 5000).catch(() => {});
  check("the editor losing focus saves", onDisk("src/app.ts").startsWith("// blur one\n"));
  await typeInEditor("// blur two\n");
  await js(`window.dispatchEvent(new Event("blur"))`);
  await until("saved on app blur", async () => onDisk("src/app.ts").startsWith("// blur two\n"), 5000).catch(() => {});
  check("the app losing focus saves", onDisk("src/app.ts").startsWith("// blur two\n"));

  // 5b. With save on blur, closing the pane saves what it held; so does another file replacing it.
  await typeInEditor("// closing\n");
  await js(`document.querySelector('[data-testid="pane-file"] [data-testid="pane-close"]').click()`);
  await until("pane closed", () => js<boolean>(`!document.querySelector('[data-testid="pane-file"]')`), 5000);
  await until("close saved", async () => onDisk("src/app.ts").startsWith("// closing\n"), 5000).catch(() => {});
  check("closing a dirty pane saves with save on blur", onDisk("src/app.ts").startsWith("// closing\n") && asked.length === 0, asked.join("|"));
  check("clicked the tail link again", await clickLink("the tail"));
  await until("editor back", async () => (await fileState(100))?.revealed.length === 5);
  await typeInEditor("// swapped\n");
  check("clicked long.ts:150-152", await clickLink("long.ts:150-152"));
  await until("long.ts shown", () => js<boolean>(`document.querySelector(".file-name")?.textContent === "long.ts" && !!document.querySelector('.cm-content')?.textContent.includes("row 150")`), 10000);
  await until("swap saved", async () => onDisk("src/app.ts").startsWith("// swapped\n"), 5000).catch(() => {});
  check("another file replacing a dirty pane saves it", onDisk("src/app.ts").startsWith("// swapped\n"));
  const long = await fileState(150);
  check("the replacement scrolls to its range", !!long && long.top >= 0 && long.top < long.height && long.revealed.length === 3, JSON.stringify(long && { ...long, doc: "" }));
  check("it replaced the pane", long?.panes === 1);
  await settings({ saveOnBlur: false });
  await Bun.sleep(500);

  // 5c. Without it, closing a dirty pane asks: Cancel twice keeps it open and dirty; Save writes and closes; Discard throws away.
  await typeInEditor("// asked\n");
  const longBefore = onDisk("src/long.ts");
  asked.length = 0;
  answers.push(false, false);
  await js(`document.querySelector('[data-testid="pane-file"] [data-testid="pane-close"]').click()`);
  await until("two questions", async () => asked.length >= 2, 5000).catch(() => {});
  check("closing a dirty pane asks to save, then to discard", asked.length === 2 && asked[0]!.includes("Save changes") && asked[1]!.includes("Discard"), asked.join("|"));
  check("declining both keeps the pane and its edits", (await exists('[data-testid="pane-file"]')) && (await dirty()) && (await editorDoc()).startsWith("// asked\n"));
  check("nothing was written meanwhile", onDisk("src/long.ts") === longBefore);
  asked.length = 0;
  answers.push(false, true);
  await js(`document.querySelector('[data-testid="pane-file"] [data-testid="pane-close"]').click()`);
  await until("discarded and closed", () => js<boolean>(`!document.querySelector('[data-testid="pane-file"]')`), 5000);
  check("Discard closes without writing", onDisk("src/long.ts") === longBefore);
  check("clicked long.ts again", await clickLink("long.ts:150-152"));
  await until("long.ts back", async () => !!(await fileState(150)));
  await typeInEditor("// kept\n");
  asked.length = 0;
  answers.push(true);
  await js(`document.querySelector('[data-testid="pane-file"] [data-testid="pane-close"]').click()`);
  await until("saved and closed", () => js<boolean>(`!document.querySelector('[data-testid="pane-file"]')`), 5000);
  check("Save writes, then closes", onDisk("src/long.ts") === "// kept\n" + longBefore);

  // 6. The Diff tab is the merge view: the original beside the working copy.
  check("clicked app.ts:10-20 for the diff", await clickLink("app.ts:10-20"));
  await until("app.ts editor", async () => (await fileState(10))?.revealed.length === 11);
  await js(`document.querySelector('.file-tabs [data-tab="diff"]').click()`);
  const diff = await until("diff renders", () =>
    js<{ adds: number; dels: number; sides: number; readOnly: boolean } | null>(`(() => {
      const v = document.querySelector('[data-testid="file-diff"] .cm-mergeView');
      if (!v) return null;
      const adds = v.querySelectorAll('.cm-merge-b .cm-changedLine').length, dels = v.querySelectorAll('.cm-merge-a .cm-changedLine').length;
      return adds && dels ? { adds, dels, sides: v.querySelectorAll('.cm-editor').length, readOnly: ![...v.querySelectorAll('.cm-content')].some(c => c.isContentEditable) } : null;
    })()`), 10000);
  check("diff shows additions on the right and deletions on the left", diff.adds >= 1 && diff.dels >= 1 && diff.sides === 2, JSON.stringify(diff));
  check("the diff is read-only", diff.readOnly);
  check("no pierre left in the pane", !(await exists("diffs-container")));
  await shot("file-pane-diff");

  // 6b. Theme: the editor follows the app's variables live, with no reload.
  const bg = () => js<string[]>(`[getComputedStyle(document.querySelector('[data-testid="file-diff"] .cm-editor')).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), document.documentElement.dataset.theme]`);
  const [bg1, var1, app1] = await bg();
  await js(`harness.setTheme({ preference: ${JSON.stringify(theme === "dark" ? "light" : "dark")} })`);
  const [bg2, var2, app2] = await until("theme switched", async () => {
    const r = await bg();
    return r[2] !== app1 && r;
  }, 10000);
  check("the app theme changed", app1 !== app2 && var1 !== var2, `${var1} -> ${var2}`);
  check("the editor's background follows the theme variable", bg1 !== bg2, `${bg1} -> ${bg2}`);
  await shot("file-pane-diff-switched");
  await js(`harness.setTheme({ preference: ${JSON.stringify(theme)} })`);
  await until("theme restored", async () => (await bg())[2] === app1, 10000);

  // 6c. Switching to the Diff tab never unmounts the editor: edits survive it, with no question asked.
  await js(`document.querySelector('.file-tabs [data-tab="file"]').click()`);
  await until("file tab", () => js<boolean>(`!!document.querySelector('[data-testid="file-editor"]') && !document.querySelector('.file-editor-slot').hidden`));
  asked.length = 0;
  await typeInEditor("// kept across tabs\n");
  await until("dirty before the tab switch", dirty, 5000);
  await js(`document.querySelector('.file-tabs [data-tab="diff"]').click()`);
  await until("diff shows with unsaved edits", () => exists('[data-testid="file-diff"] .cm-mergeView'));
  check("the Diff tab doesn't ask about unsaved edits", asked.length === 0, asked.join("|"));
  check("the editor stays mounted (hidden) under the Diff tab, still dirty", (await exists('[data-testid="file-editor"]')) && (await dirty()) && (await js<boolean>(`document.querySelector('.file-editor-slot').hidden`)));
  await js(`document.querySelector('.file-tabs [data-tab="file"]').click()`);
  check("back on the File tab the edits are still there", (await editorDoc()).startsWith("// kept across tabs\n") && (await dirty()));

  // 6d. A refetch that fails keeps the editor and its edits, with a banner; the next good one clears it.
  await app.cdp("Network.setBlockedURLs", { urls: ["*file?path=*"] });
  await js(`window.dispatchEvent(new Event("focus"))`);
  const stale = await until("refresh failure banner", () => js<string>(`document.querySelector('[data-testid="file-stale"]')?.textContent ?? ""`), 5000).catch(() => "");
  check("a failed refresh shows a banner", stale.includes("Couldn't refresh"), stale);
  await shot("file-pane-stale");
  check("…and keeps the editor with its unsaved edits", (await exists('[data-testid="file-editor"] .cm-editor')) && (await dirty()) && (await editorDoc()).startsWith("// kept across tabs\n") && asked.length === 0, asked.join("|"));
  await app.cdp("Network.setBlockedURLs", { urls: [] });
  await js(`window.dispatchEvent(new Event("focus"))`);
  await until("banner gone", () => js<boolean>(`!document.querySelector('[data-testid="file-stale"]')`), 5000);
  check("a later good refresh clears the banner and keeps the edits", (await dirty()) && (await editorDoc()).startsWith("// kept across tabs\n"));

  // 6e. Another file replacing this dirty pane asks first, while Cancel can still keep it; Discard lets it go.
  const appBefore = onDisk("src/app.ts");
  asked.length = 0;
  answers.push(false, false);
  check("clicked crlf.ts over a dirty pane", await clickLink("crlf.ts"));
  await until("two questions", async () => asked.length >= 2, 5000).catch(() => {});
  await Bun.sleep(300);
  check("replacing a dirty pane asks to save, then to discard", asked.length === 2 && asked[0]!.includes("Save changes") && asked[1]!.includes("Discard"), asked.join("|"));
  check("declining both keeps the file, its edits and the dirty marker", (await js<string>(`document.querySelector(".file-pane")?.dataset.file`)) === "src/app.ts" && (await dirty()) && (await editorDoc()).startsWith("// kept across tabs\n"));
  asked.length = 0;
  answers.push(false, true);
  check("clicked crlf.ts again", await clickLink("crlf.ts"));
  await until("crlf.ts shown", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "src/crlf.ts" && !!document.querySelector('.cm-content')?.textContent.includes("crlf1 =")`), 10000);
  check("discarding lets the other file in without writing", onDisk("src/app.ts") === appBefore);

  // 6f. A CRLF file keeps its line endings through a save, and a refocus doesn't reset the cursor.
  await js(`(() => { const v = document.querySelector('[data-testid="file-editor"] .cm-content').cmTile.root.view; v.focus(); v.dispatch({ selection: { anchor: 12 } }); })()`);
  await js(`window.dispatchEvent(new Event("focus"))`);
  await Bun.sleep(900);
  check("refocusing a clean CRLF file leaves the cursor where it was", (await js<number>(`document.querySelector('[data-testid="file-editor"] .cm-content').cmTile.root.view.state.selection.main.anchor`)) === 12);
  await typeInEditor("// crlf ");
  await until("dirty", dirty, 5000);
  await app.key("s", "KeyS", 83, 4);
  await until("saved", async () => !(await dirty()), 5000);
  const crlfOnDisk = onDisk("src/crlf.ts");
  check("saving a CRLF file writes CRLF back", crlfOnDisk === "// crlf " + crlf, JSON.stringify(crlfOnDisk.slice(0, 40)));
  check("…with no lone LF anywhere", !/(^|[^\r])\n/.test(crlfOnDisk));
  writeFileSync(join(projectDir, "src/crlf.ts"), crlf);

  // 7. A clean file: no Diff tab; the link replaces the file pane beside the ticket.
  check("clicked clean.ts", await clickLink("clean.ts"));
  await until("clean.ts shown", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "src/clean.ts"`));
  await until("clean.ts loaded", () => js<boolean>(`!!document.querySelector('[data-testid="file-editor"] .cm-editor')`));
  check("clean file: no Diff tab", !(await exists(".file-tabs")));
  check("clean file: no git badge", !(await exists('[data-testid="file-git-state"]')));
  check("clean.ts#L2 highlights line 2", (await fileState(2))?.revealed.length === 1);
  check("still one file pane (replaced beside the ticket)", (await js<number>(`document.querySelectorAll('[data-testid="pane-file"]').length`)) === 1);

  // 8. A gitignored file opens, marked ignored, and a missing one says so.
  check("clicked debug.log", await clickLink("debug.log"));
  await until("debug.log opens", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "debug.log" && !!document.querySelector('[data-testid="file-ignored"]')`));
  check("ignored file shows its contents", await until("contents", async () => (await editorDoc()).includes("ignored by git")));
  check("clicked the missing link", await clickLink("a missing one"));
  const problem = await until("missing file message", () => js<string>(`document.querySelector('[data-testid="file-problem"]')?.textContent ?? ""`));
  check("missing file: not found", problem.includes("not found"), problem);

  // 9. Persisted: reload and the pane is back (on app.ts with its range).
  check("clicked app.ts:10-20 again", await clickLink("app.ts:10-20"));
  await until("app.ts back", () => js<boolean>(`document.querySelector(".file-pane")?.dataset.file === "src/app.ts"`));
  await js(`location.reload()`);
  const back = await until("file pane restored after reload", async () => {
    const s = await fileState(10);
    return s && s.revealed.length === 11 && s;
  }, 15000);
  check("restored after reload with its range", back.revealed.length === 11, JSON.stringify(back.revealed));

  // 10. Escape closes the focused file pane (clean, so without asking).
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
  await daemon.stop();
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall file pane checks passed");
process.exit(counter.failures ? 1 : 0);
