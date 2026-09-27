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
  app = await launchApp({ baseUrl: base, token, env: { HARNESS_MENU_AUTOPICK: "settings" } });
  const { cdp, js, exists, type, cmdEnter, clickText } = app;

  // 1. Board renders every column and the seeded cards.
  await until("board", () => exists(".card"), 10000);
  const cols = await js<string[]>(`[...document.querySelectorAll(".column-title")].map(e => e.textContent)`);
  check("board shows five columns", cols.join(",") === "Planning,In progress,Blocked,Review,Done", cols.join(","));

  // 1a. Child tickets are hidden by default (ones that need you stay); a plain switch shows them.
  // No "N hidden" count anywhere.
  const cardKeys = () => js<string[]>(`[...document.querySelectorAll(".card[data-key]")].map(c => c.dataset.key)`);
  const hiddenCountText = () => js<boolean>(`/\\d+\\s*hidden/i.test(document.body.innerText)`);
  const toggleState = () => js<{ checked: string | null; text: string }>(`(() => { const b = document.querySelector("[data-testid=show-children]"); return { checked: b?.getAttribute("aria-checked") ?? null, text: b?.textContent ?? "" }; })()`);
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
    const off = await toggleState();
    check("the toolbar switch reads Show child tickets, off", off.checked === "false" && off.text === "Show child tickets", JSON.stringify(off));
    check("no hidden-count text while children are hidden", !(await hiddenCountText()));
    await js(`document.querySelector("[data-testid=show-children]").click()`);
    const shownKeys = await until("children shown", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-2") && k;
    });
    check("the switch shows child tickets", ["HARNESS-2", "HARNESS-3", "HARNESS-6", "HARNESS-10"].every((k) => shownKeys.includes(k)), shownKeys.join(","));
    const on = await toggleState();
    check("…and reads on, still with no count", on.checked === "true" && on.text === "Show child tickets" && !(await hiddenCountText()), JSON.stringify(on));
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

  // 1b. Reorder within a column: drop HARNESS-2 above NYTIMES-4 in Review.
  type T = { key: string; status: string; position: number; allowedTools: string[]; pendingApproval: unknown };
  const reviewOrder = () =>
    js<string[]>(`[...[...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Review").querySelectorAll(".card-key")].map(e => e.textContent)`);
  const before = await reviewOrder();
  await js(`(() => {
    const col = [...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "Review");
    const card = [...col.querySelectorAll(".card")].find(c => c.dataset.key === "HARNESS-2");
    const target = [...col.querySelectorAll(".card")].find(c => c.dataset.key === "NYTIMES-4");
    const y = target.getBoundingClientRect().top + 4;
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  })()`);
  const reordered = await until("reorder persisted", async () => {
    const all = await api<T[]>("GET", "/tickets");
    const a = all.find((t) => t.key === "HARNESS-2")!;
    const b = all.find((t) => t.key === "NYTIMES-4")!;
    return a.position < b.position && a.status === "review";
  });
  const after = await until("reorder rendered", async () => {
    const o = await reviewOrder();
    return o[0] === "HARNESS-2" && o;
  });
  check("reorder within a column sends position", reordered && before[0] === "NYTIMES-4", `${before.join(",")} → ${after.join(",")}`);

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

  // 2. Drag NYTIMES-2 (planning) onto In progress.
  await js(`(() => {
    const card = [...document.querySelectorAll(".card")].find(c => c.querySelector(".card-key")?.textContent === "NYTIMES-2");
    const col = [...document.querySelectorAll(".column")].find(c => c.querySelector(".column-title")?.textContent === "In progress");
    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    col.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  })()`);
  const moved = await until("drag to in_progress", async () => (await api<{ ticket: { status: string } }>("GET", "/tickets/NYTIMES-2")).ticket.status === "in_progress");
  check("drag & drop updates ticket status", moved);
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
  const completeEnabled = await until("Complete enabled", () =>
    js<boolean>(`[...document.querySelectorAll(".actions button")].some(b => b.textContent.includes("Complete") && !b.disabled)`),
  );
  check("Complete enables once both reviews approve", completeEnabled);

  // 5. New session composer (⌘N path goes through the menu; use the #/compose route).
  await js(`location.hash = "#/board/all"`);
  await Bun.sleep(100);
  await js(`location.hash = "#/compose"`);
  await until("composer", () => exists(".new-session-prompt"));
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

    // Row → child; the breadcrumb leads back to the conductor's Tickets tab.
    await js(`document.querySelector('.child-row[data-key="HARNESS-6"]').click()`);
    const crumb = await until("parent crumb", () => js<string>(`location.hash.endsWith("/ticket/HARNESS-6") && document.querySelector("[data-testid=parent-crumb]")?.textContent`));
    check("child detail shows the Part of breadcrumb", crumb === "Part ofHARNESS-1Build the harness desktop app", crumb);
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
    // The Conductor badge and rollup carry it; the card has no accent edge.
    const edge = await js<{ left: string; top: string; lc: string; tc: string }>(`(() => { const cs = getComputedStyle(document.querySelector('.card[data-key="HARNESS-1"]'));
      return { left: cs.borderLeftWidth, top: cs.borderTopWidth, lc: cs.borderLeftColor, tc: cs.borderTopColor }; })()`);
    check("conductor card has no left accent border", edge.left === edge.top && edge.lc === edge.tc, JSON.stringify(edge));

    // Switch off: hides quiet children only, persists across a reload, and turns back on.
    await js(`document.querySelector("[data-testid=show-children]").click()`);
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
    await js(`document.querySelector("[data-testid=show-children]").click()`);
    const shown = await until("children shown", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-6") && k;
    });
    check("switching it back on shows every child again", ["HARNESS-2", "HARNESS-5", "HARNESS-6"].every((k) => shown.includes(k)), shown.join(","));
  }

  // 6c. Layout: collapsible + resizable sidebar, resizable ticket panel; all persisted.
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

    // Sidebar: collapse with the button; the board header clears the traffic lights and stays a drag region.
    const open = await width(".sidebar");
    await js(`document.querySelector("[data-testid=sidebar-toggle]").click()`);
    const collapsed = await until("sidebar collapsed", async () => (await width(".sidebar")) === 0 && (await js<boolean>(`document.querySelector(".sidebar").inert`)));
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

    // Ticket panel: drag its left edge across an iframe (iframes swallow pointer events without the overlay).
    await js(`location.hash = "#/board/all/ticket/NYTIMES-4"`);
    await until("detail", () => exists("[data-testid=detail-resizer]"));
    await Bun.sleep(300);
    const def = await width(".detail");
    await js(`(() => { const f = document.createElement("iframe"); f.id = "smoke-iframe"; f.srcdoc = "<body style='margin:0;background:#f0f'>";
      const x = document.querySelector("[data-testid=detail-resizer]").getBoundingClientRect().x;
      Object.assign(f.style, { position: "fixed", top: "0", left: "0", width: (x - 10) + "px", height: "100vh", border: "0", zIndex: "15", opacity: "0.01" });
      document.body.appendChild(f); })()`);
    let overlayOnTop = false;
    await drag("[data-testid=detail-resizer]", -200, async () => {
      overlayOnTop = await js<boolean>(`document.elementFromPoint(40, 300)?.dataset.testid === "resize-overlay"`);
    });
    const grown = await width(".detail");
    check("dragging over an iframe still resizes the ticket panel", grown === def + 200, `${def} → ${grown}`);
    check("a full-window overlay covers iframes mid-drag and goes away after", overlayOnTop && !(await exists(".resize-overlay")));
    await js(`document.getElementById("smoke-iframe")?.remove()`);
    check("ticket panel width is persisted", (await stored()).detailWidth === grown);
    const bounds = await js<{ max: number }>(`(() => ({ max: Math.floor(Math.min(innerWidth * 0.8, document.querySelector(".board-layout").clientWidth - 320)) }))()`);
    await drag("[data-testid=detail-resizer]", -3000);
    const maxed = await width(".detail");
    check("ticket panel stops at its maximum and the board keeps ≥320px", maxed === bounds.max && (await width(".board-pane")) >= 319, `${maxed} vs ${bounds.max}, board ${await width(".board-pane")}`);
    await drag("[data-testid=detail-resizer]", 3000);
    check("ticket panel stops at 360px", (await width(".detail")) === 360, String(await width(".detail")));
    await drag("[data-testid=detail-resizer]", -(grown - 360));
    await reload("[data-testid=detail-resizer]");
    check("ticket panel width survives a reload", (await width(".detail")) === grown, String(await width(".detail")));
    await js(`document.querySelector("[data-testid=detail-resizer]").focus()`);
    await app!.key("ArrowLeft", "ArrowLeft", 37);
    check("ArrowLeft on the panel's handle widens it", (await width(".detail")) === grown + 16);
    await app!.key("ArrowRight", "ArrowRight", 39);

    // Expand = full width; restore = the dragged width.
    await js(`document.querySelector(".detail-titlebar button[title^='Expand']").click()`);
    await until("wide", () => exists(".detail.wide"));
    const full = await width(".detail");
    check("Expand takes the full width and hides the handle", full === (await width(".main")) && !(await exists("[data-testid=detail-resizer]")), `${full}`);
    await js(`document.querySelector(".detail-titlebar button[title='Show the board']").click()`);
    await until("not wide", async () => !(await exists(".detail.wide")));
    check("restoring from Expand returns to the dragged width", (await width(".detail")) === grown, String(await width(".detail")));
    await dblclick("[data-testid=detail-resizer]");
    check("double-clicking the panel handle resets it", (await width(".detail")) === def && (await stored()).detailWidth === null, `${await width(".detail")} vs ${def}`);

    // The browser canvas follows the panel: the service gets the new viewport size.
    await js(`location.hash = "#/board/all/ticket/NYTIMES-1/browser"`);
    await until("browser stage", () => exists(".browser-canvas"));
    await Bun.sleep(600);
    await drag("[data-testid=detail-resizer]", -120);
    const stageW = await until("stage resized", async () => {
      const w = await js<number>(`Math.round(document.querySelector(".browser-stage").clientWidth)`);
      return inputs.some((l) => l.includes('"type":"resize"') && l.includes(`"width":${w}`)) && w;
    }).catch(() => 0);
    check("dragging the panel resizes the browser viewport", stageW > 0, String(stageW));
    await dblclick("[data-testid=detail-resizer]");
    await js(`location.hash = "#/board/all"`);
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
  app?.close();
  mock.kill();
  mock2?.kill();
}
console.log(counter.failures ? `${counter.failures} check(s) failed` : "all checks passed");
process.exit(counter.failures ? 1 : 0);
