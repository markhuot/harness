// Browser tools: drive this session's tabs in the harness's headless Chrome.
// The human can watch (and take over) the same tabs from the app.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BROWSER_DESKTOP, BROWSER_MAX_SIDE, BROWSER_MIN_SIDE, BROWSER_MOBILE, type BrowserDevice, type BrowserSize, type ToolResultContent } from "@harness/shared";
import type { BrowserTabInfo, BrowserTabSummary } from "../browser/types";
import { WAIT_CONDITION_DOC, WAIT_CONDITION_PROPERTIES, checkCondition, type WaitCondition, type WaitResult } from "../browser/wait";
import type { ToolContext, ToolResult } from "./types";
import { defineTool, errorResult, schema } from "./util";

const DEFAULT_MAX_CHARS = 20_000;

/** The optional `tab` every browser tool takes. */
const TAB = {
  tab: {
    type: "integer",
    minimum: 1,
    description: "Tab number (from browser_open or browser_tabs). Omitted: the lowest open tab, which is tab 1 unless it was closed.",
  },
} as const;

/** The mode and size every tab reports: "desktop 1280×800", "mobile 393×852". */
const sizeText = (size: BrowserSize | undefined) => (size ? `${size.device} ${size.width}×${size.height}` : "");

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const tabLine = (tabs: BrowserTabSummary[]) =>
  tabs
    .map((t) => {
      const issues = [
        t.failedRequests ? plural(t.failedRequests, "failed request") : "",
        t.consoleErrors ? plural(t.consoleErrors, "console error") : "",
      ].filter(Boolean);
      return (
        `Tab ${t.id}: ${t.title || "(untitled)"} — ${t.url}` +
        (t.size ? ` [${sizeText(t.size)}${t.size.responsive ? ", responsive" : ""}]` : "") +
        (t.loading ? " (loading)" : "") +
        (t.suspended ? " (suspended: reloads when you use it)" : "") +
        (issues.length ? ` (${issues.join(", ")})` : "")
      );
    })
    .join("\n");

/** The device, width and height browser_open and browser_resize take. */
const SIZE = {
  device: {
    type: "string",
    enum: ["desktop", "mobile"],
    description: `"desktop": a mouse and Chrome's own user agent, ${BROWSER_DESKTOP.width}×${BROWSER_DESKTOP.height} unless width/height say otherwise. "mobile": a touch device with an iPhone user agent (touch events, pointer: coarse; clicks arrive as taps), ${BROWSER_MOBILE.width}×${BROWSER_MOBILE.height} unless width/height say otherwise.`,
  },
  width: { type: "integer", minimum: BROWSER_MIN_SIDE, maximum: BROWSER_MAX_SIDE, description: "Viewport width in CSS px. Alone, it keeps the tab's mode." },
  height: { type: "integer", minimum: BROWSER_MIN_SIDE, maximum: BROWSER_MAX_SIDE, description: "Viewport height in CSS px. Alone, it keeps the tab's mode." },
} as const;

/**
 * The wait_for every tool that acts on or reads the page takes: one condition (browser/wait.ts),
 * one description. `when` says when it runs for that tool.
 */
function waitForParam(when: "after" | "before", what: string) {
  return {
    wait_for: {
      type: "object",
      properties: WAIT_CONDITION_PROPERTIES,
      additionalProperties: false,
      description: `Wait for the page ${when === "after" ? `after ${what}, before returning` : `before ${what}`}, instead of sleeping. The condition: ${WAIT_CONDITION_DOC}`,
    },
  } as const;
}

type WaitInput = { wait_for?: unknown };

/** wait_for checked before anything happens, so a bad condition costs nothing. */
function parseWaitFor(input: WaitInput): { condition?: WaitCondition; error?: string } {
  if (input.wait_for === undefined || input.wait_for === null) return {};
  const checked = checkCondition(input.wait_for);
  return checked.ok ? { condition: checked.condition } : { error: `wait_for: ${checked.error}` };
}

/** The wait's line for a result: "Waited: …" or the timeout's report. */
const waitLine = (w: WaitResult) => (w.met ? `Waited: ${w.summary}` : w.summary);

/**
 * A tool's result with its wait folded in: the text of what it did or read, plus the wait. A wait
 * that timed out makes the result an error, but keeps what the tool did, so the agent sees both.
 */
