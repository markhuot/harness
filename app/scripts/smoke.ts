// End-to-end UI smoke test: boots the mock service and the built app, then drives the real
// renderer over the Chrome DevTools Protocol and checks the effects on the service's state.
//
//   bun run build && bun scripts/smoke.ts
import { join } from "node:path";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";
import { encodeQr, qrPath } from "../src/renderer/components/qr";

const port = 7600 + Math.floor(Math.random() * 90);
const token = "smoke-token";
const base = `http://127.0.0.1:${port}`;
const inputs: string[] = [];

const mock = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
  env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token, MOCK_QUIET: "1" },
  stdout: "pipe",
  stderr: "inherit",
});
void (async () => {
  const dec = new TextDecoder();
  const reader = mock.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    inputs.push(...dec.decode(value).split("\n").filter((l) => l.includes("browser.input")));
  }
})();

const api = makeApi(base, token);
/** True once the canvas has non-transparent pixels (a frame was decoded and drawn). */
const canvasPainted = `(() => { const c = document.querySelector(".browser-canvas"); if (!c || !c.width) return false;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 3; i < d.length; i += 4 * 101) if (d[i] > 0) n++; return n > 50; })()`;
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(base + "/health")).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const counter = checker();
const { check, fail } = counter;
let app: Awaited<ReturnType<typeof launchApp>> | null = null;
let mock2: ReturnType<typeof Bun.spawn> | null = null;

