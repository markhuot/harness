// Annotations end to end in the built app, against the REAL service (throwaway HARNESS_HOME, dummy
// driver, real headless Chrome for the session browser): a spec image opened in the lightbox →
// Annotate; two arrows dragged and one spot clicked, each with its message; a mark moved and
// deleted with the Delete key (the list renumbers, the badges follow), ⌘Z bringing it back, × on a
// row; the notes never over the image; Send: the Transcript shows the annotated image with "2
// notes" that open to the list, and the service has the annotations on the transcript entry and
// the run. Then the same from a Transcript message attachment (with Esc asking before discarding)
// and from the browser pane's Annotate (a frozen screenshot of a local page). The composer's own
// pending list offers no Annotate; the Spec tab's prompt attachments do.
//
//   bun run build && bun scripts/annotate-check.ts [--shots=<dir>] [--theme=dark]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageAnnotation, Project, PromptAttachment, Ticket, TicketDetail, TranscriptEntry } from "@harness/shared";
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
const whiteboard = join(projectDir, "whiteboard.png");
writeFileSync(whiteboard, png(200, 120, [254, 243, 199], [251, 191, 36]));
const composerFile = join(projectDir, "pending.png");
writeFileSync(composerFile, png(64, 64, [37, 99, 235], [16, 185, 129]));

