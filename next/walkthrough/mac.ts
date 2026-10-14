// The Mac walkthrough: one Electron launch over the seeded world, one linear pass, a report per
// screen. Each screen is reached once, by route where one exists and by key press where none does
// (the command palette). Assertions read the DOM. It exists for verification, never for spec
// screenshots. Build first: `bun run --cwd app build`.
//
//   bun run --cwd app build && bun next/walkthrough/mac.ts
import { launchApp, until } from "../../app/scripts/lib/drive";
import { bootWorld } from "../../app/scripts/lib/world";
import { walk } from "./walk";

const started = performance.now();
const world = await bootWorld({ delayMs: 20 });
const app = await launchApp({ baseUrl: world.base, token: world.token, theme: "light" });
console.log(`launched in ${Math.round(performance.now() - started)} ms`);
const w = walk("Mac walkthrough");
const text = (sel: string) => app.js<string[]>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map(e => e.textContent.trim())`);
const waitFor = (sel: string) => until(sel, () => app.exists(sel), 8000);

try {
  await w.screen("board", async (expect) => {
    await app.go("#/board/all");
    await waitFor(".card[data-key]");
    expect("five columns in order", (await text(".column-title")).map((t) => t.replace(/\d+$/, "").trim()).join(",") === "Planning,In progress,Blocked,Review,Done");
    expect("a seeded card is shown", await app.exists(".card[data-key='NYTIMES-4']"));
    expect("search box present", await app.exists("[data-testid=board-search]"));
    expect("socket connected", await app.exists(".conn.on"));
  });

  await w.screen("ticket spec", async (expect) => {
    await app.go("#/board/all/ticket/NYTIMES-4");
    await waitFor(".spec-doc");
    expect("spec tab selected", await app.js<boolean>(`document.querySelector(".tabs [data-tab=spec]")?.getAttribute("aria-selected") === "true"`));
    expect("spec timeline", await app.exists("[data-testid=spec-timeline]"));
  });

  await w.screen("ticket activity", async (expect) => {
    await app.go("#/board/all/ticket/NYTIMES-1/activity");
    const selected = await until("activity tab", () => app.js<boolean>(`document.querySelector(".tabs [data-tab=activity]")?.getAttribute("aria-selected") === "true"`), 8000).catch(() => false);
    expect("activity tab selected", selected === true);
  });

  await w.screen("ticket details", async (expect) => {
    await app.go("#/board/all/ticket/HARNESS-1/details");
    await waitFor(".props");
    expect("pull requests section", await app.exists("[data-testid=pull-requests]"));
  });

  await w.screen("settings", async (expect) => {
    await app.go("#/settings");
    await waitFor(".settings-nav");
    expect("a driver row is listed", await app.exists("[data-driver-row='claude-code']"));
  });

  await w.screen("compose", async (expect) => {
    await app.go("#/compose");
    await waitFor(".draft-pane .draft-prompt");
    expect("project picker", await app.exists(".project-picker select"));
  });

  // The one key press: ⌘K opens the palette, typing a key completes it to the ticket.
  await w.screen("command palette", async (expect) => {
    await app.go("#/board/all");
    await waitFor(".card[data-key]");
    await app.key("k", "KeyK", 75, 4);
    await waitFor("[data-testid=palette-input]");
    expect("input focused", await app.js<boolean>(`document.activeElement?.matches("[data-testid=palette-input]")`));
    await app.type("[data-testid=palette-input]", "harness-1");
    const top = await until("ticket row", () => app.js<string | null>(`document.querySelector("[data-testid=palette-row][aria-selected=true]")?.dataset.id ?? null`).then((id) => id?.startsWith("ticket:") && id), 8000).catch(() => null);
    expect("typing a key autocompletes the ticket", top === "ticket:HARNESS-1", String(top));
    await app.key("Escape", "Escape", 27);
  });

  await w.screen("inbox", async (expect) => {
    await app.go("#/inbox");
    expect("route held", await app.js<boolean>(`location.hash.startsWith("#/inbox")`));
  });
} finally {
  await app.close();
  await world.stop();
}
const { failed } = w.summary();
console.log(`total ${Math.round(performance.now() - started)} ms including world boot and launch`);
process.exit(failed.length ? 1 : 0);
