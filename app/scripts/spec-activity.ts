// The Spec and Activity tabs against the REAL service (dummy driver, throwaway HARNESS_HOME):
// a ticket whose spec has several revisions, a nested list and an inline image, and whose
// Activity has a review round and a blocked question. Checks the history bar, Show changes (the
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
1. Wire it up
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
  const { js, exists, type, cmdEnter, clickText, go } = app;
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
  check("history bar reads Rev 6 of 6", await js<boolean>(`document.querySelector('.spec-history-meta')?.textContent.startsWith('Rev 6 of 6')`));
  check("nested list renders nested", await js<boolean>(`!!document.querySelector('.spec-doc li ul li ul li, .spec-doc li ol li ol li, .spec-doc li ul li ol li')`));
  await until("inline image loaded", () => js<boolean>(`[...document.querySelectorAll('.spec-doc img')].some((i) => i.complete && i.naturalWidth > 0)`), 10000);
  await shot("1-spec");

  // --- Scrub back to rev 5 (the screenshot), Show changes.
  const meta = (rev: string) => js<boolean>(`document.querySelector('.spec-history-meta')?.textContent.startsWith(${JSON.stringify(rev)})`);
  const prev = () => js(`document.querySelector('[aria-label="Previous revision"]').click()`);
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
  await js(`[...document.querySelectorAll('.spec-history button')].find((e) => e.textContent === 'Latest')?.click()`);
  check("Latest follows again", await until("rev 7", () => meta("Rev 7 of 7"), 3000));

  // --- Activity tab with the blocked card.
  await go(`#/board/${project.id}/ticket/${key}/activity`);
  await until("activity list", () => exists(".activity-list"), 5000);
  check("blocked entry is an open attention card", await exists(".activity-blocked.is-open .activity-card"));
  check("review round shows its round", await js<boolean>(`[...document.querySelectorAll('.activity-review_approved')].some((e) => e.textContent.includes('round 1'))`));
  check("the submit's heading names the column it moved to", await js<boolean>(`[...document.querySelectorAll('.activity-submitted')].some((e) => e.textContent.includes('→ Review'))`));
  check("Start is a Moved entry", await js<boolean>(`[...document.querySelectorAll('.activity-moved')].some((e) => e.textContent.includes('→ In progress'))`));
  await shot("3-activity-blocked");

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
