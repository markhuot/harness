// Browser tools: drive this session's tabs in the harness's headless Chrome.
// The human can watch (and take over) the same tabs from the app.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BROWSER_DESKTOP, BROWSER_MAX_SIDE, BROWSER_MIN_SIDE, BROWSER_MOBILE, type BrowserDevice, type BrowserSize, type ToolResultContent } from "@harness/shared";
import { type FrameError, frameChain, frameLabel } from "../browser/frames";
import { SNAPSHOT_DEFAULT_MAX_NODES } from "../browser/snapshot";
import { MAX_SCREENSHOT_HEIGHT, type BrowserTabInfo, type BrowserTabSummary, type ElementTarget, type FrameSpec } from "../browser/types";
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

/** The frame the element and read tools take: which iframe they act in. */
const FRAME = {
  frame: {
    anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }],
    description:
      "Act inside an iframe (an embedded checkout like Stripe's card fields, a widget, a 3-D Secure challenge): a CSS selector for the <iframe> element, e.g. \"iframe[name^=__privateStripeFrame]\", or an array of them for nested frames, outermost first. Cross-origin iframes work too. browser_content lists a page's iframes with a selector for each. Omitted: the page itself.",
  },
} as const;

/** The ref the element tools take in place of selector. */
const REF = {
  ref: {
    type: "string",
    minLength: 1,
    description: "An element's ref from browser_snapshot (e.g. \"e12\"), in place of selector. A ref already knows its frame, so don't pass frame with it.",
  },
} as const;

type TargetInput = { selector?: string; ref?: string; frame?: FrameSpec };

/** The element a tool's selector or ref names; an error message when the input doesn't name one. */
function targetOf({ selector, ref, frame }: TargetInput): { target: ElementTarget; label: string } | { error: string } {
  if ((selector === undefined) === (ref === undefined)) return { error: "Pass selector or ref (one of them)." };
  if (ref !== undefined) {
    if (frame !== undefined) return { error: "A ref already knows its frame: pass ref without frame." };
    return { target: { ref }, label: `ref ${ref}` };
  }
  let chain: string[] | undefined;
  try {
    chain = frame === undefined ? undefined : frameChain(frame);
  } catch (e) {
    return { error: (e as FrameError).message };
  }
  return {
    target: chain ? { selector: selector!, frame: chain } : selector!,
    label: `${selector}${chain ? ` in frame ${frameLabel(chain)}` : ""}`,
  };
}

