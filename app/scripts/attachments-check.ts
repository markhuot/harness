// Prompt attachments end to end in the built app, against the REAL service (throwaway HARNESS_HOME,
// dummy driver): a New session gets files dropped on it from disk (attached by path, with a drop
// highlight), one picked with the paperclip, an image pasted from the clipboard (uploaded), a plain
// text paste that stays text, and × removing one; the draft saves the list; Plan first launches it;
// then files are deleted on disk and the Spec tab shows them as missing while the ticket still
// renders. A reopened draft whose file is gone shows it missing in the editor too.
//
//   bun run build && bun scripts/attachments-check.ts [--shots=<dir>] [--theme=dark]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";
import { png } from "./lib/png";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-attach-home-");
const projectDir = tempDir("harness-attach-project-");
const files = tempDir("harness-attach-files-");
const diagram = join(files, "diagram.png");
const gonePng = join(files, "whiteboard.png");
const goneTxt = join(files, "requirements.md");
const notes = join(files, "notes.txt");
const later = join(files, "later.txt");
writeFileSync(diagram, png(96, 64, [37, 99, 235], [16, 185, 129]));
writeFileSync(gonePng, png(64, 64, [234, 88, 12], [250, 204, 21]));
writeFileSync(goneTxt, "# Requirements\n");
writeFileSync(notes, "notes\n");
writeFileSync(later, "for the reopened draft\n");
const pasted = png(80, 80, [168, 85, 247], [236, 72, 153]);

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
  await app.screenshot(join(shots, `attachments-${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "attach", key: "ATT" });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, cdp, type } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("attach")`), 10000);
  await go(`#/board/${project.id}`);
  await until("board", () => exists('[data-testid="pane-board"]'), 10000);
  await go("#/compose");
  await until("New session pane", () => exists('[data-testid="draft-pane"] .draft-prompt'), 10000);
  await type(".draft-prompt", "Make the dashboard match the attached diagram.");
  const draftKey = await until("the draft is saved", () => js<string | null>(`document.querySelector('[data-testid="draft-pane"]')?.dataset.draftKey ?? null`), 10000);
  check("typing saves the draft", /^ATT-\d+$/.test(draftKey), draftKey);

  const chips = () =>
    js<{ path: string; kind: string | null; missing: boolean; label: string | null; img: boolean }[]>(`[...document.querySelectorAll('[data-testid="draft-pane"] [data-testid="prompt-attachment"]')].map(el => ({
      path: el.dataset.path, kind: el.dataset.kind ?? null, missing: el.dataset.missing === "true", label: el.getAttribute("aria-label"), img: !!el.querySelector("img") }))`);
  const getTicket = async (key: string) => (await api<{ ticket: Ticket }>("GET", `/tickets/${key}`)).ticket;
  const served = async () => (await getTicket(draftKey)).promptAttachments ?? [];

  // --- Drop from Finder: CDP's drag events carry real file paths, like a drag from Finder.
  const box = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-testid="draft-pane"] .draft-prompt').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const dragData = { items: [], files: [diagram, gonePng, goneTxt], dragOperationsMask: 1 };
  await cdp("Input.dispatchDragEvent", { type: "dragEnter", x: box.x, y: box.y, data: dragData });
  await cdp("Input.dispatchDragEvent", { type: "dragOver", x: box.x, y: box.y, data: dragData });
  const hinted = await until("drop highlight", () => js<boolean>(`!!document.querySelector('.draft-pane.dropping [data-testid="draft-drop-hint"]')`), 3000).catch(() => false);
  check("files hovering over the draft pane highlight it", hinted);
  check("a file drag doesn't raise the pane drop layer", !(await exists('[data-testid="pane-drop-layer"]')));
  await shot("drop-hover");
  await cdp("Input.dispatchDragEvent", { type: "drop", x: box.x, y: box.y, data: dragData });
  await until("dropped files attached", async () => (await chips()).length === 3, 5000);
  check("the highlight goes away on drop", !(await exists(".draft-pane.dropping")));
  let list = await chips();
  check("dropped files are attached by their path on disk", JSON.stringify(list.map((c) => c.path)) === JSON.stringify([diagram, gonePng, goneTxt]), JSON.stringify(list.map((c) => c.path)));
  check("images get a thumbnail, other files a chip", list[0]!.img && list[1]!.img && !list[2]!.img && list[2]!.kind === "file");
  check("the window didn't navigate to a dropped file", (await js<string>("location.protocol + location.pathname")).endsWith("index.html"));

  // --- The paperclip's file picker (the hidden input, filled the way the native dialog fills it).
  const doc = await cdp("DOM.getDocument", {});
  const input = await cdp("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: '[data-testid="draft-pane"] [data-testid="prompt-attach-input"]' });
  await cdp("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [notes, diagram] });
  await until("picked file attached", async () => (await chips()).length === 4, 5000);
  list = await chips();
  check("a picked file is attached by path, and one already attached isn't twice", list[3]?.path === notes && list.length === 4, JSON.stringify(list.map((c) => c.path)));

  // --- Paste: plain text stays text; image data is uploaded and attached.
  await js(`(() => { const t = document.querySelector('[data-testid="draft-pane"] .draft-prompt'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
  await js(`(() => {
    const t = document.querySelector('[data-testid="draft-pane"] .draft-prompt');
    const dt = new DataTransfer();
    dt.setData("text/plain", " Plain text paste.");
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    t.dispatchEvent(e);
    window.__textPasteHandled = e.defaultPrevented;
  })()`);
  check("a plain text paste is left to the textarea", !(await js<boolean>("window.__textPasteHandled")));
  await cdp("Input.insertText", { text: " Plain text paste." });
  check("…and the text lands in the prompt", (await js<string>(`document.querySelector('[data-testid="draft-pane"] .draft-prompt').value`)).endsWith("Plain text paste."));
  check("…without attaching anything", (await chips()).length === 4);

  await js(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(pasted.toString("base64"))}), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('[data-testid="draft-pane"] .draft-prompt').dispatchEvent(e);
    window.__imagePasteHandled = e.defaultPrevented;
  })()`);
  check("an image paste is taken over (no text inserted)", await js<boolean>("window.__imagePasteHandled"));
  await until("pasted image attached", async () => (await chips()).length === 5, 8000);
  list = await chips();
  const upload = list[4]!;
  check("the pasted image is uploaded and shows a thumbnail", upload.img && !upload.path.startsWith(files), upload.path);

  // --- × removes one.
  await js(`document.querySelector('[data-testid="draft-pane"] [data-path=${JSON.stringify(notes)}] [data-testid="prompt-attachment-remove"]').click()`);
  await until("removed", async () => (await chips()).length === 4, 3000);
  const saved = await until("the service has the list", async () => {
    const s = await served();
    return s.length === 4 ? s : null;
  }, 5000).catch(async () => served());
  check(
    "the draft saved its attachments, files by path and the paste as an upload",
    saved.map((a) => a.path).join() === [diagram, gonePng, goneTxt, upload.path].join() && saved[3]!.source === "upload" && saved[0]!.source === "file",
    JSON.stringify(saved),
  );
  const rowsIn = (scope: string) =>
    js<{ w: number; h: number; nameLeft: number }[]>(`[...document.querySelectorAll('${scope} .prompt-attachment-row')].map(el => { const m = el.querySelector(".prompt-attachment-row-media").getBoundingClientRect(); return { w: m.width, h: m.height, nameLeft: Math.round(el.querySelector(".prompt-attachment-name").getBoundingClientRect().left) }; })`);
  const draftRows = await rowsIn('[data-testid="draft-pane"]');
  check("the draft lists attachments the Spec tab's way: one row each, same-size squares, names in a straight line", draftRows.length > 0 && draftRows.every((r) => r.w === 32 && r.h === 32 && r.nameLeft === draftRows[0]!.nameLeft), JSON.stringify(draftRows));
  await shot("draft");

  // --- Launch it (Plan first), then lose two files on disk.
  await js(`document.querySelector('[data-testid="draft-plan"]').click()`);
  await until("launched", async () => (await getTicket(draftKey)).draft === false, 10000);
  rmSync(gonePng);
  rmSync(goneTxt);
  check("the files are gone on disk", !existsSync(gonePng) && !existsSync(goneTxt));
  // A fresh load, so the Spec tab probes the files as they are now.
  await js("location.reload()");
  await until("reloaded", () => exists('[data-testid="pane-board"]'), 15000);
  await go(`#/board/${project.id}/ticket/${draftKey}/spec`);
  await until("Spec tab attachments", () => exists('[data-testid="spec-prompt-attachments"] [data-testid="prompt-attachment"]'), 10000);
  const specChips = () =>
    js<{ path: string; missing: boolean; label: string | null; title: string | null; img: boolean; remove: boolean }[]>(`[...document.querySelectorAll('[data-testid="spec-prompt-attachments"] [data-testid="prompt-attachment"]')].map(el => ({
      path: el.dataset.path, missing: el.dataset.missing === "true", label: el.querySelector("button")?.getAttribute("aria-label") ?? null, title: el.querySelector("button")?.getAttribute("title") ?? null, img: !!el.querySelector("img") && el.querySelector("img").naturalWidth > 0, remove: !!el.querySelector('[data-testid="prompt-attachment-remove"]') }))`);
  const spec = await until("missing files marked", async () => {
    const c = await specChips();
    return c.filter((x) => x.missing).length === 2 ? c : null;
  }, 8000).catch(async () => specChips());
  const byPath = (p: string) => spec.find((c) => c.path === p);
  check("the Spec tab lists all four attachments, read-only", spec.length === 4 && spec.every((c) => !c.remove), JSON.stringify(spec));
  check("a deleted image shows as missing, saying where it was", !!byPath(gonePng)?.missing && byPath(gonePng)!.title === `Missing — was at ${gonePng}` && !!byPath(gonePng)!.label?.includes(gonePng));
  check("a deleted file (HEAD 404) shows as missing", !!byPath(goneTxt)?.missing && byPath(goneTxt)!.title === `Missing — was at ${goneTxt}`);
  check("files still on disk load from the service", !!byPath(diagram)?.img && !byPath(diagram)!.missing && !!byPath(upload.path)?.img);
  check("the ticket still renders its spec", await exists('[data-testid="spec-doc"]'));
  check(
    "the attachments sit below the spec",
    await js<boolean>(`(() => { const d = document.querySelector('[data-testid="spec-doc"]'), a = document.querySelector('[data-testid="spec-prompt-attachments"]'); return !!d && !!a && !!(d.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) && a.getBoundingClientRect().top >= d.getBoundingClientRect().bottom; })()`),
  );
  const rows = await rowsIn('[data-testid="spec-prompt-attachments"]');
  check("one row each, thumbnails and icons the same size as the draft's, names in a straight line", rows.length === 4 && rows.every((r) => r.w === 32 && r.h === 32 && r.nameLeft === rows[0]!.nameLeft), JSON.stringify(rows));
  await shot("spec-missing");

  // Clicking an image opens the lightbox on it.
  await js(`document.querySelector('[data-testid="spec-prompt-attachments"] [data-path=${JSON.stringify(diagram)}] .prompt-attachment-row-open').click()`);
  const lightbox = await until("lightbox", () => js<boolean>(`!!document.querySelector(".lightbox-stage img")`), 3000).catch(() => false);
  check("clicking a thumbnail opens the lightbox", lightbox);
  await shot("lightbox");
  await app.key("Escape", "Escape", 27);

  // --- A saved draft reopened after its file went missing.
  const draft2 = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Second draft", draft: true, promptAttachments: [{ path: later }, { path: diagram }] });
  rmSync(later);
  await go(`#/board/${project.id}/ticket/${draft2.key}`);
  const reopened = await until("reopened draft shows the missing file", async () => {
    const c = await js<{ path: string; missing: boolean }[]>(`[...document.querySelectorAll('[data-draft-key=${JSON.stringify(draft2.key)}] [data-testid="prompt-attachment"]')].map(el => ({ path: el.dataset.path, missing: el.dataset.missing === "true" }))`);
    return c.length === 2 && c.some((x) => x.missing) ? c : null;
  }, 8000).catch(() => null);
  check("a reopened draft marks its missing file and keeps the rest", !!reopened && reopened.find((c) => c.path === later)?.missing === true && reopened.find((c) => c.path === diagram)?.missing === false, JSON.stringify(reopened));
  await shot("draft-missing");
} catch (e) {
  console.error(e);
  counter.fail();
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
}

console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall checks passed");
process.exit(counter.failures ? 1 : 0);
