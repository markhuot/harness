// The Spec and Activity tabs against the REAL service (dummy driver, throwaway HARNESS_HOME):
// a ticket whose spec has several revisions, a nested list and an inline image, and whose
// Activity has a review round and a blocked question. Checks the history bar and its revision
// timeline (drag, hover, keys, and a ticket with dozens of revisions), Show changes (the
// rendered spec with edits marked in place), the blocked card, that Activity records every column
// move in one line per entry, that a message sent from Spec or Activity switches to the Transcript
// and stays out of Activity, and the Details editor's conflict prompt, with a screenshot of each.
//
//   bun run build && bun scripts/spec-activity.ts [screenshotDir] [--theme=dark]
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ActivityEntry, Project, Ticket, TicketDetail } from "@harness/shared";
import { cleanupTempDirs, tempDir } from "@harness/shared/testing";
import { api as makeApi, appDir, checker, launchApp, until, waitHealthy } from "./lib/drive";

const shots = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? join(appDir, "out", "screenshots", "spec-activity"));
const theme = (process.argv.find((a) => a.startsWith("--theme="))?.slice(8) ?? "light") as "light" | "dark";
mkdirSync(shots, { recursive: true });

const home = tempDir("harness-spec-home-");
const projectDir = tempDir("harness-spec-project-");
const port = 7800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const daemon = Bun.spawn(["bun", join(appDir, "..", "service/src/daemon.ts")], {
  env: { ...process.env, HARNESS_HOME: home, HARNESS_PORT: String(port), HARNESS_DUMMY_DRIVER: "1", HARNESS_DUMMY_DELAY_MS: "40" },
  stdout: "ignore",
  stderr: "inherit",
});

const SPEC = `## Goal
Add a dark mode switch to Settings → Appearance.

## Plan
- Settings
  - Add an **Appearance** section
    - A three-way switch: System, Light, Dark
  - Save the choice with the other settings
- Theme
  - Follow the system until someone picks a side
1. Wire it up:
   \`\`\`sh
   # The switch reads the saved choice

   bun run app
   \`\`\`
   Then flip the switch.
2. Test it

## Status
Not started.`;

const c = checker();
const { check } = c;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
const shot = async (name: string) => {
  await Bun.sleep(400); // let fade-ins and lazy diff rendering settle
  await app!.screenshot(join(shots, `${name}-${theme}.png`));
};