/** A frame param checked and normalized; an error message when it's malformed. */
function frameOf(frame: unknown): { frame?: string[]; error?: string } {
  if (frame === undefined || frame === null) return {};
  try {
    return { frame: frameChain(frame) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

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
    "List this session's browser tabs: number, title, URL, mode and size of each, and how many failed requests and console errors its page has. With tab, report that one tab in full: its state, mode and size, scroll position, the network requests since its page loaded (failed ones first) and its console errors and warnings. Pages a tab opens itself (a target=\"_blank\" link, window.open) arrive as new tabs. Tabs last between runs, but their pages don't: a tab nobody has used for a few minutes (unless the human has it open in the app), and every tab of a done ticket, is suspended. A suspended tab's page was closed to save memory; using it reloads its URL as a fresh page (browser_tabs doesn't), so don't count on what was only in the page (form input, scroll position, script state).",
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
    "Change a tab's mode and size. device alone resets the tab to that mode's size and reloads the page (so the server sees the new user agent too), like the Desktop | Mobile buttons the human has; width and height alone resize it without a reload, keeping its mode; together they set both, e.g. device \"mobile\" at 1024×1366 for a tablet. Either way the size then holds still: the tab stops following a human's pane (Responsive), which new tabs do. Resize the tabs you opened or navigated (tab 1 too, if it was empty when you started); leave a tab another agent is using alone unless it was handed to you or the human asks. Pass wait_for to wait for the layout to change (a mobile menu, say) before returning.",
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
  description:
    "Close a browser tab you opened and no longer need: every open page keeps running in Chrome, so close each one as soon as you're done with it, and leave one open only when the human should look at it (a page you point to when you submit or block). It's removed for good (a suspended tab too). Tab numbers aren't reused.",
  inputSchema: schema({ tab: { ...TAB.tab, description: "Number of the tab to close." } }, ["tab"]),
  async run({ tab }, ctx) {
    await ctx.browser.closeTab(ctx.session.id, tab);
    const left = await ctx.browser.tabs(ctx.session.id);
    return `Closed tab ${tab}.${left.length ? `\nOpen tabs:\n${tabLine(left)}` : " No tabs are open."}`;
  },
});

export const browserContent = defineTool<{ selector?: string; format?: "text" | "html"; max_chars?: number; frame?: FrameSpec; tab?: number } & WaitInput>({
  name: "browser_content",
  description:
    "Read the current page, or with frame an iframe in it. format \"text\" (default) returns visible text; \"html\" returns markup. With a CSS selector, returns the content of every matching element. Output is capped at max_chars. An iframe's content isn't part of its page's: the result ends with the iframes it holds and the frame to pass for each. Pass wait_for to wait for the page to settle (a spinner gone, a result shown) before reading.",
  inputSchema: schema({
    selector: { type: "string", description: "CSS selector to scope the content, e.g. \"main\" or \"#results li\"." },
    format: { type: "string", enum: ["text", "html"], description: "\"text\" (default) or \"html\"." },
    max_chars: { type: "integer", minimum: 1, description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}).` },
    ...FRAME,
    ...TAB,
    ...waitForParam("before", "reading it"),
  }),
  async run({ selector, format, max_chars, frame: rawFrame, tab, wait_for }, ctx) {
    const frame = frameOf(rawFrame);
    if (frame.error) return errorResult(frame.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const waited = await waitOn(ctx, wait.condition, tab);
    const read = () =>
      ctx.browser.content(ctx.session.id, {
        selector,
        frame: frame.frame,
        format: format ?? "text",
        maxChars: max_chars ?? DEFAULT_MAX_CHARS,
        tab,
      });
    // A timed-out wait still reads the page as it is, so the agent sees where it got stuck.
    const content = waited && !waited.met ? await read().catch((e) => `(couldn't read the page: ${(e as Error).message})`) : await read();
    return withWait(text(content === "" ? "(the page has no content)" : content), waited, "before");
  },
});

export const browserClick = defineTool<TargetInput & { tab?: number } & WaitInput>({
  name: "browser_click",
  description:
    "Click an element: the first match of a CSS selector (inside an iframe with frame), or a ref from browser_snapshot. It's a real mouse click (a tap on a mobile tab) where the element is on screen, so it works on elements inside cross-origin iframes too. It returns once a navigation the click starts has loaded, but not for a page that updates by script: pass wait_for to wait for the page to react (e.g. { idle: true }, or { selector: \".spinner\", state: \"gone\" }) before returning, instead of sleeping. A click on something disabled or inside [aria-busy] says so: wait for { selector, state: \"enabled\" } and click again.",
  inputSchema: schema({
    selector: { type: "string", minLength: 1, description: "CSS selector of the element to click." },
    ...REF,
    ...FRAME,
    ...TAB,
    ...waitForParam("after", "clicking"),
  }),
  async run({ selector, ref, frame, tab, wait_for }, ctx) {
    const t = targetOf({ selector, ref, frame });
    if ("error" in t) return errorResult(t.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const report = await ctx.browser.click(ctx.session.id, t.target, { tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    const state = waited ? null : await ctx.browser.state(ctx.session.id, { tab });
    const url = waited?.url ?? state?.url;
    const why = [report.disabled ? "disabled" : "", report.busy ? "inside an element marked aria-busy" : ""].filter(Boolean).join(" and ");
    const clicked =
      `Clicked ${t.label}${url ? `. Now at ${url}` : "."}` +
      (why ? `\nIt was ${why}, so the page may have ignored the click: wait for it to be ready (wait_for { selector, state: "enabled" }) and click again.` : "");
    return withWait(text(clicked), waited, "after");
  },
});

export const browserType = defineTool<TargetInput & { text: string; submit?: boolean; tab?: number } & WaitInput>({
  name: "browser_type",
  description:
    "Focus an element (a CSS selector's first match, inside an iframe with frame, or a ref from browser_snapshot) and type text into it, replacing what's there. Use frame for fields inside iframes, such as a Stripe card number. Set submit to press Enter afterwards (e.g. to submit a form). Pass wait_for to wait for the page to react (results shown, the next page loaded) before returning. For keys like Tab or Escape, or a field that only reacts to key presses, use browser_keys.",
  inputSchema: schema(
    {
      selector: { type: "string", minLength: 1, description: "CSS selector of an input, textarea or contenteditable element." },
      ...REF,
      ...FRAME,
      text: { type: "string", description: "Text to type." },
      submit: { type: "boolean", description: "Press Enter after typing." },
      ...TAB,
      ...waitForParam("after", "typing"),
    },
    ["text"],
  ),
  async run({ selector, ref, frame, text: typed, submit, tab, wait_for }, ctx) {
    const t = targetOf({ selector, ref, frame });
    if ("error" in t) return errorResult(t.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    await ctx.browser.type(ctx.session.id, t.target, typed, { submit: submit ?? false, tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    return withWait(text(submit ? `Typed into ${t.label} and pressed Enter.` : `Typed into ${t.label}.`), waited, "after");
  },
});

export const browserKeys = defineTool<{ text?: string; keys?: string[]; per_key?: boolean; tab?: number } & WaitInput>({
  name: "browser_keys",
  description:
    "Send keyboard input to whatever has focus, in whichever frame holds it: text, then keys. Click or type into a field first to focus it. Use it for keyboard navigation (Tab to the next field, Escape to close a dialog, ArrowDown and Enter in a list) and shortcuts; to fill a field, browser_type with selector or ref is simpler. text goes in as one insert, like a paste; per_key types it one key press at a time (keydown, keypress, keyup per character), for fields that format as you type or only listen for key events. Pass wait_for to wait for the page to react before returning.",
  inputSchema: schema({
    text: { type: "string", minLength: 1, description: "Text to type into the focused element." },
    keys: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      description:
        "Keys to press after the text, in order. Each is a key or a chord: \"Tab\", \"Shift+Tab\", \"Enter\", \"Escape\", \"Backspace\", \"Delete\", \"ArrowDown\", \"Home\", \"PageDown\", \"Space\", \"F5\", a single character, or modifiers joined with + (Shift, Control, Alt, Meta), e.g. \"Meta+a\".",
    },
    per_key: { type: "boolean", description: "Type text one key press at a time instead of inserting it at once." },
    ...TAB,
    ...waitForParam("after", "typing"),
  }),
  async run({ text: typed, keys, per_key, tab, wait_for }, ctx) {
    if (!typed && !keys?.length) return errorResult("Pass text or keys.");
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    await ctx.browser.keys(ctx.session.id, { text: typed, keys, perKey: per_key ?? false }, { tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    const did = [typed ? `Typed ${JSON.stringify(typed)}${per_key ? " key by key" : ""}` : "", keys?.length ? `pressed ${keys.join(", ")}` : ""].filter(Boolean).join(", then ");
    return withWait(text(`${did[0]!.toUpperCase()}${did.slice(1)}.`), waited, "after");
  },
});

/** One value or several, as a list. */
const list = <T>(v: T | T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

export const browserSelect = defineTool<TargetInput & { value?: string | string[]; label?: string | string[]; index?: number | number[]; tab?: number } & WaitInput>({
  name: "browser_select",
  description:
    "Pick an option in a native <select> (a CSS selector's first match, inside an iframe with frame, or a ref from browser_snapshot), by value, label (its visible text) or index, and fire input and change as a person choosing it would. Several values pick several options of a multiple select. When nothing matches it lists the options. For a custom dropdown (not a <select>), click it, then click its option.",
  inputSchema: schema({
    selector: { type: "string", minLength: 1, description: "CSS selector of the <select>." },
    ...REF,
    ...FRAME,
    value: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1 }],
      description: "The option's value attribute, or several for a multiple select.",
    },
    label: {
      anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }],
      description: "The option's visible text (exact, else ignoring case), or several.",
    },
    index: {
      anyOf: [{ type: "integer", minimum: 0 }, { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1 }],
      description: "The option's position, from 0, or several.",
    },
    ...TAB,
    ...waitForParam("after", "choosing"),
  }),
  async run({ selector, ref, frame, value, label, index, tab, wait_for }, ctx) {
    const t = targetOf({ selector, ref, frame });
    if ("error" in t) return errorResult(t.error);
    if ([value, label, index].filter((v) => v !== undefined).length !== 1) return errorResult("Pass one of value, label or index.");
    const indexes = list(index);
    if (indexes?.some((i) => !Number.isInteger(i) || i < 0)) return errorResult("index is a whole number from 0.");
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const picked = await ctx.browser.select(ctx.session.id, t.target, { values: list(value)?.map(String), labels: list(label), indexes }, { tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    return withWait(text(`Selected ${picked.map((p) => JSON.stringify(p)).join(", ")} in ${t.label}.`), waited, "after");
  },
});

export const browserUpload = defineTool<TargetInput & { paths: string[]; tab?: number } & WaitInput>({
  name: "browser_upload",
  description:
    "Set files on a file input (a CSS selector's first match, inside an iframe with frame, or a ref from browser_snapshot), as choosing them in the file dialog would; the page gets its change event. Point it at the <input type=file>, even a hidden one, or at the button that opens the file dialog. Files must be inside your working directory or this run's scratch folder.",
  inputSchema: schema(
    {
      selector: { type: "string", minLength: 1, description: "CSS selector of the file input, or of the button that opens the file dialog." },
      ...REF,
      ...FRAME,
      paths: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: "Files to upload: paths inside your working directory or the scratch folder (relative ones resolve against the working directory). Several only for a multiple input.",
      },
      ...TAB,
      ...waitForParam("after", "uploading"),
    },
    ["paths"],
  ),
  async run({ selector, ref, frame, paths, tab, wait_for }, ctx) {
    const t = targetOf({ selector, ref, frame });
    if ("error" in t) return errorResult(t.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const scope = await ctx.ops.fileOutputScope(ctx);
    const files = resolveUploadPaths(paths, { cwd: ctx.cwd, scratchDir: scope.scratchDir });
    const via = await ctx.browser.upload(ctx.session.id, t.target, files, { tab });
    const waited = await waitOn(ctx, wait.condition, tab);
    const names = files.map((f) => basename(f)).join(", ");
    return withWait(text(`Uploaded ${names} to ${t.label}${via === "chooser" ? " (through the file dialog it opened)" : ""}.`), waited, "after");
  },
});

export const browserSnapshot = defineTool<{ frame?: FrameSpec; max_nodes?: number; tab?: number } & WaitInput>({
  name: "browser_snapshot",
  description:
    `The page's accessibility tree as text: one line per element with its role, name, value and state (focused, disabled, checked, expanded…), and a ref like [ref=e12] that browser_click, browser_type, browser_select, browser_upload and browser_screenshot take in place of selector. Iframes, cross-origin ones included, show their own tree nested under them, and their refs work the same, so you don't need a selector or frame for them. Use it to find what to act on when the page's markup is unknown or messy. A ref lasts until its frame navigates or reloads; then take a new snapshot. Shows at most max_nodes nodes (default ${SNAPSHOT_DEFAULT_MAX_NODES}); frame snapshots just one iframe. Pass wait_for to wait for the page before reading it.`,
  inputSchema: schema({
    ...FRAME,
    max_nodes: { type: "integer", minimum: 1, description: `Most nodes to show (default ${SNAPSHOT_DEFAULT_MAX_NODES}).` },
    ...TAB,
    ...waitForParam("before", "reading it"),
  }),
  async run({ frame: rawFrame, max_nodes, tab, wait_for }, ctx) {
    const frame = frameOf(rawFrame);
    if (frame.error) return errorResult(frame.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const waited = await waitOn(ctx, wait.condition, tab);
    const read = () => ctx.browser.snapshot(ctx.session.id, { frame: frame.frame, maxNodes: max_nodes, tab });
    const tree = waited && !waited.met ? await read().catch((e) => `(couldn't read the page: ${(e as Error).message})`) : await read();
    return withWait(text(tree), waited, "before");
  },
});

export const browserEval = defineTool<{ expression: string; frame?: FrameSpec; tab?: number } & WaitInput>({
  name: "browser_eval",
  description:
    "Evaluate a JavaScript expression in the page (or with frame, in an iframe's document) and return its JSON-serialized result (objects as JSON, elements as \"tag#id.class\"). Promises are awaited. Pass wait_for to wait for the page before evaluating. The expression runs inside the page, so a navigation or reload ends it: for steps that span a reload (click, wait, click again), or loops, use browser_run, not an in-page loop.",
  inputSchema: schema(
    {
      expression: { type: "string", minLength: 1, description: "JavaScript expression, e.g. \"document.querySelectorAll('a').length\"." },
      ...FRAME,
      ...TAB,
      ...waitForParam("before", "evaluating"),
    },
    ["expression"],
  ),
  async run({ expression, frame: rawFrame, tab, wait_for }, ctx) {
    const frame = frameOf(rawFrame);
    if (frame.error) return errorResult(frame.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    const waited = await waitOn(ctx, wait.condition, tab);
    const evaluate = () => ctx.browser.evaluate(ctx.session.id, expression, { tab, frame: frame.frame });
    if (!waited) return await evaluate();
    const value = waited.met ? await evaluate() : await evaluate().catch((e) => `(couldn't evaluate: ${(e as Error).message})`);
    return withWait(text(value), waited, "before");
  },
});

export const browserWait = defineTool<WaitCondition & { tab?: number }>({
  name: "browser_wait",
  description:
    `Wait until a condition holds in a tab: the same wait the wait_for param of browser_open, browser_click, browser_type, browser_keys, browser_select, browser_upload, browser_resize, browser_screenshot, browser_snapshot, browser_content and browser_eval runs, without an action. Use it for pages that change on their own (a redirect after paying, a status a webhook updates, a script still filling the page) instead of sleeping. The condition: ${WAIT_CONDITION_DOC} Returns what matched and how long it took; a timeout is an error that says what the page was doing (loading, busy, requests in flight, console errors).`,
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

/**
 * The files browser_upload may send, as real paths: each one has to exist, be a file, and be under
 * the run's working directory or its scratch folder (symlinks resolved, so a link can't reach out).
 * Throws, before anything is sent, naming the first path that isn't allowed.
 */
export function resolveUploadPaths(paths: string[], scope: { cwd: string; scratchDir: string }): string[] {
  const roots = [scope.cwd, scope.scratchDir].filter((r) => existsSync(r)).map((r) => realpathSync(r));
  return paths.map((p) => {
    const abs = isAbsolute(p) ? resolve(p) : resolve(scope.cwd, p);
    if (!existsSync(abs)) throw new Error(`Can't upload ${p}: there's no file there.`);
    const real = realpathSync(abs);
    if (!statSync(real).isFile()) throw new Error(`Can't upload ${p}: it isn't a file.`);
    if (!roots.some((root) => inside(root, real))) {
      throw new Error(`Can't upload ${p}: files must be inside your working directory ${scope.cwd} or the scratch folder ${scope.scratchDir}.`);
    }
    return real;
  });
}

export const browserScreenshot = defineTool<{ save_to?: string; full_page?: boolean; selector?: string; ref?: string; frame?: FrameSpec; tab?: number } & WaitInput>({
  name: "browser_screenshot",
  description:
    `Take a PNG screenshot of the current viewport, or with full_page the whole scrollable page (up to ${MAX_SCREENSHOT_HEIGHT} CSS px tall), or with selector (or a ref from browser_snapshot) just one element; frame alone captures an iframe's whole box, and with selector looks for the element inside it. With save_to, also write the PNG to a file, so you can show it in the spec as ![What it shows](path) with edit_spec or update_spec. Pass wait_for so it captures the finished page, not a spinner: it waits before capturing (and still captures on a timeout, showing where the page got stuck).`,
  inputSchema: schema({
    save_to: {
      type: "string",
      minLength: 1,
      description:
        "Also save the PNG here, e.g. \"screenshots/after.png\". It must be inside your working directory or this run's scratch folder, and a relative path resolves against the working directory. In read-only runs (plan, review, or a read-only ticket) only the scratch folder is allowed and relative paths resolve there. Parent folders are created; an existing file is replaced only if it is a PNG.",
    },
    full_page: {
      type: "boolean",
      description: "Capture the whole page, top to bottom, even the parts below the viewport, not just what's on screen. The tab's width and size stay as they are.",
    },
    selector: {
      type: "string",
      minLength: 1,
      description: "Capture only the first element matching this CSS selector (its whole box, even the parts outside the viewport), e.g. \"#pricing\" or \"form.login\".",
    },
    ...REF,
    ...FRAME,
    ...TAB,
    ...waitForParam("before", "capturing"),
  }),
  async run({ save_to, full_page, selector, ref, frame: rawFrame, tab, wait_for }, ctx) {
    if (full_page && (selector || ref || rawFrame !== undefined)) return errorResult("Pass full_page or an element (selector, ref or frame), not both.");
    if (selector && ref) return errorResult("Pass selector or ref, not both.");
    if (ref && rawFrame !== undefined) return errorResult("A ref already knows its frame: pass ref without frame.");
    const frame = frameOf(rawFrame);
    if (frame.error) return errorResult(frame.error);
    const wait = parseWaitFor({ wait_for });
    if (wait.error) return errorResult(wait.error);
    // Check the path before taking the shot, so a refused save_to costs nothing.
    const scope = save_to ? await ctx.ops.fileOutputScope(ctx) : null;
    const path = save_to && scope ? resolveSaveTo(save_to, { cwd: ctx.cwd, ...scope }) : null;
    const waited = await waitOn(ctx, wait.condition, tab);
    const data = await ctx.browser.screenshot(ctx.session.id, {
      tab,
      ...(full_page ? { fullPage: true } : {}),
      ...(selector ? { selector } : {}),
      ...(ref ? { ref } : {}),
      ...(frame.frame ? { frame: frame.frame } : {}),
    });
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