try {
  // Native context menus can't be clicked over CDP; this makes them pick "Project settings…".
  app = await launchApp({ baseUrl: base, token, env: { HARNESS_MENU_AUTOPICK: "settings,split-below" } });
  const { cdp, js, exists, type, cmdEnter, clickText } = app;

  // 1. Board renders every column and the seeded cards.
  await until("board", () => exists(".card"), 10000);
  const cols = await js<string[]>(`[...document.querySelectorAll(".column-title")].map(e => e.textContent)`);
  check("board shows five columns", cols.join(",") === "Planning,In progress,Blocked,Review,Done", cols.join(","));

  // 1a. Child tickets are hidden by default (ones that need you stay); a plain switch shows them.
  // No "N hidden" count anywhere.
  const cardKeys = () => js<string[]>(`[...document.querySelectorAll(".card[data-key]")].map(c => c.dataset.key)`);
  const hiddenCountText = () => js<boolean>(`/\\d+\\s*hidden/i.test(document.body.innerText)`);
  // The switch lives in the search box's options dropdown: open it (if it isn't) before reading it.
  const openOptions = async () => {
    if (!(await exists("[data-testid=show-children]"))) await js(`document.querySelector("[data-testid=search-options]").click()`);
    await until("search options menu", () => exists("[data-testid=show-children]"));
  };
  const toggleState = async () => {
    await openOptions();
    return js<{ checked: string | null; text: string }>(`(() => { const b = document.querySelector("[data-testid=show-children]"); return { checked: b?.getAttribute("aria-checked") ?? null, text: b?.textContent ?? "" }; })()`);
  };
  const toggleChildren = async () => {
    await openOptions();
    await js(`document.querySelector("[data-testid=show-children]").click()`);
  };
  {
    const first = await until("board cards", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-1") && k;
    });
    check(
      "child tickets are hidden by default; children that need you and the conductor stay",
      ["HARNESS-2", "HARNESS-3", "HARNESS-6", "HARNESS-10"].every((k) => !first.includes(k)) && ["HARNESS-1", "HARNESS-7", "HARNESS-8"].every((k) => first.includes(k)),
      first.join(","),
    );
    const header = await js<{ title: string; newSession: boolean; switchOutside: boolean }>(`(() => {
      const h = document.querySelector(".board-pane > .view-header");
      return { title: h.querySelector(".view-title").textContent, newSession: [...h.querySelectorAll("button")].some(b => /new session/i.test(b.textContent + (b.getAttribute("aria-label") ?? ""))), switchOutside: !!h.querySelector("[data-testid=show-children]") };
    })()`);
    check("the board header shows no card count", !/\d/.test(header.title), header.title);
    check("the board header has no New session button (the sidebar has it)", !header.newSession);
    check("Show child tickets is tucked in the search options, not the header", !header.switchOutside);
    const off = await toggleState();
    check("the options button sits inside the search box", await exists(".search [data-testid=search-options][aria-expanded=true]"));
    check("the toolbar switch reads Show child tickets, off", off.checked === "false" && off.text === "Show child tickets", JSON.stringify(off));
    check("no hidden-count text while children are hidden", !(await hiddenCountText()));
    await toggleChildren();
    const shownKeys = await until("children shown", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-2") && k;
    });
    check("the switch shows child tickets", ["HARNESS-2", "HARNESS-3", "HARNESS-6", "HARNESS-10"].every((k) => shownKeys.includes(k)), shownKeys.join(","));
    const on = await toggleState();
    check("…and reads on, still with no count", on.checked === "true" && on.text === "Show child tickets" && !(await hiddenCountText()), JSON.stringify(on));
    check("the menu stays open after toggling", await exists("[data-testid=show-children]"));
    check("the options button marks a non-default filter", await exists("[data-testid=search-options].active"));
    await js(`document.querySelector("[data-testid=search-options]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    check("Escape closes the options menu", !!(await until("menu closed", async () => !(await exists("[data-testid=show-children]")))));
  }

  // 1a'. Done pages from the service: first 50, the server total in the header, Load more, live
  // completions, auto-load on scroll; search reaches tickets that aren't loaded (and old keys).
  {
    const doneKeys = () =>
      js<string[]>(`[...[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Done").querySelectorAll(".card[data-key]")].map(c => c.dataset.key)`);
    const doneCountText = () => js<string>(`document.querySelector("[data-testid=count-done]")?.textContent ?? ""`);
    const serverTotal = (await api<{ total: number }>("GET", "/tickets/page?status=done&limit=1")).total;
    const firstPage = await until("first done page", async () => {
      const k = await doneKeys();
      return k.length >= 50 && k;
    });
    check("Done shows the first page (50, newest completed first)", firstPage.length === 50 && firstPage[0] === "SITE-130" && firstPage[49] === "SITE-81", `${firstPage.length}: ${firstPage[0]}…${firstPage.at(-1)}`);
    check("Done's header counts the server total, not the loaded cards", serverTotal >= 120 && (await doneCountText()) === String(serverTotal), `${await doneCountText()} vs ${serverTotal}`);
    check("older done tickets aren't loaded", !(await exists('.card[data-key="SITE-42"]')) && !(await exists('.card[data-key="HARNESS-5"]')));

    // The conductor's Tickets tab lists its done child even though the board hasn't paged it in.
    await js(`location.hash = "#/board/all/ticket/HARNESS-1/children"`);
    const kids = await until("conductor children", async () => {
      const k = await js<string[]>(`[...document.querySelectorAll(".child-row")].map(r => r.dataset.key)`);
      return k.includes("HARNESS-5") && k;
    }).catch(() => [] as string[]);
    check("conductor Tickets tab lists done children that aren't on the board", kids.includes("HARNESS-5") && !(await doneKeys()).includes("HARNESS-5"), kids.join(","));
    await js(`location.hash = "#/board/all"`);
    await until("board again", () => exists(".column .card"));

    // Search: server-side, finds a done ticket that isn't loaded, and one by its pre-rename key.
    const searchStatus = () => js<string>(`document.querySelector("[data-testid=search-status]")?.textContent ?? ""`);
    await type("[data-testid=board-search]", "carousel");
    const found = await until("search result", async () => (await doneKeys()).includes("SITE-42") && (await doneKeys()));
    check("search finds a done ticket that wasn't loaded", found.join(",") === "SITE-42" && (await cardKeys()).join(",") === "SITE-42", (await cardKeys()).join(","));
    check("search says how many matched", (await searchStatus()).includes("1 match"), await searchStatus());
    await type("[data-testid=board-search]", "WWW-7");
    const alias = await until("alias search", async () => {
      const k = await cardKeys();
      return k.includes("SITE-7") && k;
    });
    check("search finds a ticket by its old (pre-rename) key", alias.includes("SITE-7") && !alias.includes("SITE-42"), alias.join(","));
    await type("[data-testid=board-search]", "zzzz-no-such-thing");
    const none = await until("no matches", async () => (await searchStatus()).includes("No matches") && (await searchStatus()));
    check("a search with no hits says so", none.includes("No matches") && (await cardKeys()).length === 0, none);
    await js(`document.querySelector(".search-clear").click()`);
    const restored = await until("board restored", async () => {
      const k = await doneKeys();
      return !(await exists("[data-testid=search-status]")) && k.length === 50 && k;
    });
    check(
      "clearing the search restores the board (search hits older than the page stay out of Done)",
      restored[0] === "SITE-130" && !restored.includes("SITE-42") && !restored.includes("SITE-7") && (await cardKeys()).includes("HARNESS-2") && (await doneCountText()) === String(serverTotal),
      restored.slice(0, 3).join(","),
    );

    // Load more appends the next page without duplicates.
    await js(`document.querySelector("[data-testid=done-load-more] button").click()`);
    const two = await until("second page", async () => {
      const k = await doneKeys();
      return k.length >= 100 && k;
    });
    check("Load more appends the next page in order, no duplicates", two.length === 100 && new Set(two).size === 100 && two[50] === "SITE-80" && two.slice(0, 50).join() === firstPage.join(), `${two.length} ${two[50]}`);

    // A live completion goes to the top and counts.
    const nyId = (await api<{ id: string; key: string }[]>("GET", "/projects")).find((p) => p.key === "NYTIMES")!.id;
    const liveT = await api<{ key: string }>("POST", "/tickets", { projectId: nyId, prompt: "Ship the live completion check", start: false });
    await api("PATCH", `/tickets/${liveT.key}`, { status: "done" });
    const top = await until("live completion prepends", async () => {
      const k = await doneKeys();
      return k[0] === liveT.key && k;
    });
    check("a live completion prepends to Done and bumps the total", top.length === 101 && (await doneCountText()) === String(serverTotal + 1), `${top.length} / ${await doneCountText()}`);

    // Scrolling to the end auto-loads the rest (IntersectionObserver), still without duplicates.
    const scrollDone = () =>
      js(`(() => { const b = [...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Done").querySelector(".column-body"); b.scrollTop = b.scrollHeight; })()`);
    const all = await until("auto-load to the end", async () => {
      await scrollDone();
      const k = await doneKeys();
      return k.length >= serverTotal + 1 && !(await exists("[data-testid=done-load-more]")) && k;
    }, 12000);
    check("scrolling to the end auto-loads every page, no duplicates", all.length === serverTotal + 1 && new Set(all).size === all.length && all.includes("HARNESS-5"), `${all.length}/${serverTotal + 1}`);
    await js(`[...document.querySelectorAll(".column-body")].forEach(b => b.scrollTop = 0)`);
  }

  type T = { key: string; status: string; position: number; allowedTools: string[]; pendingApproval: unknown };

  // 1c. Tool approval: badge on the board, card in the detail, "Always allow" answers it.
  const badge = await js<string>(`[...document.querySelectorAll(".card")].find(c => c.dataset.key === "HARNESS-9")?.querySelector(".card-approval")?.textContent ?? ""`);
  check("board card shows the approval badge", badge.includes("Needs approval") && badge.includes("Bash"), badge);
  await js(`location.hash = "#/board/all/ticket/HARNESS-9"`);
  await until("approval card", () => exists(".approval"));
  const cmd = await js<string>(`document.querySelector(".approval-input pre")?.textContent ?? ""`);
  check("approval card renders the Bash command", cmd.startsWith("bun add -d @playwright/test"), cmd);
  const why = await js<string>(`document.querySelector(".approval [data-testid=approval-reason]")?.textContent ?? ""`);
  check("approval card shows the classifier's reason", why.startsWith("Auto-mode classifier:") && why.includes("@playwright/test"), why);
  await clickText(".approval-actions button", "Always allow Bash");
  const answered = await until("approval answered", async () => {
    const t = (await api<{ ticket: T }>("GET", "/tickets/HARNESS-9")).ticket;
    return !t.pendingApproval && t.status === "in_progress" && t;
  });
  check("Always allow adds the tool and resumes work", answered.allowedTools.includes("Bash"), answered.allowedTools.join(","));
  await until("approval card gone", async () => !(await exists(".approval")));
  await js(`location.hash = "#/board/all/ticket/HARNESS-9/details"`);
  const chips = await until("allowed tool chips", async () => {
    const c = await js<string[]>(`[...document.querySelectorAll(".props .chip")].map(e => e.textContent)`);
    return c.includes("Bash") && c;
  });
  check("Details lists allowed tools", chips.join(",") === "Read,Edit,Bash", chips.join(","));
  // 1d. Permission decisions render as audit rows in the transcript.
  await js(`location.hash = "#/board/all/ticket/HARNESS-9/transcript"`);
  const audit = await until("permission audit row", () => js<string>(`document.querySelector("[data-testid=permission-row]")?.textContent ?? ""`).then((t) => t && t));
  check("transcript shows permission decisions as a shield row", audit.startsWith("Allowed") && audit.includes("read-only command") && audit.includes("policy"), audit);
  await js(`location.hash = "#/board/all"`);

  // On the all-projects board a card reads "[NYT] NYTIMES-2": the project key leads the top row,
  // and the foot no longer repeats it.
  const cardTop = await until("all-projects card", () =>
    js<{ first: string; firstText: string; next: string; footKeys: number } | null>(`(() => { const card = document.querySelector('.card[data-key="NYTIMES-2"]'); if (!card) return null;
      const top = card.querySelector(".card-top");
      return { first: top.children[0]?.className ?? "", firstText: top.children[0]?.textContent ?? "", next: top.children[1]?.className ?? "", footKeys: card.querySelectorAll(".card-foot .project-key").length }; })()`),
  );
  check(
    "all-projects card top reads [project key] ticket key",
    cardTop.first.startsWith("project-key") && cardTop.firstText === "NYT" && cardTop.next === "card-key" && cardTop.footKeys === 0,
    JSON.stringify(cardTop),
  );

  // 2. Cards drag onto panes (6e), not between columns (agents move them): a drop on a column is a no-op.
  // Then move NYTIMES-2 (planning) to In progress through the API and watch the board follow.
  const dragged = await js<{ draggable: number; accepted: boolean }>(`(() => {
    const card = [...document.querySelectorAll(".card")].find(c => c.querySelector(".card-key")?.textContent === "NYTIMES-2");
    const col = [...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "In progress");
    const dt = new DataTransfer();
    dt.setData("application/x-harness-ticket", "NYTIMES-2");
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    // A drop target cancels dragover; nothing on the board should.
    const accepted = !col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return { draggable: document.querySelectorAll(".card[draggable=true]").length, accepted };
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  const stayed = (await api<{ ticket: { status: string } }>("GET", "/tickets/NYTIMES-2")).ticket.status === "planning";
  check("board cards are draggable, but a drop on a column does nothing", dragged.draggable > 0 && !dragged.accepted && stayed, JSON.stringify({ ...dragged, stayed }));
  await js(`[...document.querySelectorAll(".card")].find(c => c.dataset.key === "NYTIMES-2").click()`);
  const cardOpened = await until("card click opens the ticket", () => js<string>("location.hash").then((h) => h.startsWith("#/board/all/ticket/NYTIMES-2") && h));
  check("clicking a board card opens it", !!cardOpened, cardOpened);
  await js(`location.hash = "#/board/all"`);
  await api("PATCH", "/tickets/NYTIMES-2", { status: "in_progress" });
  const inColumn = await until("card re-rendered in column", () =>
    js<boolean>(`[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "In progress")?.textContent.includes("NYTIMES-2")`),
  );
  check("card moves columns live", inColumn);

  // 3. Open a blocked ticket and answer the agent.
  await js(`location.hash = "#/board/all/ticket/NYTIMES-3"`);
  await until("detail", () => exists(".composer-input"));
  const placeholder = await js<string>(`document.querySelector(".composer-input").placeholder`);
  check("blocked composer placeholder", placeholder === "Answer the agent…", placeholder);
  await type(".composer-input", "Use the staging client id.");
  await cmdEnter();
  const unblocked = await until("message resumes work", async () => (await api<{ ticket: { status: string } }>("GET", "/tickets/NYTIMES-3")).ticket.status === "in_progress");
  check("message to a blocked ticket moves it to in progress", unblocked);
  const sessionId = (await api<{ session: { id: string } }>("GET", "/tickets/NYTIMES-3")).session.id;
  const transcript = await api<{ role: string; content: { type: string; text?: string } }[]>("GET", `/sessions/${sessionId}/transcript?after=0`);
  check("message lands in the transcript", transcript.some((e) => e.role === "user" && e.content.text === "Use the staging client id."));

  // 4. Human approval from the review column.
  await js(`location.hash = "#/board/all/ticket/NYTIMES-4"`);
  await until("approve button", () => js<boolean>(`[...document.querySelectorAll(".actions button")].some(b => b.textContent.includes("Approve"))`));
  await clickText(".actions button", "Approve");
  const approved = await until("human approved", async () => (await api<{ ticket: { humanReview: string } }>("GET", "/tickets/NYTIMES-4")).ticket.humanReview === "approved");
  check("Approve sets humanReview", approved);
  const autoDone = await until("auto-completed", async () => (await api<{ ticket: { status: string } }>("GET", "/tickets/NYTIMES-4")).ticket.status === "done", 10000);
  check("approving a ready ticket runs the completion step and moves it to done", autoDone);

  // 4b. With Complete when approved off, approval leaves the ticket ready and Complete runs it.
  const nyProject = (await api<{ id: string; key: string }[]>("GET", "/projects")).find((p) => p.key === "NYTIMES")!;
  await api("PATCH", `/projects/${nyProject.id}`, { autoComplete: false });
  const manual = await api<{ key: string }>("POST", "/tickets", { projectId: nyProject.id, prompt: "Manual completion" });
  await until("manual ticket agent-approved", async () => {
    const t = (await api<{ ticket: { status: string; agentReview: string; busy: boolean } }>("GET", `/tickets/${manual.key}`)).ticket;
    return t.status === "review" && t.agentReview === "approved" && !t.busy;
  }, 15000);
  await js(`location.hash = "#/board/all/ticket/${manual.key}"`);
  await until("approve button", () => js<boolean>(`[...document.querySelectorAll(".actions button")].some(b => b.textContent.includes("Approve"))`));
  await clickText(".actions button", "Approve");
  const completeEnabled = await until("Complete enabled", () =>
    js<boolean>(`[...document.querySelectorAll(".actions button")].some(b => b.textContent.includes("Complete") && !b.disabled)`),
  );
  check("with auto-complete off, Complete enables once both reviews approve", completeEnabled);
  check("with auto-complete off, the ticket waits in review", (await api<{ ticket: { status: string } }>("GET", `/tickets/${manual.key}`)).ticket.status === "review");
  // The two approved review marks say it's ready; the card has no separate Ready badge.
  const readyCard = await until("ready card marks", () =>
    js<{ marks: number; ready: boolean } | null>(`(() => { const card = document.querySelector('.card[data-key="${manual.key}"]'); if (!card) return null;
      const marks = card.querySelectorAll(".card-reviews .badge-green").length; return marks === 2 ? { marks, ready: card.querySelectorAll(".badge-green").length > marks } : null; })()`),
  );
  check("a ready card shows both approved marks and no Ready badge", readyCard.marks === 2 && !readyCard.ready, JSON.stringify(readyCard));
  await clickText(".actions button", "Complete");
  await until("complete modal", () => exists(".modal"));
  await clickText(".modal-foot button", "Complete");
  const manualDone = await until("manual done", async () => (await api<{ ticket: { status: string } }>("GET", `/tickets/${manual.key}`)).ticket.status === "done", 10000);
  check("Complete runs the completion step and moves it to done", manualDone);
  await api("PATCH", `/projects/${nyProject.id}`, { autoComplete: true });

  // 5. New session composer (⌘N path goes through the menu; use the #/compose route).
  await js(`location.hash = "#/board/all"`);
  await Bun.sleep(100);
  await js(`location.hash = "#/compose"`);
  await until("composer", () => exists(".new-session-prompt"));
  const projectOpts = await js<string[]>(`[...document.querySelectorAll(".project-picker select option")].map(o => o.textContent)`);
  check("composer's project dropdown ends with Add project…", projectOpts.length > 1 && projectOpts.at(-1) === "Add project…", projectOpts.join(","));
  const headText = await js<string>(`document.querySelector(".new-session-head")?.textContent ?? ""`);
  check("composer header has no separate Add project button or New session label", !(await exists(".new-session-head button")) && !headText.includes("New session"), headText);
  // 5a. Model dropdown: lists the selected driver's models (default first), refetches on driver change.
  const pick = (sel: string, value: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const modelOpts = (scope: string) => js<string[]>(`[...document.querySelectorAll("${scope} .model-select option")].map(o => o.textContent)`);
  const ccOpts = await until("composer model options", async () => {
    const o = await modelOpts(".modal-foot");
    return o.includes("Sonnet 5") && o;
  });
  check("composer model dropdown lists the driver's models, default first and marked", ccOpts[0] === "Default (Opus 5.5)" && ccOpts.includes("Opus 5.5 · default"), ccOpts.join(","));
  await pick(".modal-foot select.select:not([aria-label=Model])", "dummy");
  const dummyOpts = await until("dummy model options", async () => {
    const o = await modelOpts(".modal-foot");
    return o.includes("Dummy Slow") && o;
  });
  check("switching driver refetches the model list", !dummyOpts.includes("Sonnet 5") && dummyOpts[0] === "Default (Dummy Fast)", dummyOpts.join(","));
  await pick(".modal-foot select[aria-label=Model]", "dummy-slow");
  const modeOpts = await js<string[]>(`[...document.querySelectorAll(".modal-foot [data-testid=permission-mode] option")].map(o => o.textContent)`);
  check("composer offers the permission modes, inheriting by default", modeOpts.join(",") === "Default · Auto,Auto,Ask,Read only", modeOpts.join(","));
  await pick(".modal-foot [data-testid=permission-mode]", "read_only");
  await type(".new-session-prompt", "Add a print stylesheet for recipe cards");
  await cmdEnter();
  const created = await until("ticket created", async () =>
    (await api<{ key: string; title: string; status: string }[]>("GET", "/tickets")).find((t) => t.title.includes("print stylesheet")),
  );
  check("composer creates and starts a ticket", created.status === "in_progress", created.key);
  const opened = await until("detail opened", () => js<string>(`location.hash`).then((h) => h.includes(created.key) && h));
  check("composer opens the new ticket", !!opened, opened);
  const withModel = (await api<{ ticket: { driver: string; model: string | null } }>("GET", `/tickets/${created.key}`)).ticket;
  check("composer sends the chosen driver + model", withModel.driver === "dummy" && withModel.model === "dummy-slow", `${withModel.driver} / ${withModel.model}`);
  const withMode = (await api<{ ticket: { permissionMode: string | null } }>("GET", `/tickets/${created.key}`)).ticket;
  check("composer sends the chosen permission mode", withMode.permissionMode === "read_only", String(withMode.permissionMode));
  const headBadge = await until("header model badge", () => js<string>(`document.querySelector(".detail-titlebar .model-badge")?.textContent ?? ""`).then((t) => t && t));
  check("ticket header shows the model badge", headBadge === "Dummy Slow", headBadge);
  await js(`location.hash = "#/board/all/ticket/${created.key}/details"`);
  await until("details model select", () => exists(".props .model-select select"));
  await pick(".props .model-select select", "");
  const cleared = await until("model cleared", async () => (await api<{ ticket: { model: string | null } }>("GET", `/tickets/${created.key}`)).ticket.model === null);
  check("Details model select PATCHes the ticket (Default → null)", cleared);
  await pick(".props [data-testid=permission-mode]", "");
  const modeCleared = await until("mode cleared", async () => (await api<{ ticket: { permissionMode: string | null } }>("GET", `/tickets/${created.key}`)).ticket.permissionMode === null);
  check("Details permission select PATCHes the ticket (Default → null)", modeCleared);
  check("header badge disappears for default model", !!(await until("badge gone", async () => !(await exists(".detail-titlebar .model-badge")))));
  const cardBadge = await js<string>(`document.querySelector('.card[data-key="NYTIMES-1"] .model-badge')?.textContent ?? ""`);
  check("board card shows a non-default model", cardBadge === "Sonnet 5", cardBadge);
  await js(`location.hash = "#/settings/models"`);
  await until("model settings", () => exists("[data-testid=model-settings-claude-code] select"));
  await pick("[data-testid=model-settings-claude-code] select", "haiku");
  const savedDefault = await until("settings default model", async () => (await api<{ defaultModels: Record<string, string> }>("GET", "/settings")).defaultModels["claude-code"] === "haiku");
  check("Settings → Models saves a per-driver default", savedDefault);
  await pick("[data-testid=model-settings-claude-code] select", "");
  await until("settings default cleared", async () => !(await api<{ defaultModels: Record<string, string> }>("GET", "/settings")).defaultModels["claude-code"]);
  await js(`location.hash = "#/settings/permissions"`);
  await until("permission settings", () => exists("#settings-permissions [data-testid=permission-mode]"));
  await pick("#settings-permissions [data-testid=permission-mode]", "ask");
  await pick("#settings-permissions [data-testid=classifier-backend]", "anthropic-api");
  const savedPerm = await until("permission settings saved", async () => {
    const s = await api<{ permissionMode: string; classifier: string }>("GET", "/settings");
    return s.permissionMode === "ask" && s.classifier === "anthropic-api" && s;
  });
  check("Settings → Permissions saves the mode and classifier", !!savedPerm);
  await pick("#settings-permissions [data-testid=permission-mode]", "auto");
  await pick("#settings-permissions [data-testid=classifier-backend]", "claude-cli");

  // 6. Browser tab forwards input to the service.
  await js(`location.hash = "#/board/all/ticket/NYTIMES-1/browser"`);
  const painted = await until("frame drawn", () => js<boolean>(canvasPainted), 8000).catch(() => false);
  check("browser frame is decoded and drawn", painted);
  await Bun.sleep(800);
  const rect = await js<{ x: number; y: number; w: number; h: number }>(`(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
  await until("inputs forwarded", async () => inputs.some((l) => l.includes('"action":"down"') && l.includes('"type":"mouse"')) && inputs.some((l) => l.includes('"type":"key"')));
  const down = inputs.find((l) => l.includes('"type":"mouse"') && l.includes('"action":"down"'))!;
  const parsed = JSON.parse(down.slice(down.indexOf("{")));
  check("browser mouse input forwarded", parsed.button === "left" && parsed.clickCount === 1, down.trim());
  check("browser key input forwarded", inputs.some((l) => l.includes('"key":"a"')));
  check("browser resize sent", inputs.some((l) => l.includes('"type":"resize"')));

  // 6b. Project settings: right-click → settings, rename the identifier, live preview + validation.
  type P = { id: string; key: string; name: string };
  const hh = (await api<P[]>("GET", "/projects")).find((p) => p.key === "HELLOHARNESS")!;
  await js(`location.hash = "#/board/all"`);
  await until("sidebar project row", () => exists(`.nav-row[data-project-id="${hh.id}"]`));
  await js(`document.querySelector('.nav-row[data-project-id="${hh.id}"] .nav-item').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 200 }))`);
  const onSettings = await until("project settings route", () => js<string>(`location.hash`).then((h) => h === `#/project/${hh.id}/settings` && h));
  check("right-click → Project settings… opens the project settings route", !!onSettings, onSettings);
  await until("key input", () => exists(".key-input"));
  const hint = () => js<string>(`document.querySelector("[data-testid=key-preview]").textContent`);
  check("identifier shows current numbering", (await hint()) === "New tickets are numbered HELLOHARNESS-4, HELLOHARNESS-5…", await hint());
  await type(".key-input", "1x");
  const invalid = await until("invalid preview", async () => (await js<boolean>(`document.querySelector("[data-testid=key-preview]").classList.contains("error")`)) && (await hint()));
  const renameDisabled = await js<boolean>(`[...document.querySelectorAll(".key-control button")].find(b => b.textContent.includes("Rename"))?.disabled ?? false`);
  check("invalid identifier is flagged and can't be saved", invalid === "Must start with a letter" && renameDisabled, invalid);
  await type(".key-input", "other");
  await type(".key-input", "nytimes");
  check("identifier used by another project is flagged", (await until("dup preview", async () => (await hint()).startsWith("Already used by") && (await hint()))) === "Already used by nytimes");
  await type(".key-input", "hel");
  const preview = await until("rename preview", async () => (await hint()).startsWith("Tickets will be numbered") && (await hint()));
  check(
    "rename preview explains the renumbering",
    preview === "Tickets will be numbered HEL-4, HEL-5…; existing HELLOHARNESS-1…3 become HEL-1…3. ACME-12 keeps its key",
    preview,
  );
  await clickText(".key-control button", "Rename");
  const renamed = await until("rename saved", async () => {
    const all = await api<{ key: string; projectId: string }[]>("GET", "/tickets");
    const keys = all.filter((t) => t.projectId === hh.id).map((t) => t.key).sort();
    return keys.join(",") === "ACME-12,HEL-1,HEL-2,HEL-3" && keys;
  });
  check("rename renumbers native tickets and keeps the mirrored one", !!renamed, renamed.join(","));
  const sidebarKey = await until("sidebar key updated", () =>
    js<string>(`document.querySelector('.nav-row[data-project-id="${hh.id}"] .project-key')?.textContent ?? ""`).then((k) => k === "HEL" && k),
  );
  check("sidebar picks up the new key live", sidebarKey === "HEL");
  check("hint returns to numbering after save", (await until("hint reset", async () => (await hint()).startsWith("New tickets") && (await hint()))) === "New tickets are numbered HEL-4, HEL-5…");
  const projModeOpts = await js<string[]>(`[...document.querySelectorAll("#settings-project-agents [data-testid=permission-mode] option")].map(o => o.textContent)`);
  check("project settings offer a permission mode that defaults to the global one", projModeOpts[0] === "Default (Auto)", projModeOpts.join(","));
  await pick("#settings-project-agents [data-testid=permission-mode]", "read_only");
  const projMode = await until("project mode saved", async () => (await api<{ id: string; permissionMode: string | null }[]>("GET", "/projects")).find((p) => p.id === hh.id)?.permissionMode === "read_only");
  check("project permission mode PATCHes the project", projMode);
  await pick("#settings-project-agents [data-testid=permission-mode]", "");
  await until("project mode cleared", async () => (await api<{ id: string; permissionMode: string | null }[]>("GET", "/projects")).find((p) => p.id === hh.id)?.permissionMode === null);
  const unnamed = await js<number>(`[...document.querySelectorAll("input[type=checkbox]")].filter(i => i.getAttribute("role") !== "switch" || !(i.getAttribute("aria-label") || i.closest("label")?.textContent.trim())).length`);
  check("every project settings switch is a named role=switch", unnamed === 0, `${unnamed} unnamed`);
  const autoCompleteSwitch = `document.querySelector('#settings-project-agents input[role=switch][aria-label="Complete when approved"]')`;
  check("project settings show Complete when approved, on by default", await js<boolean>(`${autoCompleteSwitch}?.checked === true`));
  await js(`${autoCompleteSwitch}.click()`);
  const autoOff = await until("autoComplete saved", async () => (await api<{ id: string; autoComplete: boolean }[]>("GET", "/projects")).find((p) => p.id === hh.id)?.autoComplete === false);
  check("toggling Complete when approved PATCHes the project", autoOff && (await js<boolean>(`${autoCompleteSwitch}?.checked === false`)));
  await js(`${autoCompleteSwitch}.click()`);
  await until("autoComplete restored", async () => (await api<{ id: string; autoComplete: boolean }[]>("GET", "/projects")).find((p) => p.id === hh.id)?.autoComplete === true);
  await js(`location.hash = "#/board/${hh.id}"`);
  const boardKeys = await until("board shows renamed cards", async () => {
    const k = await js<string[]>(`[...document.querySelectorAll(".card-key")].map(e => e.textContent)`);
    return k.includes("HEL-3") && !k.some((x) => x.startsWith("HELLOHARNESS")) && k;
  });
  check("board cards show the new keys", !!boardKeys, boardKeys.join(","));

  // 6c. Appearance: the picker drives nativeTheme (prefers-color-scheme) and <html data-theme>.
  await js(`location.hash = "#/settings/appearance"`);
  await until("theme picker", () => exists("[data-theme-option=dark]"));
  const themeNow = () =>
    js<{ attr: string; mq: boolean; bg: string; pref: string }>(`({ attr: document.documentElement.dataset.theme, mq: matchMedia("(prefers-color-scheme: dark)").matches,
      bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(), pref: window.harness.getTheme().preference })`);
  await js(`document.querySelector("[data-theme-option=dark]").click()`);
  const dark = await until("dark applied", async () => {
    const t = await themeNow();
    return t.attr === "dark" && t.mq && t;
  });
  check("Dark sets data-theme, nativeTheme and the tokens", dark.bg === "#111214" && dark.pref === "dark", JSON.stringify(dark));
  await js(`document.querySelector("[data-theme-option=light]").click()`);
  const light = await until("light applied", async () => {
    const t = await themeNow();
    return t.attr === "light" && !t.mq && t;
  });
  check("Light sets data-theme, nativeTheme and the tokens", light.bg === "#fbfbfc" && light.pref === "light", JSON.stringify(light));
  await js(`document.querySelector("[data-theme-option=system]").click()`);
  const sys = await until("system applied", async () => {
    const t = await themeNow();
    return t.pref === "system" && t;
  });
  check("System resolves to the OS appearance", sys.attr === (sys.mq ? "dark" : "light"), JSON.stringify(sys));
  // The attribute is the contract plugins observe: it must survive a reload.
  await js(`document.querySelector("[data-theme-option=dark]").click()`);
  await until("dark again", async () => (await themeNow()).attr === "dark");
  await js(`location.reload()`);
  await Bun.sleep(300);
  const afterReload = await until("theme after reload", async () => {
    const t = await themeNow();
    return t.attr ? t : null;
  });
  check("theme preference survives a reload", afterReload.attr === "dark" && afterReload.pref === "dark", JSON.stringify(afterReload));
  await until("picker after reload", () => exists("[data-theme-option=system]"));

  // 6c'. Color themes: switching the dark theme to Catppuccin Mocha recolors the live UI (computed
  // styles, not just the variables), keeps data-theme="dark" for plugins, and survives a reload.
  const colors = () =>
    js<{ attr: string; id: string; bg: string; body: string; card: string; accent: string; dark: string }>(`(() => {
      const cs = getComputedStyle(document.documentElement);
      const btn = document.querySelector(".btn-primary");
      return { attr: document.documentElement.dataset.theme, id: document.documentElement.dataset.themeId,
        bg: cs.getPropertyValue("--bg").trim(), body: getComputedStyle(document.body).backgroundColor,
        card: getComputedStyle(document.querySelector(".card-surface")).backgroundColor,
        accent: btn ? getComputedStyle(btn).backgroundColor : "", dark: window.harness.getTheme().darkTheme };
    })()`);
  const harnessDark = await colors();
  check("Harness Dark is the default dark theme", harnessDark.id === "harness-dark" && harnessDark.body === "rgb(17, 18, 20)", JSON.stringify(harnessDark));
  await until("dark theme grid", () => exists('[data-theme-pick="dark:catppuccin-mocha"]'));
  await js(`document.querySelector('[data-theme-pick="dark:catppuccin-mocha"]').click()`);
  const mocha = await until("mocha applied", async () => {
    const c = await colors();
    // Buttons transition their background for 120ms; wait for the primary button to land too.
    return c.id === "catppuccin-mocha" && c.accent === "rgb(203, 166, 247)" && c;
  });
  check(
    "Catppuccin Mocha changes computed colors live",
    mocha.attr === "dark" && mocha.bg === "#181825" && mocha.body === "rgb(24, 24, 37)" && mocha.card !== harnessDark.card && mocha.accent !== harnessDark.accent && mocha.dark === "catppuccin-mocha",
    JSON.stringify(mocha),
  );
  check("the picker marks Mocha as chosen", await js<boolean>(`document.querySelector('[data-theme-pick="dark:catppuccin-mocha"]').getAttribute("aria-checked") === "true"`));
  await js(`location.reload()`);
  await Bun.sleep(300);
  const mochaReload = await until("mocha after reload", async () => {
    const c = await js<{ id?: string; body: string }>(`({ id: document.documentElement.dataset.themeId, body: getComputedStyle(document.body).backgroundColor })`);
    return c.id ? c : null;
  });
  check("the dark theme pick survives a reload", mochaReload.id === "catppuccin-mocha" && mochaReload.body === "rgb(24, 24, 37)", JSON.stringify(mochaReload));
  await until("picker after mocha reload", () => exists('[data-theme-pick="dark:harness-dark"]'));
  await js(`document.querySelector('[data-theme-pick="dark:harness-dark"]').click()`);
  await until("back to harness dark", async () => (await colors()).id === "harness-dark");
  await js(`document.querySelector("[data-theme-option=system]").click()`);

  // 6d. Conductor: Tickets tab (live), child breadcrumb, board dimming, rollup, hide-children toggle.
  {
    type CT = { id: string; key: string; projectId: string; status: string };
    const all = await api<CT[]>("GET", "/tickets");
    const conductor = all.find((t) => t.key === "HARNESS-1")!;
    const hxId = conductor.projectId;
    const rowKeys = () => js<string[]>(`[...document.querySelectorAll(".child-row")].map(r => r.dataset.key)`);
    const progressText = () => js<string>(`document.querySelector("[data-testid=children-progress]")?.textContent ?? ""`);
    const tabCount = () => js<string>(`document.querySelector(".tab[data-tab=children] .count")?.textContent ?? ""`);

    await js(`location.hash = "#/board/all/ticket/HARNESS-1/children"`);
    const rows = await until("children rows", async () => {
      const k = await rowKeys();
      return k.length >= 7 && k;
    });
    check(
      "Tickets tab lists the children grouped in lifecycle order",
      rows.join(",") === "HARNESS-3,HARNESS-6,HARNESS-7,HARNESS-8,HARNESS-2,HARNESS-10,HARNESS-5",
      rows.join(","),
    );
    check("Tickets tab shows the progress header", (await progressText()) === "1/7 done · 1 in progress · 2 blocked · 2 review · 1 up next", await progressText());
    check("Tickets tab badge counts the children", (await tabCount()) === "7", await tabCount());
    const waiting = await js<string>(`document.querySelector(".children-attn")?.textContent ?? ""`);
    check("header counts blocked/approval children only (reviews are the conductor's)", waiting === "2 tickets waiting on you", waiting);
    const attnRows = await js<string[]>(`[...document.querySelectorAll(".child-row.attn")].map(r => r.dataset.key)`);
    check("only blocked/approval children get the attention edge", attnRows.join(",") === "HARNESS-7,HARNESS-8", attnRows.join(","));
    const notes = await js<Record<string, string>>(
      `Object.fromEntries([...document.querySelectorAll(".child-row")].map(r => [r.dataset.key, (r.querySelector(".child-note")?.textContent ?? "") + "|" + [...r.querySelectorAll(".child-foot .chip")].map(c => c.textContent).join(",")]))`,
    );
    check("approval child shows the tool it waits on", notes["HARNESS-8"] === "Needs approval: Bash|waiting onHARNESS-2", notes["HARNESS-8"]);
    check("blocked child shows its question and done dep", notes["HARNESS-7"]!.startsWith("Which Apple Developer team") && notes["HARNESS-7"]!.endsWith("|afterHARNESS-5"), notes["HARNESS-7"]);

    // Live: a new child (ticket.upserted) appears, and a status change regroups an existing one.
    const fresh = await api<CT>("POST", "/tickets", { projectId: hxId, parentId: conductor.id, prompt: "Write the release notes", start: false, dependsOn: ["HARNESS-7"] });
    const grown = await until("new child row", async () => {
      const k = await rowKeys();
      return k.length === 8 && (await tabCount()) === "8" && k;
    });
    check("a new child streams into the Tickets tab", grown.includes(fresh.key), grown.join(","));
    await api("PATCH", "/tickets/HARNESS-3", { status: "done" });
    const regrouped = await until("HARNESS-3 regrouped", () =>
      js<boolean>(`!!document.querySelector('.children-group[data-status=done] .child-row[data-key="HARNESS-3"]')`),
    );
    check("a child's status change regroups it live", regrouped);
    check("progress header follows live", (await until("progress 2/8", async () => (await progressText()).startsWith("2/8 done") && (await progressText()))) === "2/8 done · 1 in progress · 2 blocked · 2 review · 1 up next");

    // Row → child, in the same pane; the breadcrumb leads back to the conductor's Tickets tab.
    const conductorPane = await js<string>(`document.querySelector(".pane-ticket")?.dataset.paneId ?? ""`);
    await js(`document.querySelector('.child-row[data-key="HARNESS-6"]').click()`);
    const crumb = await until("parent crumb", () => js<string>(`location.hash.endsWith("/ticket/HARNESS-6") && document.querySelector("[data-testid=parent-crumb]")?.textContent`));
    check("child detail shows the Part of breadcrumb", crumb === "Part ofHARNESS-1Build the harness desktop app", crumb);
    check(
      "a child row navigates its own pane (no new pane)",
      !!conductorPane && (await js<string[]>(`[...document.querySelectorAll(".pane-ticket")].map(p => p.dataset.paneId)`)).join(",") === conductorPane,
    );
    await js(`document.querySelector("[data-testid=parent-crumb]").click()`);
    const back = await until("back to conductor", () => js<string>(`location.hash`).then((h) => h.endsWith("/ticket/HARNESS-1/children") && h));
    check("breadcrumb opens the conductor's Tickets tab", !!back, back);
    await js(`location.hash = "#/board/all/ticket/HARNESS-6/children"`);
    const plainTab = await until("plain ticket tabs", () =>
      js<string>(`location.hash.includes("HARNESS-6") && document.querySelector(".tab.on")?.dataset.tab`),
    );
    check("plain tickets have no Tickets tab (the route falls back to Summaries)", plainTab === "summaries" && !(await exists(".tab[data-tab=children]")), plainTab);

    // Empty conductor.
    const empty = await api<CT>("POST", "/tickets", { projectId: hxId, kind: "conductor", prompt: "Plan the 1.0 launch", start: false });
    await js(`location.hash = "#/board/all/ticket/${empty.key}/children"`);
    const emptyText = await until("children empty state", () => js<string>(`document.querySelector("[data-testid=children-empty]")?.textContent ?? ""`));
    check("empty conductor explains there are no tickets yet", emptyText.includes("The conductor hasn't created any tickets yet."), emptyText);

    // Board: quiet children are dimmed, ones that need you are not; the conductor card rolls up.
    await js(`location.hash = "#/board/${hxId}"`);
    await until("harness board", () => exists('.card[data-key="HARNESS-1"]'));
    const dimmed = () =>
      js<Record<string, boolean>>(`Object.fromEntries([...document.querySelectorAll(".card[data-key]")].map(c => [c.dataset.key, c.classList.contains("child-dim")]))`);
    const d = await dimmed();
    check(
      "quiet children are dimmed on the board",
      d["HARNESS-6"] === true && d["HARNESS-2"] === true && d["HARNESS-5"] === true && d[fresh.key] === true && d["HARNESS-10"] === true,
      JSON.stringify(d),
    );
    check(
      "children that need you (blocked, approval) and the conductor are not dimmed",
      d["HARNESS-7"] === false && d["HARNESS-8"] === false && d["HARNESS-1"] === false && d["HARNESS-9"] === false,
      JSON.stringify(d),
    );
    const rollup = await js<string>(`document.querySelector('.card[data-key="HARNESS-1"] [data-testid=conductor-rollup]')?.textContent ?? ""`);
    check("conductor card rolls up progress and what needs you", rollup === "2/8 done2 need you", rollup);
    const parentChip = await js<string>(`document.querySelector('.card[data-key="HARNESS-6"] .card-parent-chip')?.textContent ?? ""`);
    check("child card carries a parent chip", parentChip === "↳ HARNESS-1", parentChip);
    // The rollup says it's a conductor: no Conductor badge, and no accent edge.
    const kindBadges = await js<number>(`document.querySelectorAll('.card[data-key="HARNESS-1"] .badge-violet').length`);
    check("conductor card has no Conductor badge", kindBadges === 0, String(kindBadges));
    const ownTop = await js<string>(`document.querySelector('.card[data-key="HARNESS-1"] .card-top')?.firstElementChild?.className ?? ""`);
    check("a single project's board shows no project key on cards", ownTop === "card-key", ownTop);
    const edge = await js<{ left: string; top: string; lc: string; tc: string }>(`(() => { const cs = getComputedStyle(document.querySelector('.card[data-key="HARNESS-1"]'));
      return { left: cs.borderLeftWidth, top: cs.borderTopWidth, lc: cs.borderLeftColor, tc: cs.borderTopColor }; })()`);
    check("conductor card has no left accent border", edge.left === edge.top && edge.lc === edge.tc, JSON.stringify(edge));

    // Switch off: hides quiet children only, persists across a reload, and turns back on.
    await toggleChildren();
    const hidden = await until("children hidden", async () => {
      const k = await cardKeys();
      return !k.includes("HARNESS-6") && k;
    });
    check(
      "Hide child tickets hides quiet children",
      ["HARNESS-2", "HARNESS-3", "HARNESS-5", "HARNESS-6", "HARNESS-10", fresh.key].every((k) => !hidden.includes(k)),
      hidden.join(","),
    );
    check("…but keeps the ones that need you and the conductor", ["HARNESS-1", "HARNESS-7", "HARNESS-8"].every((k) => hidden.includes(k)), hidden.join(","));
    check("the switch shows no count of what it hides", (await toggleState()).text === "Show child tickets" && !(await hiddenCountText()), (await toggleState()).text);
    await js(`location.reload()`);
    await Bun.sleep(300);
    const afterReload = await until("board after reload", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-1") && k;
    });
    check("hiding children survives a reload", !afterReload.includes("HARNESS-6") && afterReload.includes("HARNESS-8") && (await toggleState()).checked === "false", afterReload.join(","));
    await toggleChildren();
    const shown = await until("children shown", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-6") && k;
    });
    check("switching it back on shows every child again", ["HARNESS-2", "HARNESS-5", "HARNESS-6"].every((k) => shown.includes(k)), shown.join(","));
  }

  // 6c. Layout: collapsible + resizable sidebar, the pane workspace (dividers, zoom, close); all persisted.
  {
    await js(`location.hash = "#/board/all"`);
    await until("board", () => exists(".board-pane .view-header"));
    const width = (sel: string) => js<number>(`Math.round(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().width ?? -1)`);
    const stored = () => js<Record<string, unknown>>(`JSON.parse(localStorage.getItem("harness.layout") ?? "{}")`);
    const reload = async (ready: string) => {
      await js(`location.reload()`);
      await Bun.sleep(300);
      await until("reloaded", () => exists(ready), 10000);
      await Bun.sleep(300); // let the width transition settle
    };
    const mouse = (type: string, x: number, y: number, clickCount = 1) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount });
    /** Real pointer drag of a handle by dx, in steps (so it crosses whatever is under the path). */
    const drag = async (sel: string, dx: number, during?: () => Promise<void>) => {
      const r = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
      await mouse("mousePressed", r.x, r.y);
      for (let i = 1; i <= 6; i++) await mouse("mouseMoved", r.x + (dx * i) / 6, r.y);
      await during?.();
      await mouse("mouseReleased", r.x + dx, r.y);
      await Bun.sleep(50);
    };
    const dblclick = async (sel: string) => {
      const r = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await mouse("mousePressed", r.x, r.y, 1);
      await mouse("mouseReleased", r.x, r.y, 1);
      await mouse("mousePressed", r.x, r.y, 2);
      await mouse("mouseReleased", r.x, r.y, 2);
      await Bun.sleep(300);
    };
    const shortcut = () => app!.key("s", "KeyS", 83, 2 | 4); // ⌃⌘S (Ctrl=2, Meta=4)
    // Visible controls whose centre ends up in the window's drag area, which swallows real clicks
    // there (CDP clicks don't go through it, so the other checks can't see this). Electron builds the
    // area from -webkit-app-region boxes in document order, drag adding and no-drag subtracting, so
    // a drag box later in the document re-covers an earlier no-drag control.
    const draggableControls = () =>
      js<string[]>(`(() => {
        const regions = [...document.querySelectorAll("*")].flatMap((e) => {
          const v = getComputedStyle(e).getPropertyValue("-webkit-app-region");
          const r = e.getBoundingClientRect();
          return (v === "drag" || v === "no-drag") && r.width && r.height ? [{ drag: v === "drag", r }] : [];
        });
        return [...document.querySelectorAll("button, a[href], input, select, textarea, [role=separator]")].flatMap((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || el.closest("[inert]")) return [];
          const x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y);
          if (!top || !el.contains(top)) return []; // covered or off screen
          let drag = false;
          for (const g of regions) if (x >= g.r.left && x < g.r.right && y >= g.r.top && y < g.r.bottom) drag = g.drag;
          return drag ? [el.dataset.testid || el.getAttribute("aria-label") || el.textContent.trim().slice(0, 30) || el.className] : [];
        });
      })()`);

    // Sidebar: collapse with the button; the board header clears the traffic lights and stays a drag region.
    const open = await width(".sidebar");
    const dragOpen = await draggableControls();
    check("no control sits under a window drag region (sidebar open)", dragOpen.length === 0, dragOpen.join(", "));
    await js(`document.querySelector("[data-testid=sidebar-toggle]").click()`);
    const collapsed = await until("sidebar collapsed", async () => (await width(".sidebar")) === 0 && (await js<boolean>(`document.querySelector(".sidebar").inert`)));
    await Bun.sleep(250);
    const dragShut = await draggableControls();
    check("no control sits under a window drag region (sidebar collapsed)", dragShut.length === 0, dragShut.join(", "));
    const head = await js<{ region: string; expanded: string | null }>(`(() => { const cs = getComputedStyle(document.querySelector(".board-pane > .view-header"));
      return { region: cs.getPropertyValue("-webkit-app-region"), expanded: document.querySelector("[data-testid=sidebar-toggle]").getAttribute("aria-expanded") }; })()`);
    await Bun.sleep(250);
    const headPad = await js<number>(`parseFloat(getComputedStyle(document.querySelector(".board-pane > .view-header")).paddingLeft)`);
    const toggleRight = await js<number>(`document.querySelector("[data-testid=sidebar-toggle]").getBoundingClientRect().right`);
    check("toggle button collapses the sidebar (inert, aria-expanded=false)", open > 150 && collapsed && head.expanded === "false", `${open}px → 0`);
    check("collapsed board header clears the traffic lights + toggle and stays draggable", headPad > toggleRight && toggleRight > 90 && head.region === "drag", `${headPad}px pad, toggle ends ${toggleRight}px, region ${head.region}`);
    check("collapsed state is persisted", (await stored()).sidebarCollapsed === true);
    await reload(".board-pane .view-header");
    check("collapsed sidebar survives a reload", (await width(".sidebar")) === 0);
    await shortcut();
    const back = await until("sidebar expanded by ⌃⌘S", async () => (await width(".sidebar")) === open);
    check("⌃⌘S expands it again", back === true && (await stored()).sidebarCollapsed === false);
    await shortcut();
    check("⌃⌘S collapses it", !!(await until("collapsed by shortcut", async () => (await width(".sidebar")) === 0)));
    await shortcut();
    await until("expanded", async () => (await width(".sidebar")) === open);

    // Sidebar drag-resize, persistence, keyboard, double-click reset, clamping.
    await drag("[data-testid=sidebar-resizer]", 60);
    check("dragging the sidebar edge widens it", (await width(".sidebar")) === open + 60, `${open} → ${await width(".sidebar")}`);
    check("sidebar width is persisted", (await stored()).sidebarWidth === open + 60, JSON.stringify(await stored()));
    await reload(".board-pane .view-header");
    check("sidebar width survives a reload", (await width(".sidebar")) === open + 60);
    await drag("[data-testid=sidebar-resizer]", 1000);
    check("sidebar width stops at its maximum", (await width(".sidebar")) === 400, String(await width(".sidebar")));
    await js(`document.querySelector("[data-testid=sidebar-resizer]").focus()`);
    await app!.key("ArrowLeft", "ArrowLeft", 37);
    // Keyboard and reset changes animate (drags don't): wait for the width to land.
    const settled = (sel: string, w: number) => until(`${sel} at ${w}px`, async () => (await width(sel)) === w).catch(() => false);
    const keyed = await settled(".sidebar", 384);
    const aria = await until("aria-valuenow", () => js<string>(`document.querySelector("[data-testid=sidebar-resizer]").getAttribute("aria-valuenow")`).then((v) => v === "384" && v)).catch(() => "");
    check("arrow keys resize the focused handle (role=separator, aria-valuenow)", keyed && aria === "384", `${await width(".sidebar")} / ${aria}`);
    await dblclick("[data-testid=sidebar-resizer]");
    check("double-clicking the sidebar handle resets its width", (await settled(".sidebar", open)) && (await stored()).sidebarWidth === null, String(await width(".sidebar")));

    // Ticket panes: a card's ticket opens beside the board (60/40); the divider between them drags
    // across an iframe (iframes swallow pointer events without the overlay). Every board has its own
    // panes (scopes keyed by project id, "*" for All projects); these checks run on All projects.
    const panes = () => js<{ root: { type: string; sizes?: number[]; children?: unknown[] }; focusedId: string | null; zoomedId: string | null }>(`JSON.parse(localStorage.getItem("harness.panes") ?? "null")?.scopes?.["*"]`);
    const setPanes = (st: object) =>
      js(`localStorage.setItem("harness.panes", ${JSON.stringify(JSON.stringify({ scopes: { "*": st } }))}); dispatchEvent(new StorageEvent("storage", { key: "harness.panes" }))`);
    const leftOf = (sel: string) => js<number>(`Math.round(document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().left ?? -1)`);
    const padLeft = (sel: string) => js<number>(`parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).paddingLeft)`);
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    const divider = "[data-testid=pane-divider]";
    await setPanes({ root: { type: "leaf", id: "b", content: { kind: "board" } }, focusedId: null, zoomedId: null });
    await js(`location.hash = "#/board/all/ticket/NYTIMES-4"`);
    await until("ticket pane", () => exists(".pane-ticket .detail-titlebar"));
    await Bun.sleep(300);
    const ws = await width(".pane-workspace");
    const def = await width(".pane-ticket");
    check("a ticket opens in a pane right of the board, taking 40%", near(def, ws * 0.4) && (await leftOf(".pane-ticket")) > (await leftOf(".pane-board")), `${def} of ${ws}`);
    await js(`(() => { const f = document.createElement("iframe"); f.id = "smoke-iframe"; f.srcdoc = "<body style='margin:0;background:#f0f'>";
      const x = document.querySelector("[data-testid=pane-divider]").getBoundingClientRect().x;
      Object.assign(f.style, { position: "fixed", top: "0", left: "0", width: (x - 10) + "px", height: "100vh", border: "0", zIndex: "25", opacity: "0.01" });
      document.body.appendChild(f); })()`);
    let overlayOnTop = false;
    await drag(divider, -200, async () => {
      overlayOnTop = await js<boolean>(`document.elementFromPoint(40, 300)?.dataset.testid === "resize-overlay"`);
    });
    const grown = await width(".pane-ticket");
    check("dragging the divider over an iframe still resizes the panes", near(grown, def + 200), `${def} → ${grown}`);
    check("a full-window overlay covers iframes mid-drag and goes away after", overlayOnTop && !(await exists(".resize-overlay")));
    await js(`document.getElementById("smoke-iframe")?.remove()`);
    check("pane sizes are persisted", near(((await panes()).root.sizes?.[1] ?? 0) * ws, grown), JSON.stringify((await panes()).root.sizes));
    await drag(divider, -3000);
    check("the board pane stops at 320px", near(await width(".pane-board"), 320), String(await width(".pane-board")));
    await drag(divider, 3000);
    check("a ticket pane stops at 360px", near(await width(".pane-ticket"), 360), String(await width(".pane-ticket")));
    await drag(divider, -(grown - (await width(".pane-ticket"))));
    await reload(".pane-ticket .detail-titlebar");
    check("pane sizes survive a reload", near(await width(".pane-ticket"), grown), String(await width(".pane-ticket")));
    await js(`document.querySelector("[data-testid=pane-divider]").focus()`);
    await app!.key("ArrowLeft", "ArrowLeft", 37);
    check("ArrowLeft on the focused divider widens the ticket pane", near(await width(".pane-ticket"), grown + 16), String(await width(".pane-ticket")));
    await dblclick(divider);
    check("double-clicking the divider makes the panes equal", near(await width(".pane-ticket"), ws / 2) && near(await width(".pane-board"), ws / 2), `${await width(".pane-board")} | ${await width(".pane-ticket")}`);

    // Two tickets side by side (stored state), the hash mirroring the focused one; zoom; close.
    const ticketLeaf = (id: string, ticketKey: string) => ({ type: "leaf", id, content: { kind: "ticket", ticketKey, tab: "summaries" } });
    await setPanes({
      root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "b", content: { kind: "board" } }, ticketLeaf("t1", "NYTIMES-4"), ticketLeaf("t2", "NYTIMES-3")], sizes: [0.4, 0.3, 0.3] },
      focusedId: "t2",
      zoomedId: null,
    });
    const keysShown = () => js<string[]>(`[...document.querySelectorAll(".pane-ticket")].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(p => p.querySelector(".detail-key")?.textContent ?? "")`);
    const two = await until("two ticket panes", async () => {
      const k = await keysShown();
      return k.length === 2 && k.every(Boolean) && k;
    });
    check("two ticket panes sit side by side", two.join(",") === "NYTIMES-4,NYTIMES-3" && (await js<number>(`document.querySelectorAll(".detail").length`)) === 2, two.join(","));
    check("the hash mirrors the focused ticket pane", (await js<string>("location.hash")) === "#/board/all/ticket/NYTIMES-3");
    check(
      "cards show which tickets are open (the focused one strongest)",
      (await js<boolean>(`document.querySelector('.card[data-key="NYTIMES-3"]').classList.contains("selected") && document.querySelector('.card[data-key="NYTIMES-4"]').classList.contains("open")`)),
    );
    await js(`document.querySelector("[data-pane-id=t1] .detail-body").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
    const refocused = await until("focus follows a click", () => js<string>("location.hash").then((h) => h === "#/board/all/ticket/NYTIMES-4" && h)).catch(() => "");
    check("clicking in a pane focuses it (and the hash follows)", !!refocused && (await exists("[data-pane-id=t1].focused")));
    await js(`document.querySelector("[data-pane-id=t2] [data-testid=pane-zoom]").click()`);
    await until("zoomed", () => exists(".pane.zoomed"));
    check(
      "Maximize fills the workspace and hides the other panes and dividers",
      near(await width(".pane.zoomed"), ws) && (await js<number>(`document.querySelectorAll(".pane.covered").length`)) === 2 && !(await exists(divider)),
      String(await width(".pane.zoomed")),
    );
    await app!.key("Escape", "Escape", 27);
    await until("unzoomed", async () => !(await exists(".pane.zoomed")));
    check("Escape restores a maximized pane (and closes nothing)", (await keysShown()).length === 2 && (await panes()).zoomedId === null);
    await js(`document.querySelector("[data-pane-id=t2] [data-testid=pane-close]").click()`);
    const left = await until("one ticket pane", async () => {
      const k = await keysShown();
      return k.length === 1 && k;
    });
    check("closing a pane gives its room to its neighbour", left.join(",") === "NYTIMES-4" && near((await width(".pane-board")) + (await width(".pane-ticket")), ws), left.join(","));

    // Collapsed sidebar: only the top-left pane's header clears the traffic lights (the zoomed one while zoomed).
    await js(`document.querySelector("[data-testid=sidebar-toggle]").click()`);
    await until("sidebar collapsed", async () => (await width(".sidebar")) === 0);
    await Bun.sleep(300);
    const toggleEnd = await js<number>(`document.querySelector("[data-testid=sidebar-toggle]").getBoundingClientRect().right`);
    check(
      "collapsed: the board pane's header is inset, the ticket pane's isn't",
      (await padLeft(".pane-board .board-pane > .view-header")) > toggleEnd && (await padLeft(".pane-ticket .detail-titlebar")) < toggleEnd,
    );
    await js(`document.querySelector(".pane-ticket [data-testid=pane-zoom]").click()`);
    await until("zoomed", () => exists(".pane.zoomed"));
    await Bun.sleep(300);
    check("a maximized ticket pane's header clears the traffic lights", (await padLeft(".pane-ticket .detail-titlebar")) > toggleEnd);
    await js(`document.querySelector(".pane-ticket [data-testid=pane-zoom]").click()`);
    await js(`document.querySelector("[data-testid=sidebar-toggle]").click()`);
    await until("sidebar back", async () => (await width(".sidebar")) === open);
    await app!.key("Escape", "Escape", 27);
    const closed = await until("Escape closes the focused pane", async () => !(await exists(".pane-ticket")) && (await js<string>("location.hash")));
    check("Escape closes the focused ticket pane and the hash drops the ticket", closed === "#/board/all", String(closed));

    // The browser canvas follows its pane: the service gets the new viewport size.
    await js(`location.hash = "#/board/all/ticket/NYTIMES-1/browser"`);
    await until("browser stage", () => exists(".browser-canvas"));
    await Bun.sleep(600);
    await drag(divider, -120);
    const stageW = await until("stage resized", async () => {
      const w = await js<number>(`Math.round(document.querySelector(".browser-stage").clientWidth)`);
      return inputs.some((l) => l.includes('"type":"resize"') && l.includes(`"width":${w}`)) && w;
    }).catch(() => 0);
    check("dragging a divider resizes the browser viewport", stageW > 0, String(stageW));

    // Each board remembers its own panes: a project's board starts bare, a ticket opened there stays
    // there, and All projects comes back with its panes as they were (and vice versa).
    const nyBoard = `#/board/${nyProject.id}`;
    await js(`location.hash = ${JSON.stringify(nyBoard)}`);
    const bare = await until("project board", async () => (await exists(".pane-board")) && (await keysShown()).length === 0).catch(() => false);
    check("a project board shows its own (bare) panes, not All projects'", bare, JSON.stringify(await keysShown()));
    await js(`location.hash = ${JSON.stringify(`${nyBoard}/ticket/NYTIMES-2`)}`);
    await until("project ticket pane", async () => (await keysShown()).join() === "NYTIMES-2").catch(() => {});
    await js(`location.hash = "#/board/all"`);
    const allBack = await until("All projects panes", async () => (await keysShown()).join() === "NYTIMES-1" && (await js<string>("location.hash"))).catch(() => "");
    check("switching back to All projects restores its panes (and the hash mirrors them)", allBack === "#/board/all/ticket/NYTIMES-1/browser", `${JSON.stringify(await keysShown())} ${allBack}`);
    await js(`location.hash = "#/inbox"`);
    await js(`location.hash = ${JSON.stringify(nyBoard)}`);
    const nyBack = await until("project panes", async () => (await keysShown()).join() === "NYTIMES-2").catch(() => false);
    check("the project board keeps its own panes across Inbox and All projects", nyBack, JSON.stringify(await keysShown()));
    const scopes = await js<string[]>(`Object.keys(JSON.parse(localStorage.getItem("harness.panes")).scopes).sort()`);
    check("each board's panes are stored under its own scope", scopes.includes("*") && scopes.includes(nyProject.id), JSON.stringify(scopes));
    await setPanes({ root: { type: "leaf", id: "b", content: { kind: "board" } }, focusedId: null, zoomedId: null });
    await js(`location.hash = "#/board/all"`);
  }

  // 6e. Drag to split: a card, a child row or a pane's header grip dropped on a half of a pane
  // docks there. Synthetic DragEvents drive the renderer's handlers; one real Chromium drag
  // (Input.setInterceptDrags) checks the native path end to end.
  {
    const setPanes = (st: object) =>
      js(`localStorage.setItem("harness.panes", ${JSON.stringify(JSON.stringify({ scopes: { "*": st } }))}); dispatchEvent(new StorageEvent("storage", { key: "harness.panes" }))`);
    const boardOnly = { root: { type: "leaf", id: "b", content: { kind: "board" } }, focusedId: null, zoomedId: null };
    await setPanes(boardOnly);
    await js(`location.hash = "#/board/all"`);
    await until("board cards", () => exists('.card[data-key="NYTIMES-4"]'));
    /** Each pane's ticket key (or "board") and rounded box, left to right then top to bottom. */
    type Box = { key: string; x: number; y: number; w: number; h: number };
    const boxes = () =>
      js<Box[]>(`[...document.querySelectorAll(".pane")].map(p => { const r = p.getBoundingClientRect();
        return { key: p.querySelector(".detail-key")?.textContent ?? "board", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })
        .sort((a, b) => a.x - b.x || a.y - b.y)`);
    const paneOf = (key: string) => `[...document.querySelectorAll(".pane")].find(p => (p.querySelector(".detail-key")?.textContent ?? "board") === ${JSON.stringify(key)})`;
    /**
     * Drag `src` (a selector) to a point in the pane showing `onto`, `fx`/`fy` of the way across
     * it. Returns whether the layer took the dragover and the preview it showed; `drop: false`
     * holds the drag there (end it with endDrag).
     */
    const dragTo = (src: string, onto: string, fx: number, fy: number, drop = true) =>
      js<{ layer: boolean; accepted: boolean; zone: string | null; preview: Box | null; topAtPoint: string }>(`(async () => {
        const tick = () => new Promise(r => setTimeout(r, 60));
        const el = document.querySelector(${JSON.stringify(src)});
        const t = (${paneOf(onto)}).getBoundingClientRect();
        const x = t.left + t.width * ${fx}, y = t.top + t.height * ${fy};
        const dt = window.__smokeDT = new DataTransfer();
        window.__smokeSrc = el;
        el.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
        await tick();
        const layer = document.querySelector("[data-testid=pane-drop-layer]");
        if (!layer) return { layer: false, accepted: false, zone: null, preview: null, topAtPoint: "" };
        const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y });
        layer.dispatchEvent(ev("dragenter"));
        const accepted = !layer.dispatchEvent(ev("dragover"));
        await tick();
        await new Promise(r => setTimeout(r, 200)); // the preview's entry animation
        const p = document.querySelector("[data-testid=pane-drop-preview]");
        const r = p?.getBoundingClientRect();
        const out = { layer: true, accepted, zone: p?.dataset.zone ?? null, preview: r ? { key: "", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
          topAtPoint: document.elementFromPoint(x, y)?.dataset.testid ?? "" };
        if (${drop}) {
          if (accepted) layer.dispatchEvent(ev("drop"));
          el.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
          await tick();
        }
        return out;
      })()`);
    const endDrag = () => js(`window.__smokeSrc.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: window.__smokeDT }))`);
    const near = (a: number, b: number) => Math.abs(a - b) <= 2;

    // A card on the right half of the board: the same 60/40 split a click makes.
    const card = (key: string) => `.card[data-key="${key}"]`;
    const r1 = await dragTo(card("NYTIMES-4"), "board", 0.9, 0.5);
    const b1 = await until("the dropped ticket's pane", async () => {
      const b = await boxes();
      return b.length === 2 && b;
    }).catch(() => boxes());
    check("while a card is dragged, a drop layer covers the panes and previews the right half", r1.layer && r1.accepted && r1.zone === "right" && r1.topAtPoint === "pane-drop-layer", JSON.stringify(r1));
    check(
      "a card dropped on the board's right half opens beside it, taking 40%",
      b1[0]!.key === "board" && b1[1]!.key === "NYTIMES-4" && near(b1[1]!.w, (b1[0]!.w + b1[1]!.w) * 0.4),
      JSON.stringify({ b1, preview: r1.preview }),
    );
    check("the preview showed exactly where the pane landed", !!r1.preview && near(r1.preview.x, b1[1]!.x) && near(r1.preview.w, b1[1]!.w) && near(r1.preview.h, b1[1]!.h), JSON.stringify(r1.preview));
    check("the drop layer goes away when the drag ends", !(await exists("[data-testid=pane-drop-layer]")));
    check("the dropped ticket's pane is focused (the hash follows)", (await js<string>("location.hash")) === "#/board/all/ticket/NYTIMES-4");

    // A second card on the right half of that pane: side by side. A third on the bottom half: stacked.
    await dragTo(card("NYTIMES-3"), "NYTIMES-4", 0.9, 0.5);
    const b2 = await until("side by side", async () => {
      const b = await boxes();
      return b.length === 3 && b;
    }).catch(() => boxes());
    check(
      "a card dropped on a ticket pane's right half sits beside it, splitting its width",
      b2.map((b) => b.key).join(",") === "board,NYTIMES-4,NYTIMES-3" && b2[1]!.y === b2[2]!.y && near(b2[1]!.w, b2[2]!.w) && near(b2[1]!.x + b2[1]!.w, b2[2]!.x) && (await js<number>(`document.querySelectorAll(".detail").length`)) === 2,
      JSON.stringify(b2),
    );
    const r3 = await dragTo(card("NYTIMES-1"), "NYTIMES-3", 0.5, 0.92);
    const b3 = await until("stacked", async () => {
      const b = await boxes();
      return b.length === 4 && b;
    }).catch(() => boxes());
    const top = b3.find((b) => b.key === "NYTIMES-3")!;
    const below = b3.find((b) => b.key === "NYTIMES-1");
    check(
      "a card dropped on a pane's bottom half stacks under it",
      r3.zone === "bottom" && !!below && below.x === top.x && near(below.w, top.w) && near(top.y + top.h, below.y) && near(top.h, below.h),
      JSON.stringify({ r3, b3 }),
    );

    // Dropping an already-open ticket moves its pane (no duplicate); a pane over itself isn't a target.
    await dragTo(card("NYTIMES-4"), "NYTIMES-1", 0.08, 0.5);
    const b4 = await until("moved", async () => {
      const b = await boxes();
      const one = b.find((x) => x.key === "NYTIMES-1");
      const four = b.find((x) => x.key === "NYTIMES-4");
      return b.length === 4 && one && four && four.y === one.y && four.x < one.x && b;
    }).catch(() => boxes());
    check("dropping a card whose ticket is open moves that pane instead of opening it twice", b4.length === 4 && b4.filter((b) => b.key === "NYTIMES-4").length === 1, JSON.stringify(b4));
    await js(`(${paneOf("NYTIMES-3")}).querySelector("[data-testid=pane-grip]").id = "smoke-grip"`);
    const own = await dragTo("#smoke-grip", "NYTIMES-3", 0.5, 0.5, false);
    check("a pane dragged over itself shows no preview and isn't a drop target", own.layer && !own.accepted && own.zone === null, JSON.stringify(own));
    await js(`document.querySelector("[data-testid=pane-drop-layer]").dispatchEvent(new DragEvent("dragleave", { bubbles: true }))`);
    await endDrag();
    check("dragend clears the drop layer", !(await exists("[data-testid=pane-drop-layer]")));

    // Drag a pane by its header grip onto the board's left half: it re-docks there.
    await dragTo("#smoke-grip", "board", 0.1, 0.5);
    const b5 = await until("re-docked", async () => {
      const b = await boxes();
      return b[0]?.key === "NYTIMES-3" && b;
    }).catch(() => boxes());
    const board5 = b5.find((b) => b.key === "board")!;
    check("dragging a pane's header grip onto the board's left half moves the pane there", b5[0]!.key === "NYTIMES-3" && near(b5[0]!.x + b5[0]!.w, board5.x) && b5[0]!.h === board5.h, JSON.stringify(b5));
    check("the board has no grip (it can't be dragged)", !(await exists(".pane-board [data-testid=pane-grip]")));

    // The keyboard route for re-docking: More → Move pane → Board ↓ puts the pane below the board (movePane).
    const boardId = await js<string>(`document.querySelector(".pane-board").dataset.paneId`);
    await js(`(${paneOf("NYTIMES-4")}).querySelector(".detail-titlebar button[title=More]").click()`);
    await until("move menu", () => exists(`[data-testid="move-pane-bottom-${boardId}"]`));
    const moveLabel = await js<string>(`document.querySelector('[data-testid="move-pane-bottom-${boardId}"]').getAttribute("aria-label")`);
    await js(`document.querySelector('[data-testid="move-pane-bottom-${boardId}"]').click()`);
    const underBoard = await until("moved below the board", async () => {
      const b = await boxes();
      const bd = b.find((x) => x.key === "board");
      const four = b.find((x) => x.key === "NYTIMES-4");
      return bd && four && four.y > bd.y && { bd, four };
    }).catch(() => null);
    check(
      "More → Move pane → below the board docks the pane under the board, sharing its width",
      !!underBoard && moveLabel === "Move pane below the board" && near(underBoard.four.x, underBoard.bd.x) && near(underBoard.four.w, underBoard.bd.w) && near(underBoard.bd.y + underBoard.bd.h, underBoard.four.y) && !(await exists(".menu")),
      JSON.stringify({ moveLabel, underBoard }),
    );

    // Narrow panes: 4 across a 1280px window. The rightmost pane's More menu (with its Move pane
    // arrows) stays inside the window, and no titlebar runs into the pane next to it. Then a pane
    // stacked at the bottom opens its menu upward, still inside the window.
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const tLeaf = (id: string, ticketKey: string) => ({ type: "leaf", id, content: { kind: "ticket", ticketKey, tab: "summaries" } });
    await setPanes({
      root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "b", content: { kind: "board" } }, tLeaf("n1", "NYTIMES-4"), tLeaf("n2", "NYTIMES-3"), tLeaf("n3", "NYTIMES-1")], sizes: [0.25, 0.25, 0.25, 0.25] },
      focusedId: "n3",
      zoomedId: null,
    });
    await until("four panes", async () => (await boxes()).length === 4 && (await exists("[data-pane-id=n3] .detail-titlebar button[title=More]")));
    await Bun.sleep(300);
    /** The open menu's rect, how far its Move pane arrows reach, and the viewport. */
    const menuFit = () =>
      js<{ vw: number; vh: number; left: number; right: number; top: number; bottom: number; arrowsRight: number; above: boolean }>(`(() => {
        const m = document.querySelector(".menu"); const r = m.getBoundingClientRect();
        const arrows = [...m.querySelectorAll(".menu-move button")].map(b => b.getBoundingClientRect().right);
        return { vw: innerWidth, vh: innerHeight, left: r.left, right: r.right, top: r.top, bottom: r.bottom, arrowsRight: Math.max(0, ...arrows), above: m.dataset.above === "true" };
      })()`);
    const inside = (f: Awaited<ReturnType<typeof menuFit>>) => f.left >= 0 && f.top >= 0 && f.right <= f.vw && f.bottom <= f.vh && f.arrowsRight > 0 && f.arrowsRight <= f.vw;
    await js(`document.querySelector("[data-pane-id=n3] .detail-titlebar button[title=More]").click()`);
    await until("rightmost menu", () => exists(".menu .menu-move"));
    await Bun.sleep(100);
    const fit = await menuFit();
    const titlebarSpill = await js<string[]>(`[...document.querySelectorAll(".pane-ticket")].flatMap(p => {
      const pr = p.getBoundingClientRect();
      return [...p.querySelectorAll(".detail-titlebar > *")].filter(c => getComputedStyle(c).display !== "none" && c.getBoundingClientRect().right > pr.right + 0.5).map(c => p.dataset.paneId + ":" + c.className);
    })`);
    const narrow = (await boxes()).map((b) => b.w);
    check("at 1280px with 4 panes, the rightmost pane's More menu and its Move pane arrows stay inside the window", fit.vw === 1280 && inside(fit), JSON.stringify({ fit, narrow }));
    check("narrow ticket panes' titlebars don't run into the next pane", titlebarSpill.length === 0, titlebarSpill.join(","));
    await js(`document.querySelector("[data-pane-id=n3] .detail-titlebar button[title=More]").click()`);
    await setPanes({
      root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "b", content: { kind: "board" } }, { type: "split", id: "c", dir: "column", children: [tLeaf("n1", "NYTIMES-4"), tLeaf("n3", "NYTIMES-1")], sizes: [0.85, 0.15] }], sizes: [0.6, 0.4] },
      focusedId: "n3",
      zoomedId: null,
    });
    await until("stacked pane", () => exists("[data-pane-id=n3] .detail-titlebar button[title=More]"));
    await Bun.sleep(300);
    await js(`document.querySelector("[data-pane-id=n3] .detail-titlebar button[title=More]").click()`);
    await until("bottom menu", () => exists(".menu .menu-move"));
    await Bun.sleep(100);
    const low = await menuFit();
    check("a More menu near the bottom of the window opens upward, inside it", low.above && inside(low), JSON.stringify(low));
    await js(`document.querySelector("[data-pane-id=n3] .detail-titlebar button[title=More]").click()`);
    await cdp("Emulation.clearDeviceMetricsOverride");
    await Bun.sleep(200);

    // Over a Browser tab's canvas the layer still takes the drag; other drags (text, files) are ignored.
    await setPanes(boardOnly);
    await js(`location.hash = "#/board/all/ticket/NYTIMES-1/browser"`);
    await until("browser canvas", () => exists(".browser-canvas"));
    await Bun.sleep(400);
    const overCanvas = await dragTo(card("NYTIMES-4"), "NYTIMES-1", 0.5, 0.85);
    // While our drag is up, a dragover that carries only text isn't accepted (one evaluation, so
    // nothing ends the drag in between).
    const foreign = await js<boolean | null>(`(async () => {
      const src = document.querySelector(${JSON.stringify(card("NYTIMES-4"))});
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      await new Promise(r => setTimeout(r, 60));
      const layer = document.querySelector("[data-testid=pane-drop-layer]");
      const dt = new DataTransfer(); dt.setData("text/plain", "hello");
      const accepted = layer ? !layer.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 400, clientY: 300 })) : null;
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
      return accepted;
    })()`);
    check("dragging over the browser canvas reaches the drop layer", overCanvas.accepted && overCanvas.zone === "bottom" && overCanvas.topAtPoint === "pane-drop-layer", JSON.stringify(overCanvas));
    check("a drag that isn't a ticket or pane (text, files) isn't accepted", foreign === false, String(foreign));

    // A conductor's child row dragged onto the right half of the conductor's own pane.
    await setPanes(boardOnly);
    await js(`location.hash = "#/board/all/ticket/HARNESS-1/children"`);
    await until("child rows", () => exists('.child-row[data-key="HARNESS-6"]'));
    await dragTo('.child-row[data-key="HARNESS-6"]', "HARNESS-1", 0.9, 0.5);
    const b6 = await until("child beside conductor", async () => {
      const b = await boxes();
      return b.length === 3 && b;
    }).catch(() => boxes());
    check("a child row dropped on its conductor pane's right half opens beside it", b6.map((b) => b.key).join(",") === "board,HARNESS-1,HARNESS-6", JSON.stringify(b6));

    // The keyboard route: a card's context menu → "Open Below" (autopicked) splits the focused pane.
    await js(`document.querySelector('.card[data-key="NYTIMES-4"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))`);
    const b7 = await until("opened below", async () => {
      const b = await boxes();
      return b.length === 4 && b;
    }).catch(() => boxes());
    const child7 = b7.find((b) => b.key === "HARNESS-6");
    const opened7 = b7.find((b) => b.key === "NYTIMES-4");
    check("a card's context menu opens it below the focused pane", !!child7 && !!opened7 && opened7.x === child7.x && near(child7.y + child7.h, opened7.y), JSON.stringify(b7));
    check("cards are focusable for the keyboard route", (await js<string | null>(`document.querySelector(".card").getAttribute("tabindex")`)) === "0");

    // A real Chromium drag (mouse press + move, intercepted so no OS drag session starts), then
    // dragEnter/Over/drop at the right half of the board.
    await setPanes(boardOnly);
    await js(`location.hash = "#/board/all"`);
    await until("board", () => exists(card("NYTIMES-2")));
    await Bun.sleep(200);
    await cdp("Input.setInterceptDrags", { enabled: true });
    let dragData: unknown = null;
    const off = app!.on((method, params) => {
      if (method === "Input.dragIntercepted") dragData = params.data;
    });
    const from = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(card("NYTIMES-2"))}).getBoundingClientRect(); return { x: r.x + 30, y: r.y + 20 }; })()`);
    const to = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector(".pane-board").getBoundingClientRect(); return { x: r.right - 40, y: r.y + r.height / 2 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + 8 * i, y: from.y + 4 * i, button: "left", buttons: 1 });
    const data = await until("drag intercepted", async () => dragData, 3000).catch(() => null);
    let realOk = false;
    if (data) {
      await Bun.sleep(100);
      await cdp("Input.dispatchDragEvent", { type: "dragEnter", x: to.x, y: to.y, data });
      await cdp("Input.dispatchDragEvent", { type: "dragOver", x: to.x, y: to.y, data });
      await Bun.sleep(100);
      const zone = await js<string | null>(`document.querySelector("[data-testid=pane-drop-preview]")?.dataset.zone ?? null`);
      await cdp("Input.dispatchDragEvent", { type: "drop", x: to.x, y: to.y, data });
      const b8 = await until("real drop", async () => {
        const b = await boxes();
        return b.length === 2 && b;
      }).catch(() => boxes());
      realOk = zone === "right" && b8[1]?.key === "NYTIMES-2";
    }
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    await cdp("Input.setInterceptDrags", { enabled: false });
    off();
    await Bun.sleep(100);
    check("a real (native) card drag onto the board's right half opens the ticket there", realOk && !(await exists("[data-testid=pane-drop-layer]")), JSON.stringify({ intercepted: !!data, boxes: await boxes() }));

    // Stored sizes are clamped to the panes' minimums when laid out: a sliver renders at 360px.
    await setPanes({
      root: { type: "split", id: "r", dir: "row", children: [{ type: "leaf", id: "b", content: { kind: "board" } }, { type: "leaf", id: "t1", content: { kind: "ticket", ticketKey: "NYTIMES-4", tab: "summaries" } }], sizes: [0.97, 0.03] },
      focusedId: null,
      zoomedId: null,
    });
    const sliver = await until("clamped ticket pane", async () => {
      const b = await boxes();
      return b.length === 2 && b;
    }).catch(() => boxes());
    check("a stored sliver of a ticket pane renders at its 360px minimum", near(sliver[1]?.w ?? 0, 360) && sliver[1]?.key === "NYTIMES-4", JSON.stringify(sliver));

    // Launching (here: reloading) at a ticket link opens that ticket once mounted, and the hash keeps it.
    await setPanes(boardOnly);
    await js(`history.replaceState(null, "", "#/board/all/ticket/NYTIMES-3"); location.reload()`);
    await Bun.sleep(300);
    const launched = await until("ticket opened from the launch route", async () => {
      const b = await js<Box[]>(`[...document.querySelectorAll(".pane")].map(p => ({ key: p.querySelector(".detail-key")?.textContent ?? "board" }))`).catch(() => []);
      return b.some((x) => x.key === "NYTIMES-3") && b;
    }, 10000).catch(() => [] as Box[]);
    check("a launch at a ticket link opens it in a pane and the hash keeps the ticket", launched.length === 2 && (await js<string>("location.hash")) === "#/board/all/ticket/NYTIMES-3", JSON.stringify({ launched, hash: await js<string>("location.hash") }));

    await setPanes(boardOnly);
    await js(`location.hash = "#/board/all"`);
  }

  // 6f. Keyboard (DESIGN.md "Keyboard"): hjkl on the board, Enter opens, ⇧⌘[ ] tabs, ⌥⌘arrows
  // between panes and the sidebar, i and Escape for the composer, ⌘K palette, ? overlay, menus,
  // ⌘W, and the pane ring that shows only while the keyboard drives. Real key events throughout.
  {
    const key = app!.key;
    // Modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8.
    const press = {
      j: () => key("j", "KeyJ", 74),
      k: () => key("k", "KeyK", 75),
      l: () => key("l", "KeyL", 76),
      h: () => key("h", "KeyH", 72),
      i: () => key("i", "KeyI", 73),
      two: () => key("2", "Digit2", 50),
      // With its "\r" text, as a real Enter has: that's what presses a focused button.
      enter: async () => {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      },
      escape: () => key("Escape", "Escape", 27),
      down: () => key("ArrowDown", "ArrowDown", 40),
      up: () => key("ArrowUp", "ArrowUp", 38),
      question: () => key("?", "Slash", 191, 8),
      nextTab: () => key("}", "BracketRight", 221, 4 | 8),
      prevTab: () => key("{", "BracketLeft", 219, 4 | 8),
      paneLeft: () => key("ArrowLeft", "ArrowLeft", 37, 1 | 4),
      paneRight: () => key("ArrowRight", "ArrowRight", 39, 1 | 4),
      palette: () => key("k", "KeyK", 75, 4),
      closePane: () => key("w", "KeyW", 87, 4),
    };
    const setPanes = (st: object) =>
      js(`localStorage.setItem("harness.panes", ${JSON.stringify(JSON.stringify({ scopes: { "*": st } }))}); dispatchEvent(new StorageEvent("storage", { key: "harness.panes" }))`);
    const boardOnly = { root: { type: "leaf", id: "b", content: { kind: "board" } }, focusedId: null, zoomedId: null };
    const active = () =>
      js<{ card: string | null; col: number; pane: string | null; tab: string | null; sidebar: boolean; composer: boolean; menu: boolean }>(`(() => {
        const a = document.activeElement;
        const card = a?.closest(".card");
        const cols = [...document.querySelectorAll(".board .column")];
        return { card: card?.dataset.key ?? null, col: card ? cols.indexOf(card.closest(".column")) : -1,
          pane: a?.closest("[data-pane-id]")?.dataset.testid ?? null,
          tab: document.querySelector(".pane.active .tabs [aria-selected=true]")?.dataset.tab ?? document.querySelector(".pane.active .tabs [aria-selected=true]")?.dataset.pluginTab ?? null,
          sidebar: !!a?.closest("#app-sidebar"), composer: !!a?.matches(".composer-input"), menu: !!a?.closest(".menu") };
      })()`);
    const ringShown = () => js<string>(`(() => { const p = document.querySelector(".pane.active"); return p ? getComputedStyle(p, "::after").opacity : "none"; })()`);
    const openTickets = () => js<string[]>(`[...document.querySelectorAll(".pane-ticket .detail-key")].map(e => e.textContent)`);

    await setPanes(boardOnly);
    await js(`location.hash = "#/board/all"`);
    await until("board", () => exists(".board-pane .card"));
    await js(`document.activeElement?.blur()`);

    // hjkl on the board: nothing focused yet, so the keys go to the board pane.
    await press.j();
    const first = await until("j focuses a card", async () => {
      const a = await active();
      return a.card ? a : null;
    });
    await press.j();
    const second = await active();
    check("j moves the card cursor down the column (real DOM focus)", !!first.card && !!second.card && second.card !== first.card && second.col === first.col, `${first.card} → ${second.card}`);
    await press.k();
    check("k moves it back up", (await active()).card === first.card);
    await press.l();
    const right = await active();
    check("l moves to the next column", right.col > first.col && !!right.card, `column ${first.col} → ${right.col}`);
    await press.h();
    check("h comes back to the first column", (await active()).col === first.col);
    await Bun.sleep(200); // the ring fades in
    check("keyboard use shows the focused-pane ring", (await js<string>(`document.documentElement.dataset.input`)) === "keyboard" && (await ringShown()) === "1", await ringShown());
    const head = await js<{ x: number; y: number }>(`(() => { const r = document.querySelector(".board-pane .view-title").getBoundingClientRect(); return { x: r.x + 4, y: r.y + r.height / 2 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: head.x, y: head.y, button: "left", buttons: 1, clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: head.x, y: head.y, button: "left", buttons: 0, clickCount: 1 });
    await until("pointer mode", async () => (await js<string>(`document.documentElement.dataset.input`)) === "pointer");
    await Bun.sleep(200); // the ring fades out
    check("a click hides the ring again", (await ringShown()) === "0", await ringShown());

    // Enter opens the cursor's card beside the board and moves the keyboard into it.
    await js(`document.querySelector(".card.cursor")?.focus()`);
    await press.k(); // back into keyboard mode on the same column
    const target = (await active()).card!;
    await press.enter();
    const opened = await until("Enter opens the card", async () => {
      const a = await active();
      return a.pane === "pane-ticket" && (await openTickets()).includes(target) && a;
    }).catch(() => null);
    check("Enter opens the card and focus moves into its pane", !!opened, JSON.stringify(opened));

    // ⇧⌘] / ⇧⌘[ walk the tabs and wrap; a digit jumps to that tab.
    const tabs = await js<string[]>(`[...document.querySelectorAll(".pane.active .tabs [role=tab]")].map(t => t.dataset.tab ?? t.dataset.pluginTab)`);
    const t0 = (await active()).tab;
    await press.nextTab();
    const t1 = await until("next tab", async () => ((await active()).tab !== t0 ? (await active()).tab : null)).catch(() => null);
    check("⇧⌘] goes to the next tab", t1 === tabs[tabs.indexOf(t0!) + 1], `${t0} → ${t1}`);
    await press.prevTab();
    await press.prevTab();
    const wrapped = await until("wrapped", async () => ((await active()).tab === tabs.at(-1) ? true : null)).catch(() => false);
    check("⇧⌘[ wraps from the first tab to the last", wrapped === true, `${(await active()).tab} (tabs: ${tabs.join(",")})`);
    await press.two();
    check("2 jumps to the second tab", !!(await until("tab 2", async () => ((await active()).tab === tabs[1] ? true : null)).catch(() => false)), `${(await active()).tab}`);
    await js(`document.querySelector(".pane.active .tabs [aria-selected=true]").focus()`);
    await key("ArrowRight", "ArrowRight", 39);
    check("→ on a focused tab moves along the strip and keeps focus there", !!(await until("tab 3", async () => ((await active()).tab === tabs[2] && (await js<boolean>(`document.activeElement.getAttribute("role") === "tab"`)) ? true : null)).catch(() => false)));

    // ⌥⌘← back to the board lands on the same card; ⌥⌘→ returns to the ticket.
    await press.paneLeft();
    const back = await until("board again", async () => ((await active()).card ? active() : null)).catch(() => null);
    check("⌥⌘← returns to the board with the cursor where it was", back?.card === target, `${back?.card} vs ${target}`);
    await press.paneRight();
    check("⌥⌘→ goes back into the ticket pane", !!(await until("ticket pane", async () => ((await active()).pane === "pane-ticket" ? true : null)).catch(() => false)));

    // i focuses the composer; typing there moves nothing; Escape returns to the pane.
    const before = await active();
    await press.i();
    check("i focuses the composer", !!(await until("composer", async () => ((await active()).composer ? true : null)).catch(() => false)));
    for (const [ch, code] of [["h", "KeyH"], ["j", "KeyJ"], ["d", "KeyD"]] as const) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code });
    }
    const typed = await js<string>(`document.querySelector(".pane.active .composer-input").value`);
    check("typing hjd in the composer types it and moves nothing", typed.endsWith("hjd") && (await active()).tab === before.tab && (await openTickets()).includes(target), typed);
    await press.escape();
    const esc = await active();
    check("Escape in the composer returns focus to the pane (and keeps it open)", !esc.composer && esc.pane === "pane-ticket" && (await openTickets()).includes(target), JSON.stringify(esc));
    await type(".pane.active .composer-input", "");

    // The ticket's More menu: Enter opens it with the first item focused, ↓ moves, Escape returns.
    await js(`document.querySelector(".pane.active .detail-titlebar button[title=More]").focus()`);
    await press.enter();
    const inMenu = await until("menu focus", async () => ((await active()).menu ? true : null)).catch(() => false);
    const item1 = await js<string>(`document.activeElement?.textContent ?? ""`);
    await press.down();
    const item2 = await js<string>(`document.activeElement?.textContent ?? ""`);
    check("Enter on a menu button opens it with the first item focused, and ↓ moves", inMenu === true && item1 !== item2 && !!item2, `${item1} → ${item2}`);
    await press.escape();
    check(
      "Escape closes the menu and puts focus back on its button",
      !(await exists(".menu")) && (await js<boolean>(`document.activeElement?.getAttribute("title") === "More"`)) && (await openTickets()).includes(target),
    );

    // ? opens the shortcuts overlay; Escape closes it.
    await js(`document.querySelector(".pane.active [data-pane-autofocus]")?.focus()`);
    await press.question();
    const overlay = await until("shortcuts overlay", () => exists("[data-testid=shortcuts]")).catch(() => false);
    const rows = await js<number>(`document.querySelectorAll("[data-testid=shortcuts-row]").length`);
    check("? opens the keyboard shortcuts overlay, listing the registry", overlay === true && rows > 20, `${rows} rows`);
    await press.escape();
    await until("overlay closed", async () => !(await exists("[data-testid=shortcuts]")));

    // ⌘K palette: a partial key completes to the ticket; Enter opens it and focuses its pane.
    const origin = await js<string>(`document.activeElement?.outerHTML.slice(0, 80) ?? ""`);
    await press.palette();
    await until("palette", () => exists("[data-testid=palette-input]"));
    const focusInput = await js<boolean>(`document.activeElement?.matches("[data-testid=palette-input]")`);
    await press.escape();
    await until("palette closed", async () => !(await exists("[data-testid=palette]")));
    check("⌘K opens the palette with the input focused; Escape closes it and focus goes back", focusInput && (await js<string>(`document.activeElement?.outerHTML.slice(0, 80) ?? ""`)) === origin);

    const pick = "HARNESS-1";
    await press.palette();
    await until("palette", () => exists("[data-testid=palette-input]"));
    await type("[data-testid=palette-input]", "harness-1");
    const top = await until("ticket row", () => js<string | null>(`document.querySelector("[data-testid=palette-row][aria-selected=true]")?.dataset.id ?? null`).then((id) => id?.startsWith("ticket:") && id)).catch(() => null);
    check("typing part of a key autocompletes the ticket", top === `ticket:${pick}`, String(top));
    await press.enter();
    const pickedOpen = await until("picked ticket open", async () => ((await openTickets()).includes(pick) && (await active()).pane === "pane-ticket" ? true : null)).catch(() => false);
    check("Enter opens the ticket and focuses its pane", pickedOpen === true && !(await exists("[data-testid=palette]")), (await openTickets()).join(","));

    // A ticket only the server has (an old Done one) shows up after the debounce.
    await press.palette();
    await until("palette", () => exists("[data-testid=palette-input]"));
    await type("[data-testid=palette-input]", "SITE-42");
    const remote = await until("server hit", () => exists('[data-testid=palette-row][data-id="ticket:SITE-42"]'), 5000).catch(() => false);
    check("the palette finds a ticket the board hasn't loaded (server search)", remote === true);
    await press.escape();

    // Actions come from the focused ticket: "appr" on a ticket in review highlights Approve.
    const reviewKeys = await js<string[]>(`[...[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Review").querySelectorAll(".card[data-key]")].map(c => c.dataset.key)`);
    let reviewKey: string | null = null;
    for (const k of reviewKeys) if ((await api<{ ticket: { humanReview: string } }>("GET", `/tickets/${k}`)).ticket.humanReview !== "approved") reviewKey ??= k;
    if (!reviewKey) fail(), console.log("✗ no unapproved review ticket to test palette actions on");
    else {
      await js(`location.hash = "#/board/all/ticket/${reviewKey}"`);
      await until("review ticket open", async () => (await openTickets()).includes(reviewKey!));
      await js(`document.querySelector(".pane.active [data-pane-autofocus]")?.focus()`);
      await press.palette();
      await until("palette", () => exists("[data-testid=palette-input]"));
      await type("[data-testid=palette-input]", "appr");
      const hl = () => js<string | null>(`document.querySelector("[data-testid=palette-row][aria-selected=true]")?.dataset.id ?? null`);
      const approve = await until("approve row", () => hl().then((id) => id === "cmd:ticket.approve" && id)).catch(() => null);
      await press.down();
      const moved = await hl();
      await press.up();
      check("typing appr on a review ticket highlights Approve; ↓/↑ move the highlight", approve === "cmd:ticket.approve" && moved !== approve && (await hl()) === approve, `${approve} ↓ ${moved}`);
      await press.escape();
      await until("palette closed", async () => !(await exists("[data-testid=palette]")));
      check("closing the palette ran nothing", (await api<{ ticket: { humanReview: string } }>("GET", `/tickets/${reviewKey}`)).ticket.humanReview !== "approved");
    }

    // ⌘W closes the focused ticket pane (and never the board).
    const openBefore = await openTickets();
    await js(`document.querySelector(".pane.active [data-pane-autofocus]")?.focus()`);
    await press.closePane();
    const closed = await until("pane closed", async () => ((await openTickets()).length === openBefore.length - 1 ? openTickets() : null)).catch(() => null);
    check("⌘W closes the focused ticket pane", !!closed, `${openBefore.join(",")} → ${closed?.join(",")}`);

    // The sidebar: ⌥⌘← from the board goes into it, j moves, l comes back to the board.
    await setPanes(boardOnly);
    await until("board only", async () => (await openTickets()).length === 0);
    await js(`document.querySelector(".card.cursor")?.focus()`);
    await press.paneLeft();
    const side = await until("sidebar", async () => ((await active()).sidebar ? js<string>(`document.activeElement.textContent`) : null)).catch(() => null);
    await press.j();
    const side2 = await js<string>(`document.activeElement?.closest("#app-sidebar") ? document.activeElement.textContent : ""`);
    check("⌥⌘← from the board focuses the sidebar, and j moves down its items", !!side && !!side2 && side !== side2, `${side} → ${side2}`);
    await Bun.sleep(200); // the rings cross-fade
    const sidebarRing = await js<string>(`getComputedStyle(document.getElementById("app-sidebar"), "::after").opacity`);
    check("the sidebar shows the keyboard ring (and the pane's steps aside)", sidebarRing === "1" && (await ringShown()) === "0", `${sidebarRing} / ${await ringShown()}`);
    await press.l();
    check("l returns from the sidebar to the board", !!(await until("board again", async () => ((await active()).card ? true : null)).catch(() => false)));

    await setPanes(boardOnly);
  }

  // 6d. Transcript and summaries stay scrolled to the bottom until the user scrolls up, and pick
  // it back up when they return. A short window makes a few messages overflow.
  {
    const { go } = app;
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 560, deviceScaleFactor: 1, mobile: false });
    const say = (n: number) => api("POST", "/tickets/NYTIMES-1/messages", { text: `Stick check ${n}. ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10) });
    const metrics = (sel: string) =>
      js<{ top: number; gap: number; overflow: boolean }>(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
        return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), overflow: el.scrollHeight > el.clientHeight + 100 }; })()`);
    const scrollTo = (sel: string, top: string) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollTop = ${top}; })()`);
    const shows = (sel: string, text: string) => js<boolean>(`!!document.querySelector(${JSON.stringify(sel)})?.textContent.includes(${JSON.stringify(text)})`);
    const summaryCount = () => js<number>(`document.querySelectorAll(".summaries .summary").length`);

    await go("#/board/all/ticket/NYTIMES-1/transcript");
    await until("transcript", () => exists(".transcript"));
    for (let i = 1; i <= 4; i++) await say(i);
    await until("messages in the transcript", () => shows(".transcript", "Stick check 4."));
    await Bun.sleep(150);
    const filled = await metrics(".transcript");
    check("transcript follows new messages to the bottom", filled.overflow && filled.gap <= 1, JSON.stringify(filled));

    await scrollTo(".transcript", "40");
    await Bun.sleep(150);
    await say(5);
    await until("message 5", () => shows(".transcript", "Stick check 5."));
    await Bun.sleep(2800); // the mock's replies to messages 1–5 land meanwhile
    const away = await metrics(".transcript");
    check("transcript stays put while the user is scrolled up", away.top === 40, JSON.stringify(away));

    await scrollTo(".transcript", "el.scrollHeight");
    await Bun.sleep(150);
    await say(6);
    await until("message 6", () => shows(".transcript", "Stick check 6."));
    await Bun.sleep(150);
    const back = await metrics(".transcript");
    check("scrolling back to the bottom resumes following", back.gap <= 1, JSON.stringify(back));
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 460, deviceScaleFactor: 1, mobile: false });
    await Bun.sleep(300);
    const shrunk = await metrics(".transcript");
    check("a shorter window keeps a pinned transcript at the bottom", shrunk.gap <= 1, JSON.stringify(shrunk));

    await go("#/board/all/ticket/NYTIMES-1/summaries");
    await until("summaries", () => exists(".summaries .summary"));
    await Bun.sleep(3000); // message 6's summary
    const opened = await metrics(".summaries");
    check("summaries open scrolled to the newest", opened.overflow && opened.gap <= 1, JSON.stringify(opened));
    await scrollTo(".summaries", "20");
    await Bun.sleep(150);
    let before = await summaryCount();
    await say(7);
    await until("summary 7", async () => (await summaryCount()) > before, 6000);
    await Bun.sleep(150);
    const sAway = await metrics(".summaries");
    check("summaries stay put while the user is scrolled up", sAway.top === 20, JSON.stringify(sAway));
    await scrollTo(".summaries", "el.scrollHeight");
    await Bun.sleep(150);
    before = await summaryCount();
    await say(8);
    await until("summary 8", async () => (await summaryCount()) > before, 6000);
    await Bun.sleep(150);
    const sBack = await metrics(".summaries");
    check("summaries follow a new summary once back at the bottom", sBack.gap <= 1, JSON.stringify(sBack));

    await cdp("Emulation.clearDeviceMetricsOverride");
    await go("#/board/all");
  }

  // 7. Service restart: the indicator flips to reconnecting, then the app refetches everything.
  mock.kill();
  await mock.exited;
  const offline = await until("reconnecting indicator", () => js<boolean>(`!!document.querySelector(".conn.off")`));
  check("connection indicator shows reconnecting", offline);
  mock2 = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token, MOCK_QUIET: "1" },
    stdout: "ignore",
    stderr: "inherit",
  });
  {
    await until("reconnected", () => js<boolean>(`!!document.querySelector(".conn.on")`), 10000);
    // The restarted mock has fresh seed data: the ticket created in step 5 is gone after refetch.
    const gone = await until("refetch after reconnect", () =>
      js<boolean>(`location.hash = "#/board/all", ![...document.querySelectorAll(".card-key")].some(e => e.textContent === ${JSON.stringify(created.key)})`),
    );
    check("reconnect refetches the board", gone);
    const donePage = await until("done paging reset", async () => {
      const n = await js<number>(`[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Done")?.querySelectorAll(".card[data-key]").length ?? 0`);
      return n === 50 && n;
    }).catch(() => 0);
    check("reconnect resets Done paging to the first page", donePage === 50, String(donePage));
    // Project settings loads the project's done tickets itself: the rename preview spans them
    // even though the board hasn't paged them in (HELLOHARNESS-1 and -2 are old done tickets).
    const hh2 = (await api<{ id: string; key: string }[]>("GET", "/projects")).find((p) => p.key === "HELLOHARNESS")!;
    await js(`location.hash = "#/project/${hh2.id}/settings"`);
    await until("key input after reconnect", () => exists(".key-input"));
    await type(".key-input", "hel");
    const previewText = () => js<string>(`document.querySelector("[data-testid=key-preview]")?.textContent ?? ""`);
    const pv = await until("rename preview after reconnect", async () => {
      const t = await previewText();
      return t.includes("HELLOHARNESS-1…3") && t;
    }, 4000).catch(previewText);
    check("rename preview counts done tickets the board hasn't loaded", pv.includes("existing HELLOHARNESS-1…3 become HEL-1…3"), pv);
    await type(".key-input", "HELLOHARNESS");
    await js(`location.hash = "#/board/all"`);
  }

  // 8. Settings → Network: listen modes, pairing QR, bad custom host, token rotation.
  // (Last: after rotation the smoke-token no longer works.)
  {
    type S = { listen?: { mode: string; host?: string } };
    await js(`location.hash = "#/settings/network"`);
    await until("network section", () => exists("[data-testid=network-section]"));
    check("Network section renders in localhost mode", (await js<string>(`document.querySelector("[data-mode=localhost]").getAttribute("aria-checked")`)) === "true");
    const bound = await until("bound urls", () => js<string>(`document.querySelector("[data-testid=network-bound]")?.textContent ?? ""`).then((t) => t.includes("127.0.0.1") && t));
    check("shows the bound loopback URL", bound.includes(`http://127.0.0.1:${port}`), bound);
    check("Localhost mode disables pairing with an explanation", (await exists("[data-testid=pair-disabled]")) && !(await exists("[data-testid=pair-qr]")));
    const ts = await js<string>(`document.querySelector("[data-testid=network-tailscale]")?.textContent ?? ""`);
    check("shows Tailscale IP and MagicDNS name", ts.includes("100.101.102.103") && ts.includes("mock.tail.ts.net"), ts);

    await js(`document.querySelector("[data-mode=tailscale]").click()`);
    await until("listen saved as tailscale", async () => (await api<S>("GET", "/settings")).listen?.mode === "tailscale");
    const d = await until("pairing QR", () => js<string>(`document.querySelector("[data-testid=pair-qr] svg path")?.getAttribute("d") ?? ""`));
    const pairing = await api<{ url: string; token: string; pairUrl: string }>("GET", "/pairing");
    check("QR encodes exactly the pairUrl", d === qrPath(encodeQr(pairing.pairUrl), 4));
    check("pair URL is the Tailscale address", (await js<string>(`document.querySelector("[data-testid=pair-url]").textContent`)) === `http://100.101.102.103:${port}`);
    const masked = await js<string>(`document.querySelector("[data-testid=pair-token]").textContent`);
    check("token is masked", !masked.includes(token) && masked.startsWith("•") && masked.endsWith(token.slice(-4)), masked);

    await js(`document.querySelector("[data-mode=any]").click()`);
    await until("any warning", () => exists("[data-testid=network-any-warning]"));
    check("Any shows the exposure warning", true);

    await js(`document.querySelector("[data-mode=custom]").click()`);
    await until("custom host field", () => exists("[data-testid=listen-custom-host] input"));
    await type("[data-testid=listen-custom-host] input", "bad.example");
    await clickText("[data-testid=listen-custom-host] button", "Apply");
    const err = await until("custom host error", () => js<string>(`document.querySelector("[data-testid=network-error]")?.textContent ?? ""`));
    check("a non-local custom host is refused and shown", err.includes("bad.example") && (await api<S>("GET", "/settings")).listen?.mode === "any", err);

    await js(`window.confirm = () => true; document.querySelector("[data-testid=rotate-token]").click()`);
    await until("old token rejected", async () => (await fetch(base + "/projects", { headers: { authorization: `Bearer ${token}` } })).status === 401);
    check("rotation invalidates the old token", true);
    await js(`document.querySelector("[data-testid=pair-token-reveal]").click()`);
    const rotated = await until("new token shown", () => js<string>(`document.querySelector("[data-testid=pair-token]")?.textContent ?? ""`).then((t) => t && t !== token && !t.includes("•") && t));
    const api2 = makeApi(base, rotated);
    await until("socket reconnected with the new token", () => js<boolean>(`!!document.querySelector(".conn.on")`), 10000);
    await js(`document.querySelector("[data-mode=localhost]").click()`);
    const back = await until("app works after rotation", async () => (await api2<S>("GET", "/settings")).listen?.mode === "localhost");
    check("after rotation the app keeps working (switching back to Localhost saved)", back);
    check("…and pairing is disabled again", await until("pair disabled", () => exists("[data-testid=pair-disabled]")));
  }

} catch (e) {
  fail();
  console.error("✗", (e as Error).message);
} finally {
  await app?.close();
  mock.kill();
  mock2?.kill();
}
console.log(counter.failures ? `${counter.failures} check(s) failed` : "all checks passed");
process.exit(counter.failures ? 1 : 0);
