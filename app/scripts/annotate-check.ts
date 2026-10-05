// Annotations end to end in the built app, against the REAL service (throwaway HARNESS_HOME, dummy
// driver, real headless Chrome for the session browser). An annotation is metadata on its
// attachment: Add to message puts the attachment, with its notes, in the message being written;
// nothing is sent until the human sends that message, and the image itself never changes.
//
//   1. A spec image → Annotate: two arrows dragged and a spot clicked, each with its message; a
//      mark moved and deleted with the Delete key (the list renumbers, the badges follow), ⌘Z
//      bringing it back, × on a row and ⌘Z again; the notes never over the image. Add to message:
//      nothing went to the agent; the composer lists the spec image itself (its id, source "spec")
//      with its marks over the thumbnail and "3 notes", and has the focus.
//   2. That waiting image opens in the lightbox with its marks drawn over it, and Annotate again
//      reopens its marks: one edited, Add: still one row. The human types why and sends: the
//      Transcript entry's attachment is the spec image (same id, its stored file) with the
//      annotation (3 marks in image pixels), so is its run's, and the stored file's bytes are unchanged.
//   3. The sent image in the Transcript: marks over its thumbnail and in the lightbox; Annotate
//      reopens the sent marks, one more click, Add → the composer (the same attachment id).
//   4. The browser pane's Annotate (a frozen screenshot of a local page): a mark on the Save button
//      names it (#save · "Save") under its note; one clicked on the header names the header, and
//      dragging its anchor onto the button names the button instead. Add → a second composer row
//      whose annotation has the page and each mark's element (path, text). Sent together.
//   5. New session: an attached image annotated in place, its row shows the marks and notes, saved
//      with the draft; reopened after a reload it still offers Annotate, which reopens the marks to
//      edit. Plan first: the launched session keeps the notes on its attachment, and the Spec tab
//      shows the marks and notes.
//
//   bun run build && bun scripts/annotate-check.ts [--shots=<dir>] [--theme=dark]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment, Project, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
import { tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, stopped, until, waitHealthy } from "./lib/drive";
import { png } from "./lib/png";

const shots = process.argv.find((a) => a.startsWith("--shots="))?.slice("--shots=".length);
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
if (shots) mkdirSync(shots, { recursive: true });

