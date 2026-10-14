// The iPhone walkthrough: one install over a seeded daemon, one linear pass, a report per screen.
// Every screen is reached once, by `harness://` deep link where one exists and by a tap where none
// does (the command palette, last, so nothing has to dismiss it). Assertions read the accessibility
// tree. It exists for verification, never for spec screenshots.
//
//   bun run sim with-lock -- bun next/walkthrough/ios.ts [--no-build]
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildPairUrl } from "@harness/shared";
import { axeFor, hasAxe, screenKey, type AXElement } from "../../ios/Tools/axe";
import { installAndPair, openLink, seed, startDaemon, stopDaemon, buildApp } from "../../ios/Tools/dev-sim";
import { acquireReady, exportDeveloperDir } from "../../ios/Tools/sim";
import { walk } from "./walk";

const started = performance.now();
if (!hasAxe()) throw new Error("the walkthrough reads the UI tree with AXe: brew install cameroncooke/axe/axe");
exportDeveloperDir();
const app = process.argv.includes("--no-build") ? join(resolve(import.meta.dir, "../../ios"), "build/dd/Build/Products/Release-iphonesimulator/Harness.app") : await buildApp();
if (!existsSync(app)) throw new Error(`${app} doesn't exist; drop --no-build`);
const d = await startDaemon();
const seeded = await seed(d);
console.log(`built and seeded in ${Math.round(performance.now() - started)} ms`);
const slot = await acquireReady({ onWait: () => console.log("waiting for a shared simulator…") }, {});
const w = walk("iPhone walkthrough");
try {
  const axe = axeFor(slot.udid, process.env.DEVELOPER_DIR!);
  const t0 = performance.now();
  await installAndPair(slot.udid, axe, app, buildPairUrl(d.base, d.token));
  console.log(`installed and paired in ${Math.round(performance.now() - t0)} ms`);
  let previous = { url: "", key: screenKey(await axe.labels()) };
  const seen = (els: AXElement[]) => "on screen: " + els.map((e) => e.label ?? e.id).filter(Boolean).slice(0, 25).join(" | ");
  const has = (els: AXElement[], match: RegExp | string) => els.some((e) => (typeof match === "string" ? e.label === match : !!e.label && match.test(e.label)));
  /** The tree once `ok` holds (a screen draws after the link lands), or the last read after 8 s so the screen reports what it saw. */
  const untilTree = async (read: () => Promise<AXElement[]>, ok: (els: AXElement[]) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    let els = await read();
    while (!ok(els) && Date.now() < end) els = await read();
    return els;
  };
  /** Reaches `link`, then reads the tree once; the screen's checks all run on that one read. */
  const visit = async (link: string) => {
    previous = await openLink(slot.udid, axe, link, previous);
    return axe.nodes();
  };

  await w.screen("board", async (expect) => {
    const els = await untilTree(() => axe.nodes(), (e) => has(e, new RegExp(`^${seeded.review.key} `)));
    for (const col of ["Planning", "In progress", "Blocked", "Review", "Done"]) expect(`${col} column chip`, has(els, new RegExp(`^${col}, \\d+$`)));
    expect("review card", has(els, new RegExp(`^${seeded.review.key} `)), seen(els));
    expect("palette field", els.some((e) => e.id === "palette-field"));
  });
  await w.screen("ticket spec", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.review.key}?tab=spec`);
    expect("ticket key shown", has(els, new RegExp(`${seeded.review.key}`)));
    expect("spec tab", has(els, "Spec"));
  });
  await w.screen("ticket activity", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.review.key}?tab=activity`);
    expect("the reviewer's note", has(els, /The dummy reviewer approves/));
  });
  await w.screen("ticket details", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.notes.key}?tab=details`);
    expect("models row", has(els, /^Models, /));
    // sim-check agent-notes: the notes start collapsed and a tap on the header opens and closes them.
    const open = (e: AXElement[]) => has(e, /Where things live/) && e.some((x) => x.id === "agent-notes");
    expect("agent notes header", has(els, /^Agent notes/), seen(els));
    expect("agent notes start collapsed", !open(els));
    await axe.tap("Agent notes");
    expect("a tap opens the notes", open(await untilTree(() => axe.nodes(), open)));
    await axe.tap("Agent notes");
    expect("a second tap closes them", !open(await untilTree(() => axe.nodes(), (e) => !open(e))));
  });
  await w.screen("blocked ticket", async (expect) => {
    const els = await visit(`harness://ticket/${seeded.blocked.key}`);
    expect("the question is asked", has(els, /Which Apple Developer team/));
  });
  await w.screen("prompts", async (expect) => {
    const els = await visit("harness://prompts");
    expect("agent review prompt", has(els, "Agent review"));
  });
  await w.screen("settings", async (expect) => {
    const els = await visit("harness://settings");
    expect("appearance section with a theme choice", has(els, "Appearance") && has(els, "Light theme"), seen(els));
    // sim-check save-on-blur: scroll to the General switch (swipe from the headings; the theme strips swallow a swipe) and press it.
    const row = (e: AXElement[]) => e.filter((x) => x.label === "Save on blur").sort((a, b) => (b.frame?.x ?? 0) - (a.frame?.x ?? 0))[0];
    let sw = row(els);
    for (let i = 0; i < 40 && !(sw?.frame && sw.frame.y > 140 && sw.frame.y < 560); i++) {
      await axe.swipe(200, 520, 200, 170);
      await Bun.sleep(350);
      sw = row(await axe.nodes());
    }
    expect("a Save on blur switch", !!sw?.frame, seen(els));
    if (sw?.frame) {
      await Bun.sleep(1200); // the scroll's momentum has to be over before a press lands where the switch was
      sw = row(await axe.nodes())!;
      const before = sw.value;
      await axe.press(sw.frame!.x + sw.frame!.width - 28, sw.frame!.y + sw.frame!.height / 2);
      const after = await untilTree(() => axe.nodes(), (e) => row(e)?.value !== before);
      expect("the press flips the switch", row(after)?.value !== before, `still ${before}`);
    }
  });
  // The one tap: the board's palette field opens the palette sheet.
  await w.screen("command palette", async (expect) => {
    previous = await openLink(slot.udid, axe, "harness://board", previous);
    const listed = (e: AXElement[]) => has(e, "Go to Inbox, Go to");
    /** Taps the board's field until the palette lists its commands: a tap during the sheet's dismissal is swallowed. */
    const openPalette = async () => {
      let e: AXElement[] = [];
      for (let i = 0; i < 4 && !listed(e); i++) {
        await axe.tap("Command palette");
        e = await untilTree(() => axe.nodes(), listed, 3000);
      }
      return e;
    };
    const closed = async () => {
      await untilTree(() => axe.nodes(), (e) => !listed(e));
      await Bun.sleep(800); // the sheet's dismissal animation
    };
    let els = await openPalette();
    expect("the palette lists commands", has(els, "Go to Inbox, Go to") && has(els, "Open Settings, Go to"), seen(els));
    // sim-check palette: running Show child tickets closes the palette and flips its label.
    await axe.tap("Show child tickets, General");
    await closed();
    await openPalette();
    const flipped = await untilTree(() => axe.nodes(), (e) => has(e, /^Hide child tickets/));
    expect("Show child tickets flips to Hide child tickets", has(flipped, /^Hide child tickets/), seen(flipped));
    await axe.tap("Hide child tickets, General"); // back to the default
    await closed();
    // A leading > shows only commands: the ticket matching the query isn't listed.
    await openPalette();
    await axe.type(">hello");
    await Bun.sleep(1500); // past the search's pause
    const commands = await axe.nodes();
    expect("a > query lists no ticket", !has(commands, new RegExp(`^${seeded.review.key} `)), seen(commands));
  });
  // sim-check palette: ⌘K over a ticket lists its actions; Copy ticket key copies it.
  await w.screen("ticket commands", async (expect) => {
    previous = await openLink(slot.udid, axe, `harness://ticket/${seeded.review.key}?tab=spec`, previous);
    await axe.keyCombo(227, 14);
    const els = await untilTree(() => axe.nodes(), (e) => has(e, /^Copy ticket key/));
    expect("the ticket's commands", has(els, /^Copy ticket key/), seen(els));
    await axe.tap("Copy ticket key, Ticket");
    await Bun.sleep(500);
    const copied = Bun.spawnSync(["xcrun", "simctl", "pbpaste", slot.udid], { env: process.env }).stdout.toString().trim();
    expect("Copy ticket key copies the key", copied === seeded.review.key, `copied "${copied}"`);
  });
} finally {
  await axe_terminate();
  slot.release();
  await stopDaemon(d);
}
async function axe_terminate() {
  Bun.spawnSync(["xcrun", "simctl", "terminate", slot.udid, "com.markhuot.harness"]);
}
const { failed } = w.summary();
console.log(`total ${Math.round(performance.now() - started)} ms including build, seed, install and pairing`);
process.exit(failed.length ? 1 : 0);
