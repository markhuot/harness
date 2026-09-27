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
  await type(".new-session-prompt", "Add a print stylesheet for recipe cards");
  await cmdEnter();
  const created = await until("ticket created", async () =>
    (await api<{ key: string; title: string; status: string }[]>("GET", "/tickets")).find((t) => t.title.includes("print stylesheet")),
  );
  check("composer creates and starts a ticket", created.status === "in_progress", created.key);
  const opened = await until("detail opened", () => js<string>(`location.hash`).then((h) => h.includes(created.key) && h));
  check("composer opens the new ticket", !!opened, opened);

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
    return t.attr && t;
  });
  check("theme preference survives a reload", afterReload.attr === "dark" && afterReload.pref === "dark", JSON.stringify(afterReload));
  await until("picker after reload", () => exists("[data-theme-option=system]"));
  await js(`document.querySelector("[data-theme-option=system]").click()`);

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
