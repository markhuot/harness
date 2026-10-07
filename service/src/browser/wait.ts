// The wait condition every browser wait goes through: browser_wait, the wait_for param of the
// tools that act on or read a page, and a browser_run script's wait(). One shape, one
// implementation (BrowserManager.waitFor), and one wording for the agent (the tool descriptions
// and the Browser prompt section both use WAIT_CONDITION_DOC).

import { frameChain, frameLabel } from "./frames";

/** What a wait waits for. Every field given must hold at once. */
export interface WaitCondition {
  /** CSS selector the condition is about (with `state`, default "visible"). */
  selector?: string;
  state?: WaitState;
  /** Visible text that appears (scoped to `selector`'s elements when given). */
  text?: string;
  /** A substring of the URL, or a /regex/ with optional flags. */
  url?: string;
  /** No main-frame loading and no request in flight for IDLE_QUIET_MS. */
  idle?: boolean;
  /** Seconds before giving up (default WAIT_DEFAULT_TIMEOUT_S, at most WAIT_MAX_TIMEOUT_S). */
  timeout?: number;
  /** The iframe selector and text are checked in (frames.ts); alone, its document has loaded. */
  frame?: string | string[];
}

export type WaitState = "visible" | "hidden" | "gone" | "enabled";

export const WAIT_STATES: readonly WaitState[] = ["visible", "hidden", "gone", "enabled"];
export const WAIT_DEFAULT_TIMEOUT_S = 15;
export const WAIT_MAX_TIMEOUT_S = 120;
/** How long the network has to stay quiet for `idle`. */
export const IDLE_QUIET_MS = 500;
/** Requests open longer than this (long polls, streams) don't keep a page from being idle. */
export const IDLE_IGNORE_AFTER_MS = 5_000;

/** How the agent is told what a wait condition is (tool descriptions and the Browser prompt section). */
export const WAIT_CONDITION_DOC =
  `{ selector?, state?: "visible" | "hidden" | "gone" | "enabled", text?, frame?, url?, idle?, timeout? }; every field you give must hold at once. ` +
  `selector with state: an element matching it is visible (the default state), none is visible (hidden), none is in the page at all (gone), or one is visible and clickable (enabled: not disabled, not aria-disabled, not inside [aria-busy=true]). ` +
  `text: that visible text is on the page (in selector's elements, with selector). ` +
  `frame: check selector and text inside that iframe (a CSS selector for the <iframe>, or an array of them for nested frames); alone, wait until the iframe has loaded. ` +
  `url: the URL contains it, or matches it when written /like-this/. ` +
  `idle: true waits until the page has stopped loading and no request has been in flight for ${IDLE_QUIET_MS} ms (requests open over ${IDLE_IGNORE_AFTER_MS / 1000} s, like long polls, don't count). ` +
  `timeout: seconds before giving up, ${WAIT_DEFAULT_TIMEOUT_S} by default; raise it (up to ${WAIT_MAX_TIMEOUT_S}) when you know a step is slow. ` +
  `It checks again across reloads, so a navigation in the middle is fine. On a timeout the tool still does (or reads) what it would have, and its error says what the page was doing.`;

/** The condition fields as JSON Schema properties (browser_wait's own fields, and wait_for's). */
export const WAIT_CONDITION_PROPERTIES = {
  selector: { type: "string", minLength: 1, description: "CSS selector the condition is about, e.g. \"button[data-remove-item]\"." },
  state: {
    type: "string",
    enum: WAIT_STATES,
    description:
      "With selector: \"visible\" (default) an element matching it is visible; \"hidden\" none is visible; \"gone\" none is in the page; \"enabled\" one is visible and clickable (not disabled, not aria-disabled, not inside [aria-busy=true]). With text, the elements containing that text.",
  },
  text: { type: "string", minLength: 1, description: "Visible text that must be on the page (in selector's elements, with selector)." },
  frame: {
    anyOf: [{ type: "string", minLength: 1 }, { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }],
    description: "Check selector and text inside this iframe: a CSS selector for the <iframe> element, or an array of them for nested frames (outermost first). Alone: wait until the iframe has loaded.",
  },
  url: { type: "string", minLength: 1, description: "The URL contains this, or matches it when written as /regex/flags." },
  idle: { type: "boolean", description: `true: the page has stopped loading and no request has been in flight for ${IDLE_QUIET_MS} ms.` },
  timeout: {
    type: "number",
    exclusiveMinimum: 0,
    maximum: WAIT_MAX_TIMEOUT_S,
    description: `Seconds before giving up: ${WAIT_DEFAULT_TIMEOUT_S} by default, at most ${WAIT_MAX_TIMEOUT_S}. Raise it when you know a step is slow; for longer flows use browser_run.`,
  },
} as const;