try {
  await waitHealthy(base, 15000);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const api = makeApi(base, token);
  const project = await api<Project>("POST", "/projects", { path: projectDir, name: "hello", key: "HELLO" });
  app = await launchApp({ baseUrl: base, token, theme });
  const { js, exists, type, cmdEnter, clickText, go, cdp, key: press } = app;
  await until("sidebar shows the project", () => js<boolean>(`document.querySelector(".sidebar")?.textContent.includes("hello")`), 10000);

  // The "screenshot" the agent attaches: the app's own board, saved in the project dir.
  await go(`#/board/${project.id}`);
  mkdirSync(join(projectDir, "shots"), { recursive: true });
  await Bun.sleep(500);
  await app.screenshot(join(projectDir, "shots", "after.png"));

  // rev 1 (created), rev 2 (the plan run), then a human rewrite as rev 3.
  const created = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Dark mode switch", title: "Dark mode switch", driver: "dummy", start: false });
  const key = created.key;
  await until("plan drafted", async () => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket.specRevision === 2, 15000);
  const idle = (k: string) => until(`${k} idle`, async () => !(await api<TicketDetail>("GET", `/tickets/${k}`)).ticket.busy, 20000);
  await idle(key);
  await api<Ticket>("PATCH", `/tickets/${key}`, { spec: SPEC, baseRevision: 2, specNote: "Wrote the goal and plan" });
  // Start: rev 3 is the approved baseline; the dummy's work run edits Status (rev 4), submits, and its review approves.
  await api<Ticket>("POST", `/tickets/${key}/start`);
  await until("agent review approved", async () => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket.agentReview === "approved", 30000);
  await idle(key);
  // Back to work: an edit_spec that adds a local screenshot (stored, src rewritten) as rev 5. The
  // dummy then brings Status up to date (rev 6) and submits; its review approves round 2.
  const now = (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket.specRevision!;
  const tools = [
    {
      name: "edit_spec",
      input: {
        base_revision: now,
        note: "Added the screenshot",
        edits: [
          { old_string: "## Status\n", new_string: "## Screenshot\n![The board after the change](shots/after.png)\n\n## Status\n" },
          { old_string: "with the other settings", new_string: "with the other preferences" },
        ],
      },
    },
    // Longer than a line: Activity shows the first, the rest behind Show details.
    { name: "post_note", input: { note: "Added the board screenshot to the spec.\n\nIt shows the card after the change, taken from the app itself." } },
  ];
  await api<Ticket>("POST", `/tickets/${key}/messages`, { text: `/tools ${JSON.stringify(tools)}`, move: true });
  await until("round 2 approved", async () => (await api<TicketDetail>("GET", `/tickets/${key}`)).activity.filter((e) => e.kind === "review_approved").length === 2, 30000);
  await idle(key);
  // Then a question.
  await api<Ticket>("POST", `/tickets/${key}/messages`, { text: "/block Should **System** stay the default, or should new installs start in Light?", move: true });
  await until("blocked", async () => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket.status === "blocked", 20000);
  await idle(key);
  const detail = await api<TicketDetail>("GET", `/tickets/${key}`);
  check("spec has six revisions", detail.ticket.specRevision === 6, `rev ${detail.ticket.specRevision}`);
  check("the image was stored as an attachment", /!\[[^\]]*\]\(attachment:[^)]+\)/.test(detail.ticket.spec));
  check("baseline is rev 3", detail.ticket.specBaselineRevision === 3, `baseline ${detail.ticket.specBaselineRevision}`);

  // --- Spec tab: the default tab, with the nested list and the inline image.
  await go(`#/board/${project.id}/ticket/${key}`);
  await until("spec tab", () => exists(".spec-doc"), 10000);
  check("a ticket opens on Spec", await js<boolean>(`document.querySelector('.tabs [data-tab=spec]')?.getAttribute('aria-selected') === 'true'`));
  check("the timeline is on rev 6 of 6", await js<boolean>(`document.querySelector('[data-testid="spec-timeline"]')?.getAttribute('aria-valuetext').startsWith('Rev 6 of 6')`));
  check("the bar names no count or author", await js<boolean>(`!/Rev \\d|Agent|You|Harness/.test(document.querySelector('.spec-history').textContent)`));
  check("the bar has no step or Latest buttons", await js<boolean>(`![...document.querySelectorAll('.spec-history button')].some((b) => /Previous|Next|Latest/.test(b.textContent + (b.getAttribute('aria-label') ?? '')))`));
  check("nested list renders nested", await js<boolean>(`!!document.querySelector('.spec-doc li ul li ul li, .spec-doc li ol li ol li, .spec-doc li ul li ol li')`));
  check(
    "a fence under a numbered step renders as code inside that step, followed by the step's paragraph",
    await js<boolean>(`(() => { const li = [...document.querySelectorAll('.spec-doc ol > li')].find((e) => e.textContent.startsWith('Wire it up')); return !!li?.querySelector('pre')?.textContent.includes('bun run app') && li.querySelector(':scope > .code-block ~ p')?.textContent === 'Then flip the switch.'; })()`),
  );
  check("the spec body is 14px with a 1.5 line height", await js<boolean>(`(() => { const s = getComputedStyle(document.querySelector('.spec-doc .md')); return s.fontSize === '14px' && s.lineHeight === '21px'; })()`));
  await until("inline image loaded", () => js<boolean>(`[...document.querySelectorAll('.spec-doc img')].some((i) => i.complete && i.naturalWidth > 0)`), 10000);
  await shot("1-spec");

  // --- Scrub back to rev 5 (the screenshot), Show changes.
  // Which revision is on show, as the timeline reports it ("Rev 5 of 6 · …").
  const meta = (rev: string) => js<boolean>(`!!document.querySelector('[data-testid="spec-timeline"]')?.getAttribute('aria-valuetext').startsWith(${JSON.stringify(rev)})`);
  const prev = async () => {
    await js(`document.querySelector('[data-testid="spec-timeline"]').focus()`);
    await press("ArrowLeft", "ArrowLeft", 37);
  };
  const toggleChanges = () => js(`[...document.querySelectorAll('.spec-history label')].find((e) => e.textContent.includes('Show changes'))?.click()`);
  await prev();
  await until("rev 5 shown", () => meta("Rev 5 of 6"), 5000);
  // Where the first heading sits, to check Show changes keeps unchanged content in place.
  const goalTop = () => js<number>(`[...document.querySelectorAll('.spec-doc h2')].find((h) => h.textContent === 'Goal')?.getBoundingClientRect().top ?? -1`);
  await until("rev 5 body", () => exists(".spec-doc h2"), 5000);
  const topBefore = await goalTop();
  await shot("2-history");
  await toggleChanges();
  await until("changes rendered", () => js<boolean>(`document.querySelector('.spec-doc')?.dataset.changes === '4-5'`), 10000);
  check("Show changes keeps the rendered headings", await js<boolean>(`document.querySelectorAll('.spec-doc h2').length >= 4`));
  check("Show changes keeps the nested list", await js<boolean>(`!!document.querySelector('.spec-doc li ul li ul li')`));
  check("the edited word is marked removed", await js<boolean>(`[...document.querySelectorAll('.spec-doc del')].some((e) => e.textContent.includes('settings'))`));
  check("the new word is marked added", await js<boolean>(`[...document.querySelectorAll('.spec-doc ins')].some((e) => e.textContent.includes('preferences'))`));
  check("the added screenshot section is an added block", await js<boolean>(`[...document.querySelectorAll('.spec-doc .md-diff-block.is-add')].some((e) => e.textContent.includes('Screenshot')) && !!document.querySelector('.spec-doc .md-diff-block.is-add .md-media')`));
  check("no raw diff view", !(await exists(".code-diff, .spec-diff")));
  const topAfter = await goalTop();
  check("unchanged content keeps its place", topBefore > 0 && topAfter === topBefore, `${topBefore} → ${topAfter}`);
  await shot("2-history-changes");
  await toggleChanges();
  await prev();
  await prev();
  await until("rev 3 shown", () => meta("Rev 3 of 6"), 5000);
  check("rev 3 is tagged Approved plan", await exists(".spec-baseline"));
  // Pinned: a new revision doesn't move the bar.
  const cur = (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
  await api<Ticket>("PATCH", `/tickets/${key}`, { spec: cur.spec + "\n", baseRevision: cur.specRevision, specNote: "Trailing newline" });
  check("pinned at rev 3 while rev 7 arrives", await until("rev 7 known", () => meta("Rev 3 of 7"), 3000));
  await press("End", "End", 35);
  check("End follows the newest again", await until("rev 7", () => meta("Rev 7 of 7"), 3000));

  // --- The revision timeline along the bar's bottom edge: one segment per revision.
  const tl = '[data-testid="spec-timeline"]';
  check("no stock range slider", !(await exists('.spec-tab input[type="range"]')));
  check("one timeline segment per revision", (await js<number>(`document.querySelectorAll('${tl} .spec-timeline-seg').length`)) === 7);
  const tones = () => js<string>(`[...document.querySelectorAll('${tl} .spec-timeline-seg')].map((e) => e.dataset.tone).join(" ")`);
  check("the newest is on show, the approved plan is marked", (await tones()) === "before before baseline before before before shown", await tones());
  /** The middle of revision `rev`'s segment, in the window. */
  const segAt = (rev: number) =>
    js<{ x: number; y: number }>(`(() => { const r = document.querySelector('${tl}').getBoundingClientRect(); const n = document.querySelectorAll('${tl} .spec-timeline-seg').length;
      return { x: r.left + ((${rev} - 0.5) / n) * r.width, y: r.top + 1 }; })()`);
  const mouse = (type: string, p: { x: number; y: number }, buttons = 0) =>
    cdp("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
  await mouse("mouseMoved", await segAt(2));
  check("hovering names the revision under the pointer, with the count", await until("tip", () => js<boolean>(`document.querySelector('.spec-timeline-tip')?.textContent.startsWith('Rev 2 of 7 · ')`), 3000));
  check("the tip names no author", await js<boolean>(`!/Agent|You|Harness/.test(document.querySelector('.spec-timeline-tip').textContent)`));
  check("hovering doesn't move the bar", await meta("Rev 7 of 7"));
  await shot("2a-timeline-hover");
  // Press on rev 6 and sweep back to rev 2: the bar and the spec follow the pointer live.
  await mouse("mouseMoved", await segAt(6));
  await mouse("mousePressed", await segAt(6), 1);
  check("pressing jumps to the revision under the pointer", await until("rev 6", () => meta("Rev 6 of 7"), 3000));
  await mouse("mouseMoved", await segAt(4), 1);
  check("dragging scrubs live", await until("rev 4", () => meta("Rev 4 of 7"), 3000));
  await mouse("mouseMoved", await segAt(3), 1);
  await until("rev 3", () => meta("Rev 3 of 7"), 3000);
  await until("rev 3 body", () => exists(".spec-doc h2"), 5000);
  await shot("2b-timeline-drag");
  await mouse("mouseMoved", await segAt(2), 1);
  await mouse("mouseReleased", await segAt(2));
  check("releasing keeps the revision", await until("rev 2", () => meta("Rev 2 of 7"), 3000));
  check("the strip marks rev 2 on show", (await tones()) === "before shown baseline after after after after", await tones());
  // Dragging past the end lands on the newest, which follows live again.
  await mouse("mousePressed", await segAt(2), 1);
  const end = await segAt(7);
  const past = { x: (await js<number>("innerWidth")) - 2, y: end.y + 60 };
  await mouse("mouseMoved", past, 1);
  await mouse("mouseReleased", past);
  check("dragging off the end follows the newest", await until("rev 7", () => meta("Rev 7 of 7"), 3000));
  await mouse("mouseMoved", { x: end.x, y: end.y + 300 });
  // The keyboard: ← → step, Home and End jump to the ends.
  await js(`document.querySelector('${tl}').focus()`);
  await press("Home", "Home", 36);
  check("Home shows the first revision", await until("rev 1", () => meta("Rev 1 of 7"), 3000));
  await press("ArrowRight", "ArrowRight", 39);
  check("→ steps forward", await until("rev 2", () => meta("Rev 2 of 7"), 3000));
  check("the slider reports the revision", (await js<string>(`document.querySelector('${tl}').getAttribute('aria-valuenow')`)) === "2");
  await press("End", "End", 35);
  check("End follows the newest", await until("rev 7", () => meta("Rev 7 of 7"), 3000));
  // Scrolling over the bar scrubs: up is older, 40px a revision, and the tip shows where it is.
  const bar = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector('.spec-history-meta').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
  const wheel = (deltaX: number, deltaY: number) => cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: bar.x, y: bar.y, deltaX, deltaY });
  await mouse("mouseMoved", bar);
  for (let i = 0; i < 6; i++) await wheel(0, -20);
  check("scrolling up over the bar steps back", await until("rev 4", () => meta("Rev 4 of 7"), 3000));
  check("the tip shows while scrolling", await js<boolean>(`document.querySelector('.spec-timeline-tip')?.textContent.startsWith('Rev 4 of 7')`));
  await shot("2c-timeline-scroll");
  await wheel(40, 0);
  check("scrolling right steps forward", await until("rev 5", () => meta("Rev 5 of 7"), 3000));
  await wheel(0, 2000);
  check("scrolling down past the end follows the newest", await until("rev 7", () => meta("Rev 7 of 7"), 3000));
  check("the tip goes once the scrolling stops", await until("tip gone", () => js<boolean>(`!document.querySelector('.spec-timeline-tip')`), 3000));

  // --- Activity tab with the blocked card.
  await go(`#/board/${project.id}/ticket/${key}/activity`);
  await until("activity list", () => exists(".activity-list"), 5000);
  check("blocked entry is an open attention card", await exists(".activity-blocked.is-open .activity-card"));
  check("review round shows its round", await js<boolean>(`[...document.querySelectorAll('.activity-review_approved')].some((e) => e.textContent.includes('round 1'))`));
  check("the submit's heading names the column it moved to", await js<boolean>(`[...document.querySelectorAll('.activity-submitted')].some((e) => e.textContent.includes('→ Review'))`));
  check("Start is a Moved entry", await js<boolean>(`[...document.querySelectorAll('.activity-moved')].some((e) => e.textContent.includes('→ In progress'))`));
  await shot("3-activity-blocked");
  // A note with more than one line: its first line, and the rest behind Show details.
  const noteRow = `[...document.querySelectorAll('.activity-note')].find((e) => e.textContent.includes('Added the board screenshot'))`;
  check("a long note shows its first line only", await js<boolean>(`(() => { const r = ${noteRow}; return !!r && !r.textContent.includes('taken from the app itself'); })()`));
  await js(`${noteRow}.querySelector('.activity-details-toggle').click()`);
  check("Show details reveals the rest", await until("details open", () => js<boolean>(`(() => { const r = ${noteRow}; return r.textContent.includes('taken from the app itself') && r.textContent.includes('Hide details'); })()`), 3000));
  await js(`${noteRow}.scrollIntoView({ block: "center" })`);
  await shot("3b-activity-show-details");

  const activity = async () => (await api<TicketDetail>("GET", `/tickets/${key}`)).activity as ActivityEntry[];
  const all = await activity();
  check("every Activity entry is one line", all.every((e) => !e.body.includes("\n")), all.filter((e) => e.body.includes("\n")).map((e) => e.kind).join(", "));
  const moves = all.filter((e) => e.meta.to).map((e) => `${e.kind}:${e.meta.from}→${e.meta.to}`);
  const expected = ["moved:planning→in_progress", "submitted:in_progress→review", "moved:review→in_progress", "submitted:in_progress→review", "moved:review→in_progress", "blocked:in_progress→blocked"];

  check("every column change is in Activity", moves.join(" ") === expected.join(" "), moves.join(" "));
  const selected = (tab: string) => js<boolean>(`document.querySelector('.tabs [data-tab=${tab}]')?.getAttribute('aria-selected') === 'true'`);

  // --- A message from the Spec tab switches to the Transcript, and stays out of Activity.
  await go(`#/board/${project.id}/ticket/${key}`);
  await until("spec tab", () => exists(".spec-doc"), 5000);
  check("the composer no longer says where the message goes", !(await js<boolean>(`/Shows in Activity|Transcript only/.test(document.querySelector('.composer')?.textContent ?? '')`)));
  const entriesBefore = (await activity()).length;
  await type(".composer-input", "Keep System as the default.");
  await cmdEnter();
  check("sending from Spec opens the Transcript", await until("transcript selected", () => selected("transcript"), 5000));
  await until("transcript shows the message", () => js<boolean>(`document.querySelector('.detail-body')?.textContent.includes('Keep System as the default.')`), 10000);
  await until("the agent answered", () => js<boolean>(`document.querySelector('.detail-body')?.textContent.includes('(dummy chat) You said')`), 15000);
  await idle(key);
  await shot("4-transcript-after-send");

  // --- And one from the Activity tab does the same.
  await go(`#/board/${project.id}/ticket/${key}/activity`);
  await until("activity list", () => exists(".activity-list"), 5000);
  await type(".composer-input", "Ask again later about Light.");
  await cmdEnter();
  check("sending from Activity opens the Transcript", await until("transcript selected", () => selected("transcript"), 5000));
  await idle(key);
  const after = await activity();
  check("neither message nor any answer went into Activity", !after.some((e) => e.kind === "message" || e.kind === "answer" || e.body.includes("Keep System") || e.body.includes("Ask again")), `${entriesBefore} → ${after.length}`);
  await go(`#/board/${project.id}/ticket/${key}/activity`);
  await until("activity list", () => exists(".activity-list"), 5000);
  await shot("5-activity-after");

  // --- Details: an edit that loses a race with another revision asks Reload / Overwrite.
  await go(`#/board/${project.id}/ticket/${key}/details`);
  await until("details", () => exists(".details textarea"), 5000);
  const before = (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
  await type(".details textarea", `${before.spec}\n\n## Open questions\nMy local edit.`);
  await api<Ticket>("PATCH", `/tickets/${key}`, { spec: before.spec.replace("## Goal", "## Goal (agreed)"), baseRevision: before.specRevision, specNote: "Retitled the goal" });
  await Bun.sleep(400);
  const saved = await js<boolean>(`(() => { const b = [...document.querySelectorAll(".details .field button")].find((e) => e.textContent.trim() === "Save"); b?.click(); return !!b; })()`);
  check("Save button shown for the unsaved spec", saved);
  await until("conflict prompt", () => exists("[data-testid=spec-conflict]"), 5000);
  check("conflict prompt offers Reload and Overwrite", await js<boolean>(`(() => { const t = document.querySelector('[data-testid=spec-conflict]').textContent; return t.includes('The spec changed while you were editing') && t.includes('Reload') && t.includes('Overwrite'); })()`));
  await js(`document.querySelector('[data-testid=spec-conflict]').scrollIntoView({ block: "center" })`);
  await shot("6-edit-conflict");
  await clickText("[data-testid=spec-conflict] button", "Overwrite");
  await until("overwrite saved", async () => (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket.spec.includes("My local edit."), 5000);
  const last = (await api<TicketDetail>("GET", `/tickets/${key}`)).ticket;
  check("Overwrite wrote a new revision on top of the other one", last.specRevision === before.specRevision! + 2 && !last.spec.includes("(agreed)"));

  // --- A ticket with dozens of revisions: the segments close up into a continuous strip, and a
  // drag still lands on one revision.
  const busy = await api<Ticket>("POST", "/tickets", { projectId: project.id, spec: "Rev 1", title: "Many revisions", driver: "dummy", start: false });
  await until("plan drafted", async () => (await api<TicketDetail>("GET", `/tickets/${busy.key}`)).ticket.specRevision === 2, 15000);
  await idle(busy.key);
  for (let rev = 2; rev < 60; rev++) {
    await api<Ticket>("PATCH", `/tickets/${busy.key}`, { spec: `## Goal\nRevision ${rev + 1}`, baseRevision: rev, specNote: `Pass ${rev + 1}` });
  }
  await go(`#/board/${project.id}/ticket/${busy.key}`);
  await until("many: rev 60", () => meta("Rev 60 of 60"), 10000);
  check("sixty segments", (await js<number>(`document.querySelectorAll('${tl} .spec-timeline-seg').length`)) === 60);
  const strip = await js<{ x: number; y: number; w: number }>(`(() => { const r = document.querySelector('${tl}').getBoundingClientRect(); return { x: r.left, y: r.top + 1, w: r.width }; })()`);
  await mouse("mouseMoved", { x: strip.x + strip.w * 0.25, y: strip.y });
  await mouse("mousePressed", { x: strip.x + strip.w * 0.25, y: strip.y }, 1);
  await mouse("mouseMoved", { x: strip.x + strip.w * 0.505, y: strip.y }, 1);
  check("a drag across sixty lands on the middle one", await until("rev 31", () => meta("Rev 31 of 60"), 3000));
  await until("rev 31 body", () => js<boolean>(`document.querySelector('.spec-doc')?.textContent.includes('Revision 31')`), 5000);
  await shot("7-timeline-many");
  await mouse("mouseReleased", { x: strip.x + strip.w * 0.505, y: strip.y });

  // --- A wide pane: Spec and Activity read as a centered column, capped wider than the
  // transcript's 860px, while the scrollbar stays at the pane's edge.
  await cdp("Emulation.setDeviceMetricsOverride", { width: 2000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await go(`#/board/${project.id}/ticket/${key}`);
  await until("spec tab", () => exists(".spec-doc"), 10000);
  await js(`document.querySelector(".pane-ticket [data-testid=pane-zoom]").click()`);
  await until("pane zoomed", () => exists(".pane-ticket.zoomed"), 5000);
  // The column's box: the scroller's content box, against the scroller itself.
  const column = (sel: string) =>
    js<{ pane: number; width: number; left: number; right: number }>(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)}), r = el.getBoundingClientRect(), s = getComputedStyle(el);
      const left = parseFloat(s.paddingLeft), right = parseFloat(s.paddingRight);
      return { pane: r.width, width: el.clientWidth - left - right, left, right: right + r.width - el.clientWidth };
    })()`);
  const spec = await column(".spec-body");
  check("a wide pane's spec is capped between the transcript's width and 1000px", spec.pane > 1400 && spec.width > 860 && spec.width <= 1000, JSON.stringify(spec));
  check("the capped spec is centered", Math.abs(spec.left - spec.right) <= 16, JSON.stringify(spec));
  await shot("8-spec-wide");
  await js(`document.querySelector('.tabs [data-tab=activity]').click()`);
  await until("activity tab", () => exists(".activity-list"), 5000);
  const feed = await column(".activity");
  check("a wide pane's activity is capped like the spec", feed.pane > 1400 && Math.abs(feed.width - spec.width) <= 16, JSON.stringify(feed));
  check("the capped activity is centered", Math.abs(feed.left - feed.right) <= 16, JSON.stringify(feed));
  await shot("9-activity-wide");
  await cdp("Emulation.clearDeviceMetricsOverride");
} catch (e) {
  console.error(e);
  c.fail();
} finally {
  await app?.close();
  daemon.kill();
  await daemon.exited;
  cleanupTempDirs();
}
console.log(c.failures ? `\n${c.failures} check(s) failed` : "\nall checks passed");
process.exit(c.failures ? 1 : 0);