function withWait(content: ToolResultContent[], wait: WaitResult | undefined, order: "after" | "before"): ToolResult {
  if (!wait) return { content };
  const line: ToolResultContent = { type: "text", text: waitLine(wait) };
  const out = order === "after" ? [...content, line] : [line, ...content];
  return wait.met ? { content: out } : { content: out, isError: true };
}

/** Run browser.waitFor for a tool's wait_for. */
const waitOn = (ctx: ToolContext, condition: WaitCondition | undefined, tab: number | undefined) =>
  condition ? ctx.browser.waitFor(ctx.session.id, condition, { tab }) : Promise.resolve(undefined);

const text = (t: string): ToolResultContent[] => [{ type: "text", text: t }];

type SizeInput = { device?: BrowserDevice; width?: number; height?: number };
const sizeChange = ({ device, width, height }: SizeInput) =>
  device === undefined && width === undefined && height === undefined ? undefined : { device, width, height };

/** One tab in full, for browser_tabs { tab }. */
function tabReport(t: BrowserTabInfo): string {
  const lines = [`Tab ${t.id}: ${t.title || "(untitled)"} — ${t.url}`];
  const state = t.suspended ? "suspended (its page is closed; it reloads when you use it)" : t.loading ? "loading" : "loaded";
  lines.push(`State: ${state}`);
  lines.push(
    `Size: ${sizeText(t.size)} (${t.size.device === "mobile" ? "touch, iPhone user agent" : "mouse"})` +
      (t.size.responsive
        ? t.following
          ? ", following a human's pane (Responsive): it changes when they resize their window; browser_resize sets a size that holds still"
          : ", Responsive: it takes the size of the next human pane that opens it; browser_resize sets a size that holds still"
        : ""),
  );
  if (t.scroll) lines.push(`Scroll: ${t.scroll.x}, ${t.scroll.y}`);
  if (t.suspended) return lines.join("\n");
  const bad = t.requests.filter((r) => (r.failure !== undefined && r.failure !== "canceled") || (r.status ?? 0) >= 400);
  const rest = t.requests.filter((r) => !bad.includes(r));
  const req = (r: BrowserTabInfo["requests"][number]) =>
    `  ${r.method} ${r.url} ${r.type} ${r.failure ?? r.status ?? "pending"}${r.durationMs !== undefined ? ` ${r.durationMs} ms` : ""}`;
  lines.push("", `Network requests since the page loaded (${t.requests.length}; failed ones first):`);
  lines.push(...(t.requests.length ? [...bad, ...rest].map(req) : ["  none"]));
  lines.push("", `Console errors and warnings (${t.console.length}):`);
  lines.push(...(t.console.length ? t.console.map((c) => `  ${c.level}: ${c.text}${c.source ? ` (${c.source})` : ""}`) : ["  none"]));
  return lines.join("\n");
}

export const browserOpen = defineTool<{ url: string; tab?: number; new_tab?: boolean } & SizeInput & WaitInput>({
  name: "browser_open",
  description:
    "Open a URL in this session's browser and wait for it to load. The human can watch it live. new_tab opens it in a new tab, so several pages stay open at once; the result names the tab, and you pass that number as tab to the other browser tools. Sub-agents sharing this browser should each open their own tab and use only it. Close a tab with browser_close_tab when you're done with it. Each tab has its own mode and size (new tabs: desktop, following the size of a human's pane while one has the tab open, 1280×800 otherwise); device, width and height set a size that holds still, before the page loads, e.g. new_tab with device \"mobile\" to check a phone layout. Pass wait_for to wait, after the load, for what the page fills in by script. Returns the tab, final URL, page title and size; use browser_content to read the page.",
  inputSchema: schema(
    {
      url: { type: "string", minLength: 1, description: "Absolute URL, e.g. \"http://localhost:3000/login\"." },
      ...TAB,
      new_tab: { type: "boolean", description: "Open a new tab for this URL instead of navigating an existing one." },
      ...SIZE,
      ...waitForParam("after", "it loads"),
    },
    ["url"],
  ),
  async run({ url, tab, new_tab, wait_for, ...size }, ctx) {
    if (new_tab && tab !== undefined) return errorResult("Pass tab or new_tab, not both.");
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const change = sizeChange(size);
    const state = await ctx.browser.open(ctx.session.id, url, { tab, newTab: new_tab ?? false, ...(change ? { size: change } : {}) });
    const waited = await waitOn(ctx, wait.condition, state.tabId);
    const opened = `Opened ${waited?.url ?? state.url} in tab ${state.tabId}\nTitle: ${state.title || "(untitled)"}${state.size ? `\nSize: ${sizeText(state.size)}` : ""}`;
    return withWait(text(opened), waited, "after");
  },
});

