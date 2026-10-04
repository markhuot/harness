// Message attachments end to end in the built app, against the REAL service (throwaway HARNESS_HOME,
// dummy driver): the ticket composer's (+) menu, a file picked through it, a file dropped on the
// composer (registered in place by its path, with a drop highlight), an image pasted into the input (uploaded), ×
// removing one before sending, then Send: the list clears, the service's transcript has the message
// with its attachments, and the Transcript tab shows them under the message, served by the service
// (after a reload, so nothing comes from the composer's previews) by each attachment's id
// (GET /attachments/:id), a deleted one as missing.
//
//   bun run build && bun scripts/composer-attachments-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project, Ticket, TranscriptEntry } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";
import { png } from "./lib/png";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-composer-home-");
const projectDir = tempDir("harness-composer-project-");
const files = tempDir("harness-composer-files-");
const mockup = join(files, "mockup.png");
const report = join(files, "error-report.txt");
const dropped = join(files, "before.png");
const unwanted = join(files, "unrelated.md");
writeFileSync(mockup, png(96, 64, [37, 99, 235], [16, 185, 129]));
writeFileSync(report, "TypeError: undefined is not a function\n");
writeFileSync(dropped, png(64, 64, [234, 88, 12], [250, 204, 21]));
writeFileSync(unwanted, "# Not this one\n");
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
  await app.screenshot(join(shots, `mac-${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "composer", key: "CMP" });
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Fix the settings page crash", driver: "dummy", start: false });

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, cdp, type } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("composer")`), 10000);
  await go(`#/board/${project.id}/ticket/${ticket.key}/spec`);
  await until("the composer", () => exists('[data-testid="composer"] .composer-input'), 10000);

  const rows = () =>
    js<{ id: string; source: string; path: string; kind: string | null; img: boolean; remove: boolean }[]>(`[...document.querySelectorAll('[data-testid="composer"] [data-testid="prompt-attachment"]')].map(el => ({
      id: el.dataset.id, source: el.dataset.source, path: el.dataset.path, kind: el.dataset.kind ?? null, img: !!el.querySelector("img"), remove: !!el.querySelector('[data-testid="prompt-attachment-remove"]') }))`);
  const sendEnabled = () => js<boolean>(`!document.querySelector('[data-testid="composer-send"]').disabled`);
  check("Send starts disabled with nothing typed or attached", !(await sendEnabled()));

  // --- (+) sits at the input's left and opens the menu.
  const left = await js<{ plus: number; input: number }>(`({ plus: document.querySelector('[data-testid="composer-attach"]').getBoundingClientRect().right, input: document.querySelector('[data-testid="composer"] .composer-input').getBoundingClientRect().left })`);
  check("(+) is at the input's left", left.plus <= left.input, JSON.stringify(left));
  await js(`document.querySelector('[data-testid="composer-attach"]').click()`);
  const menu = await until("the attach menu", () => js<string[] | null>(`(() => { const a = document.querySelector('[data-testid="composer-attach-files"]'), b = document.querySelector('[data-testid="composer-attach-paste"]'); return a && b ? [a.textContent.trim(), b.textContent.trim()] : null; })()`), 3000).catch(() => null);
  check("the menu offers Choose files… and Paste image", JSON.stringify(menu) === JSON.stringify(["Choose files…", "Paste image"]), JSON.stringify(menu));
  await shot("composer-menu");
  // "Choose files…" clicks the hidden multi-select input (the native dialog can't be driven, so CDP fills it the way the dialog does).
  await js(`(() => { const i = document.querySelector('[data-testid="composer-attach-input"]'); window.__pickerOpened = false; i.addEventListener("click", (e) => { window.__pickerOpened = true; e.preventDefault(); }, { once: true }); document.querySelector('[data-testid="composer-attach-files"]').click(); })()`);
  check("Choose files… opens the file picker", await js<boolean>("window.__pickerOpened"));
  check("…and the menu closes", !(await exists('[data-testid="composer-attach-files"]')));
  check("the picker takes several files", await js<boolean>(`document.querySelector('[data-testid="composer-attach-input"]').multiple`));
  const doc = await cdp("DOM.getDocument", {});
  const input = await cdp("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: '[data-testid="composer-attach-input"]' });
  await cdp("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [mockup, report, unwanted] });
  await until("picked files attached", async () => (await rows()).length === 3, 5000);
  let list = await rows();
  check("picked files are registered in place (an id each, source file), in order, each with ×", list.map((r) => r.path).join() === [mockup, report, unwanted].join() && list.every((r) => r.remove && !!r.id && r.source === "file"), JSON.stringify(list));
  check("an image shows a thumbnail, a text file an icon", list[0]!.img && !list[1]!.img && list[1]!.kind === "file");
  check("attachments alone enable Send", await sendEnabled());

  // --- Drop from Finder onto the composer.
  const box = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-testid="composer"] .composer-input').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const dragData = { items: [], files: [dropped], dragOperationsMask: 1 };
  await cdp("Input.dispatchDragEvent", { type: "dragEnter", x: box.x, y: box.y, data: dragData });
  await cdp("Input.dispatchDragEvent", { type: "dragOver", x: box.x, y: box.y, data: dragData });
  const hinted = await until("drop highlight", () => exists('.composer.dropping [data-testid="composer-drop-hint"]'), 3000).catch(() => false);
  check("files hovering over the composer highlight it", hinted);
  await shot("composer-drop");
  await cdp("Input.dispatchDragEvent", { type: "drop", x: box.x, y: box.y, data: dragData });
  await until("dropped file attached", async () => (await rows()).length === 4, 5000);
  check("the highlight goes away on drop", !(await exists(".composer.dropping")));
  check("a dropped file is attached by its path", (await rows())[3]?.path === dropped);
  check("the window didn't navigate to the dropped file", (await js<string>("location.protocol + location.pathname")).endsWith("index.html"));

  // --- ⌘V of an image into the input: uploaded and attached; text pastes stay text.
  await js(`(() => {
    const t = document.querySelector('[data-testid="composer"] .composer-input');
    t.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", "x");
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    t.dispatchEvent(e);
    window.__textPasteHandled = e.defaultPrevented;
  })()`);
  check("a plain text paste is left to the input", !(await js<boolean>("window.__textPasteHandled")));
  await js(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(pasted.toString("base64"))}), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector('[data-testid="composer"] .composer-input').dispatchEvent(e);
    window.__imagePasteHandled = e.defaultPrevented;
  })()`);
  check("an image paste is taken over", await js<boolean>("window.__imagePasteHandled"));
  await until("pasted image attached", async () => (await rows()).length === 5, 8000);
  list = await rows();
  const upload = list[4]!;
  check("the pasted image is uploaded and shows a thumbnail", upload.img && upload.source === "upload" && !!upload.id && !upload.path.startsWith(files), JSON.stringify(upload));
  const composerIds = (await rows()).map((r) => r.id);

  // --- × removes one before sending.
  await js(`document.querySelector('[data-testid="composer"] [data-path=${JSON.stringify(unwanted)}] [data-testid="prompt-attachment-remove"]').click()`);
  await until("removed", async () => (await rows()).length === 4, 3000);
  list = await rows();
  check("× removes just that one", !list.some((r) => r.path === unwanted) && list.length === 4, JSON.stringify(list.map((r) => r.path)));
  await type('[data-testid="composer"] .composer-input', "The crash looks like this, see the attached report.");
  await shot("composer-attachments");

  // --- Send.
  await js(`document.querySelector('[data-testid="composer-send"]').click()`);
  await until("the composer cleared", async () => (await rows()).length === 0 && (await js<string>(`document.querySelector('[data-testid="composer"] .composer-input').value`)) === "", 8000);
  check("after sending, the list and the input clear", true);
  const sent = [mockup, report, dropped, upload.path];
  const userEntry = await until("the message is in the transcript", async () => {
    const entries = await api<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=0`);
    return entries.find((e) => e.role === "user" && e.content.type === "text" && e.content.text.includes("The crash looks like this"));
  }, 10000);
  const sentList = userEntry.content.type === "text" ? (userEntry.content.attachments ?? []) : [];
  check("the service has the message with its attachments, in order", sentList.map((a) => a.path).join() === sent.join(), JSON.stringify(sentList));
  check("files went by path, the paste as an upload", sentList[0]?.source === "file" && sentList[3]?.source === "upload", JSON.stringify(sentList.map((a) => a.source)));
  check("the message's attachments are the ones the composer had (same ids)", sentList.map((a) => a.id).join() === composerIds.filter((_, i) => i !== 2).join(), JSON.stringify({ sent: sentList.map((a) => a.id), composerIds }));

  // --- The Transcript, fresh (no composer previews), with one file gone on disk.
  rmSync(report);
  await js("location.reload()");
  await until("reloaded", () => exists('[data-testid="pane-board"]'), 15000);
  await go(`#/board/${project.id}/ticket/${ticket.key}/transcript`);
  const msgRows = () =>
    js<{ path: string; missing: boolean; img: boolean; remove: boolean; src: string | null }[]>(`[...document.querySelectorAll('[data-testid="message-attachments"] [data-testid="prompt-attachment"]')].map(el => ({
      path: el.dataset.path, missing: el.dataset.missing === "true", img: !!el.querySelector("img") && el.querySelector("img").naturalWidth > 0, remove: !!el.querySelector('[data-testid="prompt-attachment-remove"]'), src: el.querySelector("img")?.getAttribute("src") ?? null }))`);
  const shown = await until("the message's attachments in the Transcript", async () => {
    const r = await msgRows();
    return r.length === 4 && r.filter((x) => x.img).length === 3 && r.some((x) => x.missing) ? r : null;
  }, 10000).catch(async () => msgRows());
  const at = (p: string) => shown.find((r) => r.path === p);
  check("the Transcript lists the four attachments under the message, read-only", shown.length === 4 && shown.every((r) => !r.remove), JSON.stringify(shown));
  check("images load from the service by their attachment id", !!at(mockup)?.img && !!at(dropped)?.img && !!at(upload.path)?.img && !!at(mockup)?.src?.includes(`/attachments/${encodeURIComponent(sentList[0]!.id)}?`), JSON.stringify(at(mockup)));
  check("a file deleted on disk (HEAD 404) shows as missing", !!at(report)?.missing);
  check(
    "they sit under the message's bubble",
    await js<boolean>(`(() => { const a = document.querySelector('[data-testid="message-attachments"]'); const b = a?.parentElement?.querySelector(".t-bubble"); return !!a && !!b && a.getBoundingClientRect().top >= b.getBoundingClientRect().bottom - 1; })()`),
  );
  await js(`document.querySelector('[data-testid="message-attachments"]').scrollIntoView({ block: "center" })`);
  await shot("transcript-attachments");

  await js(`document.querySelector('[data-testid="message-attachments"] [data-path=${JSON.stringify(mockup)}] .prompt-attachment-row-open').click()`);
  const lightbox = await until("lightbox", () => js<boolean>(`!!document.querySelector(".lightbox-stage img")`), 3000).catch(() => false);
  check("clicking a message's image opens the lightbox", lightbox);
  await app.key("Escape", "Escape", 27);

  // --- A message of attachments only (no text) sends too.
  await go(`#/board/${project.id}/ticket/${ticket.key}/spec`);
  await until("the composer", () => exists('[data-testid="composer"] .composer-input'), 10000);
  const doc2 = await cdp("DOM.getDocument", {});
  const input2 = await cdp("DOM.querySelector", { nodeId: doc2.result.root.nodeId, selector: '[data-testid="composer-attach-input"]' });
  await cdp("DOM.setFileInputFiles", { nodeId: input2.result.nodeId, files: [mockup] });
  await until("attached", async () => (await rows()).length === 1, 5000);
  check("an attachment with no text enables Send", await sendEnabled());
  await js(`document.querySelector('[data-testid="composer-send"]').click()`);
  const bare = await until("the attachments-only message", async () => {
    const entries = await api<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=0`);
    return entries.find((e) => e.role === "user" && e.id !== userEntry.id && e.content.type === "text" && !!e.content.attachments?.length);
  }, 10000).catch(() => null);
  check("an attachments-only message reaches the service", !!bare && bare.content.type === "text" && bare.content.attachments?.[0]?.path === mockup);
  const bubbleless = await until("rendered without a bubble", () => js<boolean>(`[...document.querySelectorAll(".t-user")].some(u => !u.querySelector(".t-bubble") && u.querySelector('[data-testid="message-attachments"]'))`), 8000).catch(() => false);
  check("…and shows its attachments with no empty bubble", bubbleless);
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