// A plain local page for the session browser.
const site = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(
      `<!doctype html><title>Settings</title><body style="margin:0;font:16px -apple-system;background:#f8fafc">
       <header style="height:56px;background:#1e293b;color:#fff;display:flex;align-items:center;padding:0 20px">Acme settings</header>
       <main style="padding:24px"><h1>Profile</h1><button style="font-size:16px;padding:8px 14px">Save</button></main></body>`,
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
const shot = async (name: string) => {
  if (!shots || !app) return;
  await Bun.sleep(400);
  await app.screenshot(join(shots, `annotate-${name}-${theme}.png`));
};

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "annotate", key: "ANN" });
  // The dummy agent puts a screenshot in the spec (stored as attachment:<id>) and opens the local page.
  const tools = [
    { name: "update_spec", input: { base_revision: 1, note: "Added the mockup", spec: "# Settings page\n\n![Settings mockup](shots/mockup.png)\n\nMake it match.\n" } },
    { name: "browser_open", input: { url: pageUrl } },
  ];
  const ticket = await api<Ticket>("POST", "/tickets", {
    projectId: project.id,
    spec: `/tools ${JSON.stringify(tools)}`,
    driver: "dummy",
    start: true,
    promptAttachments: [{ path: whiteboard, name: "whiteboard.png", source: "file" }],
  });
  const detail = () => api<TicketDetail>("GET", `/tickets/${ticket.key}`);
  await until("the spec has the mockup", async () => /\]\(attachment:[^)]+\)/.test((await detail()).ticket.spec), 30000);
  await until("the agent is idle", async () => !(await detail()).ticket.busy, 30000);
  const transcript = () => api<TranscriptEntry[]>("GET", `/sessions/${ticket.sessionId}/transcript?after=0`);
  const annotatedEntries = async () => (await transcript()).filter((e) => e.role === "user" && e.content.type === "text" && !!e.content.annotations?.length);

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
  /** The canvas pixel at fractions of the image, as "accent" (the badge fill), "white", or something else. */
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
    const others = await js<Rect[]>(`[...document.querySelectorAll('[data-testid="annotator-side"], [data-testid="annotator-row"], [data-testid="annotator-message"], [data-testid="annotator-note"]')].map(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })`);
    const hits = others.filter((o) => o.left < c.right && o.right > c.left && o.top < c.bottom && o.bottom > c.top);
    return { ok: others.length > 0 && hits.length === 0, detail: `${others.length} elements, ${hits.length} over the image` };
  };
  const annotatorOpen = () => until("the annotator's image", async () => ((await canvasRect())?.width ?? 0) > 0, 10000).then(() => true, () => false);

  // ================================================================ the composer's own list: no Annotate
  await go(`#/board/${project.id}/ticket/${ticket.key}/spec`);
  await until("the composer", () => exists('[data-testid="composer"] .composer-input'), 10000);
  const doc = await cdp("DOM.getDocument", {});
  const input = await cdp("DOM.querySelector", { nodeId: doc.result.root.nodeId, selector: '[data-testid="composer-attach-input"]' });
  await cdp("DOM.setFileInputFiles", { nodeId: input.result.nodeId, files: [composerFile] });
  await until("composer attachment", () => exists('[data-testid="composer"] [data-testid="prompt-attachment"]'), 5000);
  await js(`document.querySelector('[data-testid="composer"] .prompt-attachment-row-open').click()`);
  await until("composer lightbox", () => exists(".lightbox-stage img"), 5000);
  check("a file waiting in the composer opens in the lightbox without Annotate", !(await exists('[data-testid="lightbox-annotate"]')));
  await key("Escape", "Escape", 27);
  await js(`document.querySelector('[data-testid="composer"] [data-testid="prompt-attachment-remove"]').click()`);

  // ================================================================ the Spec tab's prompt attachments: Annotate
  await until("the Spec tab's attachments", () => exists('[data-testid="spec-prompt-attachments"] .prompt-attachment-row-open'), 10000);
  await js(`document.querySelector('[data-testid="spec-prompt-attachments"] .prompt-attachment-row-open').click()`);
  const promptAnnotate = await until("prompt attachment Annotate", () => exists('[data-testid="lightbox-annotate"]'), 5000).catch(() => false);
  check("a prompt attachment on the Spec tab offers Annotate", promptAnnotate);
  await key("Escape", "Escape", 27);

  // ================================================================ 1. a spec image
  const fig = await until("the spec's figure", () => exists(".md img"), 10000).catch(() => false);
  check("the spec shows the mockup", fig);
  await js(`document.querySelector(".md img").click()`);
  await until("lightbox", () => exists(".lightbox-stage img"), 5000);
  check("the spec image's lightbox offers Annotate", await exists('[data-testid="lightbox-annotate"]'));
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  check("Annotate opens the annotator on the image (and closes the lightbox)", (await annotatorOpen()) && !(await exists(".lightbox-stage")));
  check("Send waits for a note", await js<boolean>(`document.querySelector('[data-testid="annotator-send"]').disabled`));

  await drag([0.25, 0.3], [0.55, 0.15]);
  check("dragging makes note 1 and focuses its field", (await rows()).length === 1 && (await focusedRow()) === "1");
  await typeIn(1, "Make this heading bolder");
  await drag([0.7, 0.75], [0.45, 0.88]);
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
  list = await rows();
  check("× on a row deletes that note", list.map((r) => `${r.n}:${r.message}`).join("|") === "1:Make this heading bolder|2:Add the Save button here", JSON.stringify(list));
  await type('[data-testid="annotator-note"]', "Two things on the settings mockup.");
  await shot("annotator-renumbered");

  await js(`document.querySelector('[data-testid="annotator-send"]').click()`);
  const first = await until("the annotated message reaches the service", async () => (await annotatedEntries())[0], 15000);
  check("after sending, the annotator closes and the Transcript shows", await until("transcript tab", async () => !(await exists('[data-testid="annotator"]')) && (await exists('.tab.on[data-tab="transcript"]')), 8000).catch(() => false));
  const c1 = first.content as { text: string; attachments?: PromptAttachment[]; annotations?: MessageAnnotation[] };
  const a1 = c1.annotations![0]!;
  check("the note is the message's text", c1.text === "Two things on the settings mockup.", c1.text);
  check("one annotated picture is attached, named after the source", c1.attachments?.length === 1 && c1.attachments[0]!.name === "annotated-Settings-mockup.png", JSON.stringify(c1.attachments));
  check("its source is the spec attachment", a1.source.kind === "attachment" && a1.source.name === "Settings mockup", JSON.stringify(a1.source));
  check("at the image's own size, with two marks: an arrow and a click", a1.width === 480 && a1.height === 320 && a1.marks.length === 2 && a1.marks[0]!.tailX !== undefined && a1.marks[1]!.tailX === undefined, JSON.stringify(a1));
  check("marks in image pixels, numbered, with their messages", a1.marks[0]!.n === 1 && Math.abs(a1.marks[0]!.x - 120) <= 3 && Math.abs(a1.marks[0]!.y - 96) <= 3 && a1.marks[1]!.message === "Add the Save button here", JSON.stringify(a1.marks));
  const runs = (await detail()).runs;
  check("the run that took the message has the annotations too", runs.some((r) => r.annotations?.[0]?.marks.length === 2), JSON.stringify(runs.map((r) => r.annotations?.length ?? 0)));

  const sentImage = await until("the annotated image in the Transcript", () => js<number[] | null>(`(() => { const i = document.querySelector('[data-testid="message-attachments"] img'); return i && i.naturalWidth ? [i.naturalWidth, i.naturalHeight] : null; })()`), 10000).catch(() => null);
  check("the Transcript shows the annotated image the service has", JSON.stringify(sentImage) === "[480,320]", JSON.stringify(sentImage));
  check("under it: 2 notes, closed", (await js<string>(`document.querySelector('[data-testid="annotation-notes"] button')?.textContent.trim() ?? ""`)).startsWith("2 notes") && !(await exists('[data-testid="annotation-notes-list"]')));
  await js(`document.querySelector('[data-testid="annotation-notes"] button').click()`);
  const notes = await js<string[]>(`[...document.querySelectorAll('[data-testid="annotation-notes-list"] li')].map(li => li.textContent.trim())`);
  check("which open to the numbered list", notes.join("|") === "1Make this heading bolder|2Add the Save button here", JSON.stringify(notes));
  await js(`document.querySelector('[data-testid="annotation-notes"]').scrollIntoView({ block: "center" })`);
  await shot("transcript-notes");

  // ================================================================ 2. a Transcript message attachment
  await js(`document.querySelector('[data-testid="message-attachments"] .prompt-attachment-row-open').click()`);
  await until("lightbox", () => exists(".lightbox-stage img"), 5000);
  check("a message's image offers Annotate", await exists('[data-testid="lightbox-annotate"]'));
  await js(`document.querySelector('[data-testid="lightbox-annotate"]').click()`);
  await annotatorOpen();
  await click([0.5, 0.5]);
  await typeIn(1, "Still too tight");
  // Esc with notes asks first; saying no keeps them.
  await js(`window.__asked = 0; window.confirm = () => (window.__asked++, false)`);
  await key("Escape", "Escape", 27);
  check("Esc with notes asks before discarding, and No keeps the annotator", (await js<number>("window.__asked")) === 1 && (await exists('[data-testid="annotator"]')));
  await js(`document.querySelector('[data-testid="annotator-send"]').click()`);
  const second = await until("the second annotated message", async () => (await annotatedEntries())[1], 15000).catch(() => null);
  const a2 = (second?.content as { annotations?: MessageAnnotation[] } | undefined)?.annotations?.[0];
  check("its source is the earlier message's attachment", a2?.source.kind === "message-attachment" && a2.source.entryId === first.id && a2.source.index === 0, JSON.stringify(a2?.source));
  check("one click mark with its message", a2?.marks.length === 1 && a2.marks[0]!.tailX === undefined && a2.marks[0]!.message === "Still too tight", JSON.stringify(a2?.marks));

  // ================================================================ 3. the browser pane
  await go(`#/board/${project.id}/ticket/${ticket.key}/browser`);
  const ready = await until("the page's first frame", () => js<boolean>(`!!document.querySelector('[data-testid="browser-annotate"]') && !document.querySelector('[data-testid="browser-annotate"]').disabled`), 20000).catch(() => false);
  check("the browser pane offers Annotate once the page is drawn", ready);
  await js(`document.querySelector('[data-testid="browser-annotate"]').click()`);
  check("Annotate opens the annotator on a frozen screenshot of the page", await annotatorOpen());
  await drag([0.12, 0.3], [0.3, 0.45]);
  await typeIn(1, "Save should be the accent colour");
  const overlap3 = await noOverlap();
  check("the notes sit beside the page, none over it", overlap3.ok, overlap3.detail);
  await shot("browser-annotator");
  await js(`window.confirm = () => true`);
  await js(`document.querySelector('[data-testid="annotator-send"]').click()`);
  const third = await until("the browser annotation", async () => (await annotatedEntries())[2], 15000).catch(() => null);
  const a3 = (third?.content as { annotations?: MessageAnnotation[]; attachments?: PromptAttachment[] } | undefined);
  const s3 = a3?.annotations?.[0]?.source;
  check("its source is the browser tab, with the page's url, viewport and scale", s3?.kind === "browser" && s3.url === pageUrl && s3.title === "Settings" && s3.tabId >= 1 && s3.viewport.width > 0 && s3.scale > 0, JSON.stringify(s3));
  check("the picture is named after the page's host", a3?.attachments?.[0]?.name === "annotated-127.0.0.1.png", JSON.stringify(a3?.attachments));
  const w3 = a3?.annotations?.[0];
  check("the image size is the screenshot's device pixels", !!w3 && s3?.kind === "browser" && Math.abs(w3.width - s3.viewport.width * s3.scale) <= 2, JSON.stringify(w3 && { w: w3.width, h: w3.height }));
  await until("transcript tab", () => exists('.tab.on[data-tab="transcript"]'), 5000).catch(() => false);
  await until("third message's notes", () => js<boolean>(`document.querySelectorAll('[data-testid="annotation-notes"]').length >= 3`), 8000).catch(() => false);
  await js(`[...document.querySelectorAll('[data-testid="annotation-notes"]')].pop().scrollIntoView({ block: "center" })`);
  await shot("transcript-browser");
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