export const browserTabs = defineTool<{ tab?: number }>({
  name: "browser_tabs",
  description:
    "List this session's browser tabs: number, title, URL, mode and size of each, and how many failed requests and console errors its page has. With tab, report that one tab in full: its state, mode and size, scroll position, the network requests since its page loaded (failed ones first) and its console errors and warnings. A suspended tab's page was closed to save memory; using it reloads its URL (browser_tabs doesn't).",
  inputSchema: schema({ tab: { type: "integer", minimum: 1, description: "Report this tab in full instead of listing them all." } }),
  async run({ tab }, ctx) {
    if (tab !== undefined) return tabReport(await ctx.browser.tabInfo(ctx.session.id, tab));
    const tabs = await ctx.browser.tabs(ctx.session.id);
    return tabs.length ? tabLine(tabs) : "No tabs are open. browser_open opens tab 1.";
  },
});

export const browserResize = defineTool<{ tab?: number } & SizeInput & WaitInput>({
  name: "browser_resize",
  description:
    "Change a tab's mode and size. device alone resets the tab to that mode's size and reloads the page (so the server sees the new user agent too), like the Desktop | Mobile buttons the human has; width and height alone resize it without a reload, keeping its mode; together they set both, e.g. device \"mobile\" at 1024×1366 for a tablet. Either way the size then holds still: the tab stops following a human's pane (Responsive), which new tabs do. Resize the tabs you opened or navigated; leave a tab another agent is using alone unless it was handed to you or the human asks. Pass wait_for to wait for the layout to change (a mobile menu, say) before returning.",
  inputSchema: schema({ ...SIZE, ...TAB, ...waitForParam("after", "resizing") }),
  async run({ tab, wait_for, ...size }, ctx) {
    const change = sizeChange(size);
    if (!change) return errorResult("Pass device, width or height.");
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const state = await ctx.browser.resize(ctx.session.id, change, { tab });
    const waited = await waitOn(ctx, wait.condition, state.tabId);
    return withWait(text(`Tab ${state.tabId} is ${sizeText(state.size)}${change.device ? " (reloaded)" : ""}: ${waited?.url ?? state.url}`), waited, "after");
  },
});

export const browserCloseTab = defineTool<{ tab: number }>({
  name: "browser_close_tab",
  description: "Close a browser tab you opened and no longer need. It's removed for good (a suspended tab too). Tab numbers aren't reused.",
  inputSchema: schema({ tab: { ...TAB.tab, description: "Number of the tab to close." } }, ["tab"]),
  async run({ tab }, ctx) {
    await ctx.browser.closeTab(ctx.session.id, tab);
    const left = await ctx.browser.tabs(ctx.session.id);
    return `Closed tab ${tab}.${left.length ? `\nOpen tabs:\n${tabLine(left)}` : " No tabs are open."}`;
  },
});

