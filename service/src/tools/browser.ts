// Browser tools: drive this session's tab in the harness's headless Chrome.
// The human can watch (and take over) the same tab from the app.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ToolResultContent } from "@harness/shared";
import { defineTool, schema } from "./util";

const DEFAULT_MAX_CHARS = 20_000;

export const browserOpen = defineTool<{ url: string }>({
  name: "browser_open",
  description:
    "Open a URL in this session's browser tab and wait for it to load. The human can watch this tab live. Returns the final URL and page title; use browser_content to read the page.",
  inputSchema: schema({ url: { type: "string", minLength: 1, description: "Absolute URL, e.g. \"http://localhost:3000/login\"." } }, ["url"]),
  async run({ url }, ctx) {
    const state = await ctx.browser.open(ctx.session.id, url);
    return `Opened ${state.url}\nTitle: ${state.title || "(untitled)"}`;
  },
});

export const browserContent = defineTool<{ selector?: string; format?: "text" | "html"; max_chars?: number }>({
  name: "browser_content",
  description:
    "Read the current page. format \"text\" (default) returns visible text; \"html\" returns markup. With a CSS selector, returns the content of every matching element. Output is capped at max_chars.",
  inputSchema: schema({
    selector: { type: "string", description: "CSS selector to scope the content, e.g. \"main\" or \"#results li\"." },
    format: { type: "string", enum: ["text", "html"], description: "\"text\" (default) or \"html\"." },
    max_chars: { type: "integer", minimum: 1, description: `Maximum characters to return (default ${DEFAULT_MAX_CHARS}).` },
  }),
  async run({ selector, format, max_chars }, ctx) {
    const content = await ctx.browser.content(ctx.session.id, {
      selector,
      format: format ?? "text",
      maxChars: max_chars ?? DEFAULT_MAX_CHARS,
    });
    return content === "" ? "(the page has no content)" : content;
  },
});

export const browserClick = defineTool<{ selector: string }>({
  name: "browser_click",
  description: "Click the first element matching a CSS selector.",
  inputSchema: schema({ selector: { type: "string", minLength: 1, description: "CSS selector of the element to click." } }, ["selector"]),
  async run({ selector }, ctx) {
    await ctx.browser.click(ctx.session.id, selector);
    const state = await ctx.browser.state(ctx.session.id);
    return state ? `Clicked ${selector}. Now at ${state.url}` : `Clicked ${selector}.`;
  },
});

export const browserType = defineTool<{ selector: string; text: string; submit?: boolean }>({
  name: "browser_type",
  description: "Focus the element matching a CSS selector and type text into it. Set submit to press Enter afterwards (e.g. to submit a form).",
  inputSchema: schema(
    {
      selector: { type: "string", minLength: 1, description: "CSS selector of an input, textarea or contenteditable element." },
      text: { type: "string", description: "Text to type." },
      submit: { type: "boolean", description: "Press Enter after typing." },
    },
    ["selector", "text"],
  ),
  async run({ selector, text, submit }, ctx) {
    await ctx.browser.type(ctx.session.id, selector, text, { submit: submit ?? false });
    return submit ? `Typed into ${selector} and pressed Enter.` : `Typed into ${selector}.`;
  },
});

export const browserEval = defineTool<{ expression: string }>({
  name: "browser_eval",
  description: "Evaluate a JavaScript expression in the page and return its JSON-serialized result. Promises are awaited.",
  inputSchema: schema({ expression: { type: "string", minLength: 1, description: "JavaScript expression, e.g. \"document.querySelectorAll('a').length\"." } }, ["expression"]),
  async run({ expression }, ctx) {
    return await ctx.browser.evaluate(ctx.session.id, expression);
  },
});

export const browserScreenshot = defineTool<{ save_to?: string }>({
  name: "browser_screenshot",
  description:
    "Take a PNG screenshot of the current viewport. With save_to, also write the PNG to that path, so you can attach it to post_summary or submit_for_review.",
  inputSchema: schema({
    save_to: {
      type: "string",
      minLength: 1,
      description: "Also save the PNG here: an absolute path or one relative to your working directory, e.g. \"screenshots/after.png\". Parent folders are created.",
    },
  }),
  async run({ save_to }, ctx) {
    const data = await ctx.browser.screenshot(ctx.session.id);
    const content: ToolResultContent[] = [{ type: "image", data, mimeType: "image/png" }];
    if (save_to) {
      const path = isAbsolute(save_to) ? save_to : resolve(ctx.cwd, save_to);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
      content.push({ type: "text", text: `Saved the screenshot to ${path}` });
    }
    return { content };
  },
});