const home = tempDir("harness-annotate-home-");
const projectDir = tempDir("harness-annotate-project-");
mkdirSync(join(projectDir, "shots"), { recursive: true });
writeFileSync(join(projectDir, "shots", "mockup.png"), png(480, 320, [226, 232, 240], [148, 163, 184]));
const diagram = join(projectDir, "diagram.png");
writeFileSync(diagram, png(400, 260, [254, 243, 199], [251, 191, 36]));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// A plain local page for the session browser.
const site = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      `<!doctype html><title>Settings</title><body style="margin:0;font:16px -apple-system;background:#f8fafc">
       <header style="height:56px;background:#1e293b;color:#fff;display:flex;align-items:center;padding:0 20px">Acme settings</header>
       <main style="padding:24px"><h1>Profile</h1>
       <button id="save" style="position:fixed;left:30%;top:45%;width:40%;height:30%;font-size:16px">Save</button></main></body>`,
      { headers: { "content-type": "text/html" } },
    ),
});
const pageUrl = `http://127.0.0.1:${site.port}/settings`;

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
/** A screenshot of the window at 1× (one image pixel per CSS pixel), whatever the display's scale. */
const shot = async (name: string) => {
  if (!shots || !app) return;
  await Bun.sleep(400);
  const size = await app.js<{ w: number; h: number; dpr: number }>(`({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
  const r = await app.cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 / size.dpr } });
  const file = join(shots, `annotate-${name}-${theme}.png`);
  writeFileSync(file, Buffer.from(r.result.data, "base64"));
  console.log(`  📸 ${file}`);
};

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type TextContent = { text: string; attachments?: Attachment[] };

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const fetchBytes = async (path: string) => new Uint8Array(await (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer());
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "annotate", key: "ANN" });
  // The dummy agent puts a screenshot in the spec (stored as attachment:<id>) and opens the local page.
  const tools = [
    { name: "update_spec", input: { base_revision: 1, note: "Added the mockup", spec: "# Settings page\n\n![Settings mockup](shots/mockup.png)\n\nMake it match.\n" } },
    { name: "browser_open", input: { url: pageUrl } },
  ];
  const ticket = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: `/tools ${JSON.stringify(tools)}`, driver: "dummy", start: true });
  const detail = (key = ticket.key) => api<TicketDetail>("GET", `/tickets/${key}`);
  const specId = await until("the spec has the mockup", async () => /\]\(attachment:([^)]+)\)/.exec((await detail()).ticket.spec)?.[1], 30000);
  await until("the agent is idle", async () => !(await detail()).ticket.busy, 30000);
  const specBytesBefore = await fetchBytes(`/attachments/${encodeURIComponent(specId)}`);
  const transcript = (sessionId = ticket.sessionId) => api<TranscriptEntry[]>("GET", `/sessions/${sessionId}/transcript?after=0`);
  const userMessages = async () => (await transcript()).filter((e) => e.role === "user" && e.content.type === "text" && !!(e.content as TextContent).attachments?.length);

  app = await launchApp({ baseUrl: base, token, theme, env: {} });
  const { js, exists, go, cdp, type, key } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("annotate")`), 10000);

  const rectOf = (sel: string) => js<Rect | null>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
  const canvasRect = () => rectOf('[data-testid="annotator-canvas"]');
  /** A point on the annotator's image, as fractions of it. */
  const at = async (fx: number, fy: number) => {
    const r = (await canvasRect())!;
    return { x: r.left + r.width * fx, y: r.top + r.height * fy };
  };
  const mouse = (type: string, p: { x: number; y: number }, buttons = 1) => cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons, clickCount: 1 });
  /** Press at `from`, drag to `to` in steps, release. */
  const drag = async (from: [number, number], to: [number, number]) => {
    const a = await at(...from);
    const b = await at(...to);
    await mouse("mouseMoved", a, 0);
    await mouse("mousePressed", a);
    for (let i = 1; i <= 8; i++) await mouse("mouseMoved", { x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 });
    await mouse("mouseReleased", b);
    await Bun.sleep(80);
  };
  const click = async (p: [number, number]) => {
    const a = await at(...p);
    await mouse("mouseMoved", a, 0);
    await mouse("mousePressed", a);
    await mouse("mouseReleased", a);
    await Bun.sleep(80);
  };
  const rows = () => js<{ n: string; message: string }[]>(`[...document.querySelectorAll('[data-testid="annotator-row"]')].map(r => ({ n: r.querySelector(".annotator-badge").textContent.trim(), message: r.querySelector("textarea").value }))`);
  const focusedRow = () => js<string | null>(`document.activeElement?.closest('[data-testid="annotator-row"]')?.dataset.n ?? null`);
  const typeIn = (n: number, text: string) => type(`[data-testid="annotator-row"][data-n="${n}"] textarea`, text);
  /** The canvas pixel at fractions of the image. */
  const pixel = (fx: number, fy: number) =>
    js<number[]>(`(() => { const c = document.querySelector('[data-testid="annotator-canvas"]'); const d = c.getContext("2d").getImageData(Math.floor(c.width * ${fx}), Math.floor(c.height * ${fy}), 1, 1).data; return [d[0], d[1], d[2]]; })()`);
  const accent = await js<number[]>(`(() => { const s = document.createElement("span"); s.style.color = "var(--accent)"; document.body.append(s); const c = getComputedStyle(s).color; s.remove(); const m = c.match(/[\\d.]+/g).map(Number); return m.slice(0, 3); })()`);
  const isAccent = (p: number[]) => p.every((v, i) => Math.abs(v - accent[i]!) < 40);
  /** A badge there: the accent just beside its centre (the centre itself is the white number). */
  const badgeAt = async (fx: number, fy: number) => {
    const r = (await canvasRect())!;
    const dx = 6 / r.width;
    const dy = 6 / r.height;
    for (const [x, y] of [[fx - dx, fy], [fx + dx, fy], [fx, fy - dy], [fx, fy + dy]] as const) if (isAccent(await pixel(x, y))) return true;
    return false;
  };
  const noOverlap = async () => {
    const c = (await canvasRect())!;
    const others = await js<Rect[]>(`[...document.querySelectorAll('[data-testid="annotator-side"], [data-testid="annotator-row"], [data-testid="annotator-message"]')].map(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })`);
    const hits = others.filter((o) => o.left < c.right && o.right > c.left && o.top < c.bottom && o.bottom > c.top);
    return { ok: others.length > 0 && hits.length === 0, detail: `${others.length} elements, ${hits.length} over the image` };
  };
  const annotatorOpen = () =>
    until("the annotator's image", async () => ((await canvasRect())?.width ?? 0) > 0, 10000).then(
      () => true,
      async () => {
        console.error(`  annotator didn't open: ${JSON.stringify(await js<string | null>(`document.querySelector('[data-testid="annotator"]')?.textContent ?? null`))}`);
        return false;
      },
    );
  /** An overlay canvas (`sel`) that's on screen, says how many marks it draws, and has accent pixels on it. */
  const overlay = (sel: string) =>
    js<{ marks: number; accent: number; w: number; h: number } | null>(`(() => {
      const c = document.querySelector(${JSON.stringify(sel)}); if (!c || !c.width) return null;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - ${accent[0]}) < 40 && Math.abs(d[i + 1] - ${accent[1]}) < 40 && Math.abs(d[i + 2] - ${accent[2]}) < 40) n++;
      const r = c.getBoundingClientRect();
      return { marks: Number(c.dataset.marks), accent: n, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
  const composerRows = () =>
    js<{ id: string; source: string; path: string; notes: string | null; thumbMarks: number | null }[]>(`[...document.querySelectorAll('[data-testid="composer"] [data-testid="prompt-attachment"]')].map(el => ({
      id: el.dataset.id, source: el.dataset.source, path: el.dataset.path, notes: el.querySelector('[data-testid="annotation-notes"] button')?.textContent.trim() ?? null,
      thumbMarks: el.querySelector('[data-testid="thumbnail-annotation"]') ? Number(el.querySelector('[data-testid="thumbnail-annotation"]').dataset.marks) : null }))`);
  const openNotes = async (scope: string) => {
    await js(`(() => { const b = document.querySelector(${JSON.stringify(`${scope} [data-testid="annotation-notes"] button`)}); if (b && b.getAttribute("aria-expanded") !== "true") b.click(); })()`);
    await Bun.sleep(150);
    return js<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${scope} [data-testid="annotation-notes-list"] li`)})].map(li => li.textContent.trim())`);
  };
  const typeComposer = (text: string) => type('[data-testid="composer"] .composer-input', text);
  const sendComposer = () => js(`document.querySelector('[data-testid="composer-send"]').click()`);

  // ================================================================ 1. a spec image
  await go(`#/board/${project.id}/ticket/${ticket.key}/spec`);
  await until("the composer", () => exists('[data-testid="composer"] .composer-input'), 10000);
  const fig = await until("the spec's figure", () => exists(".md img"), 10000).catch(() => false);
  check("the spec shows the mockup", fig);
  await js(`document.querySelector(".md img").click()`);
  await until("lightbox", () => exists(".lightbox-stage img"), 5000);
  check("the spec image's lightbox offers Annotate", await exists('[data-testid="lightbox-annotate"]'));
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  check("Annotate opens the annotator on the image (and closes the lightbox)", (await annotatorOpen()) && !(await exists(".lightbox-stage")));
  check("Add to message waits for a note", await js<boolean>(`document.querySelector('[data-testid="annotator-add"]').disabled`));

  await drag([0.25, 0.3], [0.55, 0.15]);
  check("dragging makes note 1 and focuses its field", (await rows()).length === 1 && (await focusedRow()) === "1");
  await typeIn(1, "Make this heading bolder");
  await drag([0.7, 0.75], [0.45, 0.88]);
  check("a second drag makes note 2", (await rows()).length === 2 && (await focusedRow()) === "2");
  await typeIn(2, "This spacing is off");
  await click([0.85, 0.3]);
  check("a plain click makes note 3", (await rows()).length === 3 && (await focusedRow()) === "3");
  await typeIn(3, "Add the Save button here");
  check("the badges are drawn where the arrows start, and on the clicked spot", (await badgeAt(0.55, 0.15)) && (await badgeAt(0.45, 0.88)) && (await badgeAt(0.85, 0.3)));
  const overlap = await noOverlap();
  check("the notes sit beside the image, none over it", overlap.ok, overlap.detail);
  await shot("annotator");

  // Move #2's badge (the canvas keeps the focus), then Delete removes it: the list renumbers.
  await drag([0.45, 0.88], [0.4, 0.92]);
  check("dragging a badge moves that note instead of making a new one", (await rows()).length === 3);
  await key("Delete", "Delete", 46);
  let list = await rows();
  check("Delete removes the selected note and the rest renumber 1, 2", list.map((r) => r.n).join() === "1,2" && list[1]!.message === "Add the Save button here", JSON.stringify(list));
  check("the badges follow: #2's arrow is gone, the clicked spot keeps a badge", !(await badgeAt(0.4, 0.92)) && (await badgeAt(0.85, 0.3)));
  await key("z", "KeyZ", 90, 4);
  list = await rows();
  check("⌘Z brings it back with its message", list.length === 3 && list[1]!.message === "This spacing is off", JSON.stringify(list));
  await js(`document.querySelectorAll('[data-testid="annotator-remove"]')[1].click()`);
  check("× on a row deletes that note", (await rows()).map((r) => r.message).join("|") === "Make this heading bolder|Add the Save button here");
  await js(`document.activeElement?.blur(); document.querySelector('[data-testid="annotator-canvas"]').focus()`);
  await key("z", "KeyZ", 90, 4);
  list = await rows();
  check("⌘Z brings that one back too", list.map((r) => r.message).join("|") === "Make this heading bolder|This spacing is off|Add the Save button here", JSON.stringify(list));

  const messagesBefore = (await userMessages()).length;
  await js(`document.querySelector('[data-testid="annotator-add"]').click()`);
  await until("the annotator closes", async () => !(await exists('[data-testid="annotator"]')), 5000);
  await Bun.sleep(500);
  check("Add to message sends nothing", (await userMessages()).length === messagesBefore);
  let crow = await until("the composer row", async () => (await composerRows())[0], 5000).catch(() => null);
  check("the composer lists the spec image itself (its id, source spec), with its marks over the thumbnail and 3 notes", crow?.id === specId && crow.source === "spec" && crow.notes === "3 notes" && crow.thumbMarks === 3, JSON.stringify(crow));
  const thumb = await until("the thumbnail's marks", async () => {
    const o = await overlay('[data-testid="composer"] [data-testid="thumbnail-annotation"]');
    return o && o.accent > 0 ? o : null;
  }, 5000).catch(() => null);
  check("the thumbnail draws the marks over the whole square (accent pixels on it)", !!thumb && thumb.w >= 28 && thumb.w === thumb.h, JSON.stringify(thumb));
  check("the thumbnail is the spec image itself", await until("composer thumbnail", () => js<boolean>(`(document.querySelector('[data-testid="composer"] [data-testid="prompt-attachment"] img')?.naturalWidth ?? 0) === 480`), 5000).catch(() => false));
  check("the composer's input has the focus", await js<boolean>(`document.activeElement === document.querySelector('[data-testid="composer"] .composer-input')`));

  // ================================================================ 2. the waiting image, again
  await js(`document.querySelector('[data-testid="composer"] .prompt-attachment-row-open').click()`);
  await until("composer lightbox", () => exists(".lightbox-stage img"), 5000);
  const lb1 = await until("the lightbox's marks", async () => {
    const o = await overlay('[data-testid="lightbox-annotation"]');
    return o && o.accent > 0 ? o : null;
  }, 5000).catch(() => null);
  const lbImg = await rectOf(".lightbox-stage img");
  check("the lightbox draws the marks over the whole image", !!lb1 && lb1.marks === 3 && !!lbImg && Math.abs(lb1.w - lbImg.width) <= 1 && Math.abs(lb1.h - lbImg.height) <= 1, JSON.stringify({ lb1, lbImg }));
  check("a waiting image offers Annotate", await exists('[data-testid="lightbox-annotate"]'));
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  await annotatorOpen();
  list = await rows();
  check("its marks reopen to edit", list.map((r) => r.message).join("|") === "Make this heading bolder|This spacing is off|Add the Save button here", JSON.stringify(list));
  check("…drawn where they were", (await badgeAt(0.55, 0.15)) && (await badgeAt(0.85, 0.3)));
  // Closing untouched loses nothing, so it doesn't ask; with a change it asks, and No keeps it open.
  await js(`window.__asked = 0; window.confirm = () => (window.__asked++, false)`);
  await key("Escape", "Escape", 27);
  check("Esc on reopened marks left as they were closes without asking", !(await exists('[data-testid="annotator"]')) && (await js<number>("window.__asked")) === 0);
  await js(`document.querySelector('[data-testid="composer"] .prompt-attachment-row-open').click()`);
  await until("composer lightbox", () => exists('[data-testid="lightbox-annotate"]'), 5000);
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  await annotatorOpen();
  await typeIn(2, "The spacing between these is off");
  await js(`document.querySelector('[data-testid="annotator-canvas"]').focus()`);
  await key("Escape", "Escape", 27);
  check("Esc after an edit asks first, and No keeps the annotator", (await js<number>("window.__asked")) === 1 && (await exists('[data-testid="annotator"]')));
  await js(`document.querySelector('[data-testid="annotator-add"]').click()`);
  await until("the annotator closes", async () => !(await exists('[data-testid="annotator"]')), 5000);
  crow = (await composerRows())[0] ?? null;
  check("annotating it again edits it in place: still one row, 3 notes", (await composerRows()).length === 1 && crow?.notes === "3 notes", JSON.stringify(await composerRows()));
  const notes2 = await openNotes('[data-testid="composer"]');
  check("with the edited note", notes2[1] === "2The spacing between these is off", JSON.stringify(notes2));
  await typeComposer("Two things on the settings mockup, and the Save button.");
  await shot("composer");
  await sendComposer();
  const first = await until("the message reaches the service", async () => (await userMessages())[messagesBefore], 15000);
  const c1 = first.content as TextContent;
  const a1 = c1.attachments?.[0];
  const n1 = a1?.annotation;
  check("the message's text", c1.text === "Two things on the settings mockup, and the Save button.", c1.text);
  check("its attachment is the spec image: same id, source spec, its stored file", c1.attachments?.length === 1 && !!a1 && a1.id === specId && a1.source === "spec" && existsSync(a1.path) && sha(readFileSync(a1.path)) === sha(specBytesBefore), JSON.stringify(a1));
  check("with its annotation: the image's size, three marks (two arrows, a click) in its pixels", !!n1 && n1.width === 480 && n1.height === 320 && n1.marks.length === 3 && n1.marks[0]!.tailX !== undefined && n1.marks[1]!.tailX !== undefined && n1.marks[2]!.tailX === undefined, JSON.stringify(n1));
  check("marks numbered, with their messages, where they were drawn", !!n1 && n1.marks.map((m) => m.n).join() === "1,2,3" && Math.abs(n1.marks[0]!.x - 120) <= 3 && Math.abs(n1.marks[0]!.y - 96) <= 3 && Math.abs(n1.marks[2]!.x - 408) <= 3 && n1.marks[1]!.message === "The spacing between these is off", JSON.stringify(n1?.marks));
  const runs = (await detail()).runs;
  check("the run that took the message carries the annotated attachment", runs.some((r) => r.attachments?.[0]?.annotation?.marks.length === 3), JSON.stringify(runs.map((r) => r.attachments?.map((a) => a.annotation?.marks.length ?? 0))));
  // The dummy agent says back the prompt it got: the service's <attachments> block, with the notes under the file.
  const said = await until("the agent's reply quotes the notes", async () => (await transcript()).find((e) => e.role === "assistant" && e.content.type === "text" && e.content.text.includes("The spacing between these is off")), 15000).catch(() => null);
  check("the agent's prompt has the notes, under the image's path", !!said && (said.content as TextContent).text.includes(a1!.path) && (said.content as TextContent).text.includes("Make this heading bolder"), (said?.content as TextContent | undefined)?.text.slice(0, 300));
  const specBytesAfter = await fetchBytes(`/attachments/${encodeURIComponent(specId)}`);
  check("the spec image's file is unchanged", sha(specBytesAfter) === sha(specBytesBefore) && sha(readFileSync(a1!.path)) === sha(specBytesBefore));
  check("the composer is empty again", (await composerRows()).length === 0);

  // ================================================================ 3. the sent image in the Transcript
  check("after sending, the Transcript shows", await until("transcript tab", () => exists('.tab.on[data-tab="transcript"]'), 8000).catch(() => false));
  const tScope = '[data-testid="message-attachments"]';
  const tThumb = await until("the sent thumbnail's marks", async () => {
    const o = await overlay(`${tScope} [data-testid="thumbnail-annotation"]`);
    return o && o.accent > 0 ? o : null;
  }, 10000).catch(() => null);
  check("the Transcript draws the marks over the sent image's thumbnail", tThumb?.marks === 3, JSON.stringify(tThumb));
  const tNotes = await openNotes(tScope);
  check("under it: 3 notes, open to the numbered list", tNotes.join("|") === "1Make this heading bolder|2The spacing between these is off|3Add the Save button here", JSON.stringify(tNotes));
  await js(`document.querySelector('${tScope}').scrollIntoView({ block: "center" })`);
  await shot("transcript");
  await js(`document.querySelector('${tScope} .prompt-attachment-row-open').click()`);
  await until("lightbox", () => exists(".lightbox-stage img"), 5000);
  const lb2 = await until("the sent image's marks in the lightbox", async () => {
    const o = await overlay('[data-testid="lightbox-annotation"]');
    return o && o.accent > 0 ? o : null;
  }, 5000).catch(() => null);
  check("the lightbox draws the marks over the sent image", lb2?.marks === 3, JSON.stringify(lb2));
  await shot("lightbox");
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  await annotatorOpen();
  check("Annotate on a sent image reopens the marks it went with", (await rows()).length === 3);
  await click([0.15, 0.85]);
  await typeIn(4, "And this corner");
  await js(`document.querySelector('[data-testid="annotator-add"]').click()`);
  await until("the annotator closes", async () => !(await exists('[data-testid="annotator"]')), 5000);
  crow = (await composerRows())[0] ?? null;
  check("Add puts the same attachment (its id) in the composer, with 4 notes", crow?.id === a1?.id && crow?.notes === "4 notes" && crow?.thumbMarks === 4, JSON.stringify(crow));

  // ================================================================ 4. the browser pane
  await go(`#/board/${project.id}/ticket/${ticket.key}/browser`);
  const ready = await until("the page's first frame", () => js<boolean>(`!!document.querySelector('[data-testid="browser-annotate"]') && !document.querySelector('[data-testid="browser-annotate"]').disabled`), 20000).catch(() => false);
  check("the browser pane offers Annotate once the page is drawn", ready);
  // A new tab is Responsive and follows this pane. Annotate is pressed right after opening the size
  // row, which shortens the stage, before the new size has reached the tab, so the screenshot has
  // to wait for it.
  await js(`document.querySelector('[data-testid="browser-size-toggle"]').click()`);
  await until("the size row", () => exists('[data-testid="browser-responsive"]'), 5000);
  check("the tab follows this pane", await js<boolean>(`document.querySelector('[data-testid="browser-responsive"]').classList.contains("owned")`));
  const stageSize = await js<{ width: number; height: number }>(`(() => { const s = document.querySelector('.browser-stage'); return { width: Math.round(s.clientWidth), height: Math.round(s.clientHeight) }; })()`);
  await js(`document.querySelector('[data-testid="browser-annotate"]').click()`);
  check("Annotate opens the annotator on a frozen screenshot of the page", await annotatorOpen());
  const elementLabels = () => js<(string | null)[]>(`[...document.querySelectorAll('[data-testid="annotator-row"]')].map(r => r.querySelector('[data-testid="annotator-element"]')?.textContent ?? null)`);
  // The arrow's head (its anchor, where the press started) on the Save button.
  await drag([0.5, 0.6], [0.2, 0.35]);
  await typeIn(1, "Save should be the accent colour");
  const named = await until("mark 1 names the button", async () => ((await elementLabels())[0] ? await elementLabels() : null), 8000).catch(() => null);
  check("a mark on the page names the element under its anchor, under its note", named?.[0] === '#save · "Save"', JSON.stringify(named));
  await click([0.85, 0.03]);
  await typeIn(2, "And move this");
  const header = await until("mark 2 names the header", async () => ((await elementLabels())[1] ? await elementLabels() : null), 8000).catch(() => null);
  check("a click on the header names the header", !!header?.[1] && header[1].includes("Acme settings") && !header[1].includes("#save"), JSON.stringify(header));
  await drag([0.85, 0.03], [0.65, 0.5]);
  const moved = await until("mark 2 names the button now", async () => ((await elementLabels())[1] === '#save · "Save"' ? await elementLabels() : null), 8000).catch(() => null);
  check("dragging its anchor onto the button names the button instead", !!moved, JSON.stringify(await elementLabels()));
  const overlap3 = await noOverlap();
  check("the notes sit beside the page, none over it", overlap3.ok, overlap3.detail);
  await shot("browser-annotator");
  await js(`document.querySelector('[data-testid="annotator-add"]').click()`);
  await until("the annotator closes", async () => !(await exists('[data-testid="annotator"]')), 8000);
  const both = await composerRows();
  check("the screenshot joins the composer as a second row, 2 notes", both.length === 2 && both[1]!.notes === "2 notes" && both[1]!.thumbMarks === 2 && both[1]!.source === "upload", JSON.stringify(both));
  await typeComposer("The corner, and the page's Save button.");
  await sendComposer();
  const second = await until("the second message", async () => (await userMessages())[messagesBefore + 1], 15000).catch(() => null);
  const c2 = second?.content as TextContent | undefined;
  const page = c2?.attachments?.[1]?.annotation?.page;
  check("both go, each with its own annotation", c2?.attachments?.length === 2 && c2.attachments[0]!.annotation?.marks.length === 4 && c2.attachments[1]!.annotation?.marks.length === 2, JSON.stringify(c2?.attachments?.map((a) => a.annotation?.marks.length)));
  check("the screenshot's annotation has the page: url, title, tab, viewport and scale", page?.url === pageUrl && page.title === "Settings" && page.tabId >= 1 && page.viewport.width > 0 && page.scale > 0, JSON.stringify(page));
  const shotAnn = c2?.attachments?.[1]?.annotation;
  check("each of its marks tells the agent the element it points at (path and text)", shotAnn?.marks.every((m) => m.path === "#save" && m.text === "Save") === true, JSON.stringify(shotAnn?.marks.map((m) => [m.path, m.text])));
  check("marks on other images never name an element", c2?.attachments?.[0]?.annotation?.marks.every((m) => m.path === undefined && m.text === undefined) === true);
  check("with Responsive on, the screenshot is of the page at the pane's size, not the tab's size before it followed the pane", !!page && page.viewport.width === stageSize.width && page.viewport.height === stageSize.height, JSON.stringify({ page: page?.viewport, stage: stageSize }));
  check("the screenshot's size is the page's in device pixels, named after its host", !!shotAnn && !!page && Math.abs(shotAnn.width - page.viewport.width * page.scale) <= 2 && c2!.attachments![1]!.name === "127.0.0.1.png", JSON.stringify({ w: shotAnn?.width, name: c2?.attachments?.[1]?.name }));

  // ================================================================ 5. New session
  // The send finished in the app (it then shows the Transcript, which would win over a navigation started before).
  await until("the composer clears after the send", async () => (await composerRows()).length === 0, 10000);
  await Bun.sleep(300);
  await go("#/compose");
  await until("New session pane", () => exists('[data-testid="draft-pane"] .draft-prompt'), 10000);
  await type(".draft-prompt", "Make the diagram match.");
  const draftKey = await until("the draft is saved", () => js<string | null>(`document.querySelector('[data-testid="draft-pane"]')?.dataset.draftKey ?? null`), 10000);
  const doc = await cdp("DOM.getDocument", {});
  const input = await cdp("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: '[data-testid="draft-pane"] [data-testid="prompt-attach-input"]' });
  await cdp("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [diagram] });
  await until("the draft's row", () => exists('[data-testid="draft-pane"] [data-testid="prompt-attachment"] img'), 5000);
  await js(`document.querySelector('[data-testid="draft-pane"] .prompt-attachment-row-open').click()`);
  await until("draft lightbox", () => exists(".lightbox-stage img"), 5000);
  check("an image in a New session offers Annotate", await exists('[data-testid="lightbox-annotate"]'));
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  await annotatorOpen();
  await click([0.3, 0.4]);
  await typeIn(1, "This box is the API");
  await drag([0.7, 0.6], [0.9, 0.85]);
  await typeIn(2, "Arrow should go the other way");
  await js(`document.querySelector('[data-testid="annotator-add"]').click()`);
  await until("the annotator closes", async () => !(await exists('[data-testid="annotator"]')), 5000);
  const draftRow = () =>
    js<{ n: number; notes: string | null; thumbMarks: number | null }>(`(() => { const rows = document.querySelectorAll('[data-testid="draft-pane"] [data-testid="prompt-attachment"]'); const el = rows[0];
      return { n: rows.length, notes: el?.querySelector('[data-testid="annotation-notes"] button')?.textContent.trim() ?? null, thumbMarks: el?.querySelector('[data-testid="thumbnail-annotation"]') ? Number(el.querySelector('[data-testid="thumbnail-annotation"]').dataset.marks) : null }; })()`);
  const dr = await draftRow();
  check("the draft's image is annotated in place: one row, marks over the thumbnail, 2 notes", dr.n === 1 && dr.notes === "2 notes" && dr.thumbMarks === 2, JSON.stringify(dr));
  const saved = await until("the draft saves the annotation", async () => {
    const a = (await detail(draftKey)).ticket.promptAttachments?.[0];
    return a?.annotation?.marks.length === 2 ? a : null;
  }, 8000).catch(() => null);
  const draftRowId = await js<string | null>(`document.querySelector('[data-testid="draft-pane"] [data-testid="prompt-attachment"]')?.dataset.id ?? null`);
  check("saved with the draft, on the same file (registered in place, not a copy)", saved?.path === diagram && saved.source === "file" && !!saved.id && saved.id === draftRowId && saved.annotation?.width === 400 && saved.annotation.height === 260, JSON.stringify(saved));
  await shot("new-session");

  await js("location.reload()");
  await until("reloaded", () => exists('[data-testid="pane-board"], .sidebar'), 15000);
  await go(`#/board/${project.id}/ticket/${draftKey}`);
  const reopened = await until("the reopened draft's row", async () => {
    const r = await js<{ notes: string | null; thumbMarks: number | null } | null>(`(() => { const el = document.querySelector('[data-draft-key=${JSON.stringify(draftKey)}] [data-testid="prompt-attachment"]'); if (!el) return null;
      return { notes: el.querySelector('[data-testid="annotation-notes"] button')?.textContent.trim() ?? null, thumbMarks: el.querySelector('[data-testid="thumbnail-annotation"]') ? Number(el.querySelector('[data-testid="thumbnail-annotation"]').dataset.marks) : null }; })()`);
    return r?.thumbMarks ? r : null;
  }, 10000).catch(() => null);
  check("a reopened draft shows the marks and notes", reopened?.notes === "2 notes" && reopened.thumbMarks === 2, JSON.stringify(reopened));
  await js(`document.querySelector('[data-draft-key=${JSON.stringify(draftKey)}] .prompt-attachment-row-open').click()`);
  await until("lightbox", () => exists(".lightbox-stage img"), 5000);
  check("…and still offers Annotate (the image is untouched)", await exists('[data-testid="lightbox-annotate"]'));
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  await annotatorOpen();
  list = await rows();
  check("which reopens its marks", list.map((r) => r.message).join("|") === "This box is the API|Arrow should go the other way", JSON.stringify(list));
  await typeIn(1, "This box is the public API");
  await js(`document.querySelector('[data-testid="annotator-add"]').click()`);
  await until("the annotator closes", async () => !(await exists('[data-testid="annotator"]')), 5000);
  const edited = await until("the edit saves", async () => {
    const a = (await detail(draftKey)).ticket.promptAttachments?.[0];
    return a?.annotation?.marks[0]?.message === "This box is the public API" ? a : null;
  }, 8000).catch(() => null);
  check("the edited marks save with the draft, still one attachment", !!edited && (await detail(draftKey)).ticket.promptAttachments?.length === 1);

  await js(`document.querySelector('[data-testid="draft-plan"]').click()`);
  await until("launched", async () => (await detail(draftKey)).ticket.draft === false, 10000);
  // The service writes the notes into the first run's <attachments> block when it hands the run to
  // the driver (service/src/orchestrator/prompt-annotations.test.ts covers the text); Run.prompt
  // keeps only the human's words, so what's checked here is what that block is made from.
  const run = await until("the first run", async () => (await detail(draftKey)).runs[0], 10000).catch(() => null);
  const launched = (await detail(draftKey)).ticket.promptAttachments ?? [];
  check("the launched session's run has the human's words, and its attachment the edited notes it goes with", !!run && run.prompt.startsWith("Make the diagram match.") && launched.length === 1 && launched[0]!.path === diagram && launched[0]!.annotation?.marks.map((m) => m.message).join("|") === "This box is the public API|Arrow should go the other way", JSON.stringify({ prompt: run?.prompt.slice(0, 80), launched }));
  await go(`#/board/${project.id}/ticket/${draftKey}/spec`);
  const specScope = '[data-testid="spec-prompt-attachments"]';
  const specThumb = await until("the Spec tab's marks", async () => {
    const o = await overlay(`${specScope} [data-testid="thumbnail-annotation"]`);
    return o && o.accent > 0 ? o : null;
  }, 10000).catch(() => null);
  check("the Spec tab draws the marks over its prompt attachment", specThumb?.marks === 2, JSON.stringify(specThumb));
  const specNotes = await openNotes(specScope);
  check("…with 2 notes that open to the list", specNotes.join("|") === "1This box is the public API|2Arrow should go the other way", JSON.stringify(specNotes));
  await js(`document.querySelector('${specScope}').scrollIntoView({ block: "center" })`);
  await shot("spec-tab");
} catch (e) {
  console.error(e);
  counter.fail();
} finally {
  await app?.close();
  daemon.kill();
  await stopped(daemon);
  site.stop(true);
}
console.log(counter.failures ? `\n${counter.failures} check(s) failed` : "\nall checks passed");
process.exit(counter.failures ? 1 : 0);