export const browserContent = defineTool<{ selector?: string; format?: "text" | "html"; max_chars?: number; tab?: number } & WaitInput>({
  name: "browser_content",
  description:
    "Read the current page. format \"text\" (default) returns visible text; \"html\" returns markup. With a CSS selector, returns the content of every matching element. Output is capped at max_chars. Pass wait_for to wait for the page to settle (a spinner gone, a result shown) before reading.",
  inputSchema: schema({
    selector: { type: "string", description: "CSS selector to scope the content, e.g. \"main\" or \"#results li\"." },
    format: { type: "string", enum: ["text", "html"], description: "\"text\" (default) or \"html\"." },
    max_chars: { type: "integer", minimum: 1, description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}).` },
    ...TAB,
    ...waitForParam("before", "reading it"),
  }),
  async run({ selector, format, max_chars, tab, wait_for }, ctx) {
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const waited = await waitOn(ctx, wait.condition, tab);
    const read = () =>
      ctx.browser.content(ctx.session.id, {
        selector,
        format: format ?? "text",
        maxChars: max_chars ?? DEFAULT_MAX_CHARS,
        tab,
      });
    // A timed-out wait still reads the page as it is, so the agent sees where it got stuck.
    const content = waited && !waited.met ? await read().catch((e) => `(couldn't read the page: ${(e as Error).message})`) : await read();
    return withWait(text(content === "" ? "(the page has no content)" : content), waited, "before");
  },
});

export const browserClick = defineTool<{ selector: string; tab?: number } & WaitInput>({
  name: "browser_click",
  description:
    "Click the first element matching a CSS selector. It returns once a navigation the click starts has loaded, but not for a page that updates by script: pass wait_for to wait for the page to react (e.g. { idle: true }, or { selector: \".spinner\", state: \"gone\" }) before returning, instead of sleeping.",
  inputSchema: schema(
    { selector: { type: "string", minLength: 1, description: "CSS selector of the element to click." }, ...TAB, ...waitForParam("after", "clicking") },
    ["selector"],
  ),
  async run({ selector, tab, wait_for }, ctx) {
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const report = await ctx.browser.click(ctx.session.id, selector, { tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    const state = waited ? null : await ctx.browser.state(ctx.session.id, { tab });
    const url = waited?.url ?? state?.url;
    const why = [report.disabled ? "disabled" : "", report.busy ? "inside an element marked aria-busy" : ""].filter(Boolean).join(" and ");
    const clicked =
      `Clicked ${selector}${url ? `. Now at ${url}` : "."}` +
      (why ? `\nIt was ${why}, so the page may have ignored the click: wait for it to be ready (wait_for { selector, state: "enabled" }) and click again.` : "");
    return withWait(text(clicked), waited, "after");
  },
});

export const browserType = defineTool<{ selector: string; text: string; submit?: boolean; tab?: number } & WaitInput>({
  name: "browser_type",
  description:
    "Focus the element matching a CSS selector and type text into it. Set submit to press Enter afterwards (e.g. to submit a form). Pass wait_for to wait for the page to react (results shown, the next page loaded) before returning.",
  inputSchema: schema(
    {
      selector: { type: "string", minLength: 1, description: "CSS selector of an input, textarea or contenteditable element." },
      text: { type: "string", description: "Text to type." },
      submit: { type: "boolean", description: "Press Enter after typing." },
      ...TAB,
      ...waitForParam("after", "typing"),
    },
    ["selector", "text"],
  ),
  async run({ selector, text: typed, submit, tab, wait_for }, ctx) {
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    await ctx.browser.type(ctx.session.id, selector, typed, { submit: submit ?? false, tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    return withWait(text(submit ? `Typed into ${selector} and pressed Enter.` : `Typed into ${selector}.`), waited, "after");
  },
});

export const browserEval = defineTool<{ expression: string; tab?: number } & WaitInput>({
  name: "browser_eval",
  description:
    "Evaluate a JavaScript expression in the page and return its JSON-serialized result (objects as JSON, elements as \"tag#id.class\"). Promises are awaited. Pass wait_for to wait for the page before evaluating. The expression runs inside the page, so a navigation or reload ends it: for steps that span a reload (click, wait, click again), or loops, use browser_run, not an in-page loop.",
  inputSchema: schema(
    {
      expression: { type: "string", minLength: 1, description: "JavaScript expression, e.g. \"document.querySelectorAll('a').length\"." },
      ...TAB,
      ...waitForParam("before", "evaluating"),
    },
    ["expression"],
  ),
  async run({ expression, tab, wait_for }, ctx) {
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const waited = await waitOn(ctx, wait.condition, tab);
    if (!waited) return await ctx.browser.evaluate(ctx.session.id, expression, { tab });
    const value = waited.met ? await ctx.browser.evaluate(ctx.session.id, expression, { tab }) : await ctx.browser.evaluate(ctx.session.id, expression, { tab }).catch((e) => `(couldn't evaluate: ${(e as Error).message})`);
    return withWait(text(value), waited, "before");
  },
});

export const browserWait = defineTool<WaitCondition & { tab?: number }>({
  name: "browser_wait",
  description:
    `Wait until a condition holds in a tab: the same wait the wait_for param of browser_open, browser_click, browser_type, browser_resize, browser_screenshot, browser_content and browser_eval runs, without an action. Use it for pages that change on their own (a redirect after paying, a status a webhook updates, a script still filling the page) instead of sleeping. The condition: ${WAIT_CONDITION_DOC} Returns what matched and how long it took; a timeout is an error that says what the page was doing (loading, busy, requests in flight, console errors).`,
  inputSchema: schema({ ...WAIT_CONDITION_PROPERTIES, ...TAB }),
  async run({ tab, ...condition }, ctx) {
    const checked = checkCondition(condition);
    if (!checked.ok) return errorResult(checked.error);
    const waited = await ctx.browser.waitFor(ctx.session.id, checked.condition, { tab });
    return waited.met ? `Waited: ${waited.summary}` : errorResult(waited.summary);
  },
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * `path` with its deepest existing ancestor (or itself) resolved through symlinks. A dangling
 * symlink counts as existing and fails, since writing through it could land anywhere.
 */
function realTarget(path: string): string {
  const rest: string[] = [];
  let dir = path;
  while (!lexists(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    rest.unshift(basename(dir));
    dir = parent;
  }
  try {
    return join(realpathSync(dir), ...rest);
  } catch {
    throw new Error(`Can't save the screenshot to ${path}: ${dir} is a symlink that points nowhere.`);
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Where browser_screenshot's save_to may write. The real path (symlinks resolved) has to be under
 * the run's scratch folder, or under its working directory unless the run is read-only; in a
 * read-only run a relative path resolves under the scratch folder. An existing file is only
 * replaced when it is already a PNG. Throws, before anything is written, when the path isn't allowed.
 */
export function resolveSaveTo(saveTo: string, scope: { cwd: string; scratchDir: string; readOnly: boolean }): string {
  mkdirSync(scope.scratchDir, { recursive: true });
  const base = scope.readOnly ? scope.scratchDir : scope.cwd;
  const target = realTarget(isAbsolute(saveTo) ? resolve(saveTo) : resolve(base, saveTo));
  const scratch = realpathSync(scope.scratchDir);
  const roots = scope.readOnly ? [scratch] : [scratch, realTarget(resolve(scope.cwd))];
  if (!roots.some((root) => inside(root, target))) {
    const where = scope.readOnly
      ? `this run is read-only, so screenshots go in its scratch folder ${scratch} (a relative save_to lands there)`
      : `save_to must be inside your working directory ${scope.cwd} or the scratch folder ${scratch}`;
    throw new Error(`Can't save the screenshot to ${saveTo}: ${where}.`);
  }
  if (existsSync(target)) {
    if (statSync(target).isDirectory()) throw new Error(`Can't save the screenshot to ${saveTo}: it is a folder.`);
    const fd = openSync(target, "r");
    const head = Buffer.alloc(PNG_MAGIC.length);
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    if (!head.equals(PNG_MAGIC)) throw new Error(`Can't save the screenshot to ${saveTo}: a file that isn't a PNG is already there.`);
  }
  return target;
}

export const browserScreenshot = defineTool<{ save_to?: string; tab?: number } & WaitInput>({
  name: "browser_screenshot",
  description:
    "Take a PNG screenshot of the current viewport. With save_to, also write the PNG to a file, so you can show it in the spec as ![What it shows](path) with edit_spec or update_spec. Pass wait_for so it captures the finished page, not a spinner: it waits before capturing (and still captures on a timeout, showing where the page got stuck).",
  inputSchema: schema({
    save_to: {
      type: "string",
      minLength: 1,
      description:
        "Also save the PNG here, e.g. \"screenshots/after.png\". It must be inside your working directory or this run's scratch folder, and a relative path resolves against the working directory. In read-only runs (plan, review, or a read-only ticket) only the scratch folder is allowed and relative paths resolve there. Parent folders are created; an existing file is replaced only if it is a PNG.",
    },
    ...TAB,
    ...waitForParam("before", "capturing"),
  }),
  async run({ save_to, tab, wait_for }, ctx) {
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    // Check the path before taking the shot, so a refused save_to costs nothing.
    const scope = save_to ? await ctx.ops.fileOutputScope(ctx) : null;
    const path = save_to && scope ? resolveSaveTo(save_to, { cwd: ctx.cwd, ...scope }) : null;
    const waited = await waitOn(ctx, wait.condition, tab);
    const data = await ctx.browser.screenshot(ctx.session.id, { tab });
    const content: ToolResultContent[] = [{ type: "image", data, mimeType: "image/png" }];
    if (path && scope) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
      const inScratch = inside(realpathSync(scope.scratchDir), path);
      content.push({ type: "text", text: `Saved the screenshot to ${path}${inScratch ? " (this run's scratch folder)" : ""}` });
    }
    return withWait(content, waited, "before");
  },
});