/**
 * The checked condition, or an error message for the agent. A condition needs something to wait
 * for: a selector, text, url or idle (a timeout alone would just be a sleep).
 */
export function checkCondition(input: unknown): { ok: true; condition: WaitCondition } | { ok: false; error: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "A wait condition is an object, e.g. { selector: \".done\" }." };
  const c = input as Record<string, unknown>;
  const unknown = Object.keys(c).filter((k) => !(k in WAIT_CONDITION_PROPERTIES));
  if (unknown.length) return { ok: false, error: `Unknown wait condition field${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. The fields are ${Object.keys(WAIT_CONDITION_PROPERTIES).join(", ")}.` };
  const str = (k: string) => {
    const v = c[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "") throw new Error(`${k} must be a non-empty string.`);
    return v;
  };
  try {
    const selector = str("selector");
    const text = str("text");
    const url = str("url");
    const state = c.state;
    if (state !== undefined && !WAIT_STATES.includes(state as WaitState)) throw new Error(`state must be one of ${WAIT_STATES.join(", ")}.`);
    if (state !== undefined && selector === undefined && text === undefined) throw new Error("state needs a selector or text to apply to.");
    if (c.idle !== undefined && typeof c.idle !== "boolean") throw new Error("idle must be true or false.");
    const timeout = c.timeout;
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > WAIT_MAX_TIMEOUT_S)) {
      throw new Error(`timeout is in seconds, more than 0 and at most ${WAIT_MAX_TIMEOUT_S}. For longer flows, use browser_run.`);
    }
    if (url !== undefined) urlMatcher(url); // a bad /regex/ fails now, not on every poll
    const frame = c.frame === undefined ? undefined : frameChain(c.frame);
    if (selector === undefined && text === undefined && url === undefined && frame === undefined && c.idle !== true) {
      throw new Error("Say what to wait for: selector, text, frame, url or idle: true.");
    }
    return {
      ok: true,
      condition: {
        ...(selector !== undefined ? { selector } : {}),
        ...(state !== undefined ? { state: state as WaitState } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(frame !== undefined ? { frame: frame.length === 1 ? frame[0]! : frame } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(c.idle === true ? { idle: true } : {}),
        ...(timeout !== undefined ? { timeout: timeout as number } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** A url condition as a test: /pattern/flags is a regex, anything else a substring. */
export function urlMatcher(url: string): (href: string) => boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(url);
  if (!m) return (href) => href.includes(url);
  let re: RegExp;
  try {
    re = new RegExp(m[1]!, m[2]);
  } catch (e) {
    throw new Error(`url ${url} isn't a valid regex: ${(e as Error).message}`);
  }
  return (href) => re.test(href);
}

/** The condition in a few words, for results and logs: `"button" gone, network idle`. */
export function describeCondition(c: WaitCondition): string {
  const parts: string[] = [];
  if (c.selector !== undefined || c.text !== undefined) {
    const what = [c.selector !== undefined ? JSON.stringify(c.selector) : "", c.text !== undefined ? `text ${JSON.stringify(c.text)}` : ""].filter(Boolean).join(" with ");
    parts.push(`${what} ${c.state ?? "visible"}${c.frame !== undefined ? ` in frame ${frameLabel(c.frame)}` : ""}`);
  } else if (c.frame !== undefined) parts.push(`frame ${frameLabel(c.frame)} loaded`);
  if (c.url !== undefined) parts.push(`URL ${c.url.startsWith("/") && c.url.length > 1 ? "matches" : "contains"} ${c.url}`);
  if (c.idle) parts.push("network idle");
  return parts.join(", ");
}

/** The condition's timeout in ms. */
export const timeoutMs = (c: WaitCondition) => Math.round((c.timeout ?? WAIT_DEFAULT_TIMEOUT_S) * 1000);

/** Seconds with one decimal: "8.4s". */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** What a wait came to: met or timed out, how long it took, and where the page ended up. */
export interface WaitResult {
  met: boolean;
  elapsedMs: number;
  url: string;
  /** One line for the agent: "\"button\" gone after 8.4s; now at /cart", or why it timed out. */
  summary: string;
}
