// Browser tools: drive this session's tabs in the harness's headless Chrome.
// The human can watch (and take over) the same tabs from the app.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ToolResultContent } from "@harness/shared";
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

const tabLine = (tabs: { id: number; url: string; title: string; loading: boolean }[]) =>
  tabs.map((t) => `Tab ${t.id}: ${t.title || "(untitled)"} — ${t.url}${t.loading ? " (loading)" : ""}`).join("\n");

export const browserOpen = defineTool<{ url: string; tab?: number; new_tab?: boolean }>({
  name: "browser_open",
  description:
    "Open a URL in this session's browser and wait for it to load. The human can watch it live. new_tab opens it in a new tab, so several pages stay open at once; the result names the tab, and you pass that number as tab to the other browser tools. Sub-agents sharing this browser should each open their own tab and use only it. Close a tab with browser_close_tab when you're done with it. Returns the tab, final URL and page title; use browser_content to read the page.",
  inputSchema: schema(
    {
      url: { type: "string", minLength: 1, description: "Absolute URL, e.g. \"http://localhost:3000/login\"." },
      ...TAB,
      new_tab: { type: "boolean", description: "Open a new tab for this URL instead of navigating an existing one." },
    },
    ["url"],
  ),
  async run({ url, tab, new_tab }, ctx) {
    if (new_tab && tab !== undefined) return errorResult("Pass tab or new_tab, not both.");
    const state = await ctx.browser.open(ctx.session.id, url, { tab, newTab: new_tab ?? false });
    return `Opened ${state.url} in tab ${state.tabId}\nTitle: ${state.title || "(untitled)"}`;
  },
});

export const browserTabs = defineTool<Record<string, never>>({
  name: "browser_tabs",
  description: "List this session's open browser tabs: number, title and URL of each.",
  inputSchema: schema({}),
  async run(_input, ctx) {
    const tabs = await ctx.browser.tabs(ctx.session.id);
    return tabs.length ? tabLine(tabs) : "No tabs are open. browser_open opens tab 1.";
  },
});

export const browserCloseTab = defineTool<{ tab: number }>({
  name: "browser_close_tab",
  description: "Close a browser tab you opened and no longer need. Tab numbers aren't reused.",
  inputSchema: schema({ tab: { ...TAB.tab, description: "Number of the tab to close." } }, ["tab"]),
  async run({ tab }, ctx) {
    await ctx.browser.closeTab(ctx.session.id, tab);
    const left = await ctx.browser.tabs(ctx.session.id);
    return `Closed tab ${tab}.${left.length ? `\nOpen tabs:\n${tabLine(left)}` : " No tabs are open."}`;
  },
});

export const browserContent = defineTool<{ selector?: string; format?: "text" | "html"; max_chars?: number; tab?: number }>({
  name: "browser_content",
  description:
    "Read the current page. format \"text\" (default) returns visible text; \"html\" returns markup. With a CSS selector, returns the content of every matching element. Output is capped at max_chars.",
  inputSchema: schema({
    selector: { type: "string", description: "CSS selector to scope the content, e.g. \"main\" or \"#results li\"." },
    format: { type: "string", enum: ["text", "html"], description: "\"text\" (default) or \"html\"." },
    max_chars: { type: "integer", minimum: 1, description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}).` },
    ...TAB,
  }),
  async run({ selector, format, max_chars, tab }, ctx) {
    const content = await ctx.browser.content(ctx.session.id, {
      selector,
      format: format ?? "text",
      maxChars: max_chars ?? DEFAULT_MAX_CHARS,
      tab,
    });
    return content === "" ? "(the page has no content)" : content;
  },
});

export const browserClick = defineTool<{ selector: string; tab?: number }>({
  name: "browser_click",
  description: "Click the first element matching a CSS selector.",
  inputSchema: schema({ selector: { type: "string", minLength: 1, description: "CSS selector of the element to click." }, ...TAB }, ["selector"]),
  async run({ selector, tab }, ctx) {
    await ctx.browser.click(ctx.session.id, selector, { tab });
    const state = await ctx.browser.state(ctx.session.id, { tab });
    return state ? `Clicked ${selector}. Now at ${state.url}` : `Clicked ${selector}.`;
  },
});

export const browserType = defineTool<{ selector: string; text: string; submit?: boolean; tab?: number }>({
  name: "browser_type",
  description: "Focus the element matching a CSS selector and type text into it. Set submit to press Enter afterwards (e.g. to submit a form).",
  inputSchema: schema(
    {
      selector: { type: "string", minLength: 1, description: "CSS selector of an input, textarea or contenteditable element." },
      text: { type: "string", description: "Text to type." },
      submit: { type: "boolean", description: "Press Enter after typing." },
      ...TAB,
    },
    ["selector", "text"],
  ),
  async run({ selector, text, submit, tab }, ctx) {
    await ctx.browser.type(ctx.session.id, selector, text, { submit: submit ?? false, tab });
    return submit ? `Typed into ${selector} and pressed Enter.` : `Typed into ${selector}.`;
  },
});

export const browserEval = defineTool<{ expression: string; tab?: number }>({
  name: "browser_eval",
  description: "Evaluate a JavaScript expression in the page and return its JSON-serialized result. Promises are awaited.",
  inputSchema: schema(
    { expression: { type: "string", minLength: 1, description: "JavaScript expression, e.g. \"document.querySelectorAll('a').length\"." }, ...TAB },
    ["expression"],
  ),
  async run({ expression, tab }, ctx) {
    return await ctx.browser.evaluate(ctx.session.id, expression, { tab });
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

export const browserScreenshot = defineTool<{ save_to?: string; tab?: number }>({
  name: "browser_screenshot",
  description:
    "Take a PNG screenshot of the current viewport. With save_to, also write the PNG to a file, so you can attach it to post_summary or submit_for_review.",
  inputSchema: schema({
    save_to: {
      type: "string",
      minLength: 1,
      description:
        "Also save the PNG here, e.g. \"screenshots/after.png\". It must be inside your working directory or this run's scratch folder, and a relative path resolves against the working directory. In read-only runs (plan, review, or a read-only ticket) only the scratch folder is allowed and relative paths resolve there. Parent folders are created; an existing file is replaced only if it is a PNG.",
    },
    ...TAB,
  }),
  async run({ save_to, tab }, ctx) {
    // Check the path before taking the shot, so a refused save_to costs nothing.
    const scope = save_to ? await ctx.ops.fileOutputScope(ctx) : null;
    const path = save_to && scope ? resolveSaveTo(save_to, { cwd: ctx.cwd, ...scope }) : null;
    const data = await ctx.browser.screenshot(ctx.session.id, { tab });
    const content: ToolResultContent[] = [{ type: "image", data, mimeType: "image/png" }];
    if (path && scope) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
      const inScratch = inside(realpathSync(scope.scratchDir), path);
      content.push({ type: "text", text: `Saved the screenshot to ${path}${inScratch ? " (this run's scratch folder)" : ""}` });
    }
    return { content };
  },
});
