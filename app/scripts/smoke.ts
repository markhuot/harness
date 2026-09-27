// End-to-end UI smoke test: boots the mock service and the built app, then drives the real
// renderer over the Chrome DevTools Protocol and checks the effects on the service's state.
//
//   bun run build && bun scripts/smoke.ts
import { join } from "node:path";
import { api as makeApi, appDir, checker, launchApp, until } from "./lib/drive";

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

try {
  // Native context menus can't be clicked over CDP; this makes them pick "Project settings…".
  app = await launchApp({ baseUrl: base, token, env: { HARNESS_MENU_AUTOPICK: "settings" } });
  const { cdp, js, exists, type, cmdEnter, clickText } = app;

  // 1. Board renders every column and the seeded cards.
  await until("board", () => exists(".card"), 10000);
  const cols = await js<string[]>(`[...document.querySelectorAll(".column-title")].map(e => e.textContent)`);
  check("board shows five columns", cols.join(",") === "Planning,In progress,Blocked,Review,Done", cols.join(","));

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

    // Toggle: hides quiet children only, persists across a reload, and turns back off.
    const cardKeys = () => js<string[]>(`[...document.querySelectorAll(".card[data-key]")].map(c => c.dataset.key)`);
    await js(`document.querySelector("[data-testid=hide-children]").click()`);
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
    check("toolbar says how many are hidden", (await js<string>(`document.querySelector("[data-testid=hidden-count]")?.textContent ?? ""`)) === "6 hidden");
    await js(`location.reload()`);
    await Bun.sleep(300);
    const afterReload = await until("board after reload", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-1") && k;
    });
    check("hide-children survives a reload", !afterReload.includes("HARNESS-6") && afterReload.includes("HARNESS-8"), afterReload.join(","));
    await js(`document.querySelector("[data-testid=hide-children]").click()`);
    const shown = await until("children shown", async () => {
      const k = await cardKeys();
      return k.includes("HARNESS-6") && k;
    });
    check("toggling off shows every child again", ["HARNESS-2", "HARNESS-5", "HARNESS-6"].every((k) => shown.includes(k)), shown.join(","));
  }

  // 7. Service restart: the indicator flips to reconnecting, then the app refetches everything.
  mock.kill();
  await mock.exited;
  const offline = await until("reconnecting indicator", () => js<boolean>(`!!document.querySelector(".conn.off")`));
  check("connection indicator shows reconnecting", offline);
  const mock2 = Bun.spawn(["bun", join(appDir, "scripts/mock-service.ts")], {
    env: { ...process.env, MOCK_PORT: String(port), MOCK_TOKEN: token, MOCK_QUIET: "1" },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    await until("reconnected", () => js<boolean>(`!!document.querySelector(".conn.on")`), 10000);
    // The restarted mock has fresh seed data: the ticket created in step 5 is gone after refetch.
    const gone = await until("refetch after reconnect", () =>
      js<boolean>(`location.hash = "#/board/all", ![...document.querySelectorAll(".card-key")].some(e => e.textContent === ${JSON.stringify(created.key)})`),
    );
    check("reconnect refetches the board", gone);
  } finally {
    mock2.kill();
  }

} catch (e) {
  fail();
  console.error("✗", (e as Error).message);
} finally {
  app?.close();
  mock.kill();
}
console.log(counter.failures ? `${counter.failures} check(s) failed` : "all checks passed");
process.exit(counter.failures ? 1 : 0);
