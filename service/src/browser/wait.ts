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
  /** Exactly this many elements match selector (and text). */
  count?: number;
  /** A matching element's `.value` is exactly this. */
  value?: string;
  /** A matching element has this attribute (with exactly this value, when given). */
  attribute?: { name: string; value?: string };
  /**
   * The snapshot ref of the element the condition is about, in place of selector and frame. Not a
   * wait_for field: browser_run's expect() sets it for expect({ ref }).
   */
  ref?: string;
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
  `{ selector?, state?: "visible" | "hidden" | "gone" | "enabled", text?, count?, value?, attribute?: { name, value? }, frame?, url?, idle?, timeout? }; every field you give must hold at once. ` +
  `selector with state: an element matching it is visible (the default state), none is visible (hidden), none is in the page at all (gone), or one is visible and clickable (enabled: not disabled, not aria-disabled, not inside [aria-busy=true]). ` +
  `text: that visible text is on the page (in selector's elements, with selector). ` +
  `With selector: count, exactly that many elements match (and contain text, when given); value, a matching element's .value is exactly that string; attribute, a matching element has that attribute (with exactly that value, when given). These don't need the element visible unless you also give state. ` +
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
  count: { type: "integer", minimum: 0, description: "With selector: exactly this many elements match it (and contain text, when given). 0 waits until none do." },
  value: { type: "string", description: "With selector: a matching element's .value (an input, select or textarea) is exactly this." },
  attribute: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "The attribute's name, e.g. \"aria-expanded\"." },
      value: { type: "string", description: "Its exact value. Omitted: the attribute is present, with any value." },
    },
    required: ["name"],
    additionalProperties: false,
    description: "With selector: a matching element has this attribute (with exactly this value, when given).",
  },
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
 * for: a selector, text, url or idle (a timeout alone would just be a sleep). `ref` (browser_run's
 * expect({ ref })) names the element in place of a selector and frame.
 */
export function checkCondition(input: unknown, ref?: string): { ok: true; condition: WaitCondition } | { ok: false; error: string } {
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
    const element = selector !== undefined || ref !== undefined;
    if (ref !== undefined && (selector !== undefined || c.frame !== undefined)) throw new Error("A ref names its element and frame: give it without selector or frame.");
    if (state !== undefined && !element && text === undefined) throw new Error("state needs a selector or text to apply to.");
    const count = c.count;
    if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count < 0)) throw new Error("count must be a whole number, 0 or more.");
    if (c.value !== undefined && typeof c.value !== "string") throw new Error("value must be a string.");
    let attribute: { name: string; value?: string } | undefined;
    if (c.attribute !== undefined) {
      const a = c.attribute as Record<string, unknown> | null;
      if (a === null || typeof a !== "object" || Array.isArray(a) || typeof a.name !== "string" || a.name === "") throw new Error("attribute is { name, value? }, with a non-empty name.");
      const extra = Object.keys(a).filter((k) => k !== "name" && k !== "value");
      if (extra.length) throw new Error(`attribute is { name, value? }; it has no ${extra.join(", ")}.`);
      if (a.value !== undefined && typeof a.value !== "string") throw new Error("attribute's value must be a string.");
      attribute = { name: a.name, ...(a.value !== undefined ? { value: a.value } : {}) };
    }
    for (const [k, v] of [["count", count], ["value", c.value], ["attribute", attribute]] as const) {
      if (v !== undefined && !element) throw new Error(`${k} needs a selector: the elements it counts or reads.`);
    }
    if (c.idle !== undefined && typeof c.idle !== "boolean") throw new Error("idle must be true or false.");
    const timeout = c.timeout;
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > WAIT_MAX_TIMEOUT_S)) {
      throw new Error(`timeout is in seconds, more than 0 and at most ${WAIT_MAX_TIMEOUT_S}. For longer flows, use browser_run.`);
    }
    if (url !== undefined) urlMatcher(url); // a bad /regex/ fails now, not on every poll
    const frame = c.frame === undefined ? undefined : frameChain(c.frame);
    if (!element && text === undefined && url === undefined && frame === undefined && c.idle !== true) {
      throw new Error("Say what to wait for: selector, text, frame, url or idle: true.");
    }
    return {
      ok: true,
      condition: {
        ...(selector !== undefined ? { selector } : {}),
        ...(ref !== undefined ? { ref } : {}),
        ...(state !== undefined ? { state: state as WaitState } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(count !== undefined ? { count: count as number } : {}),
        ...(c.value !== undefined ? { value: c.value as string } : {}),
        ...(attribute !== undefined ? { attribute } : {}),
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
  if (c.selector !== undefined || c.ref !== undefined || c.text !== undefined) {
    const el = c.ref !== undefined ? `ref ${c.ref}` : c.selector !== undefined ? JSON.stringify(c.selector) : "";
    const what = [el, c.text !== undefined ? `text ${JSON.stringify(c.text)}` : ""].filter(Boolean).join(" with ");
    const tests = [
      ...(c.count !== undefined ? [`count ${c.count}`] : []),
      ...(c.value !== undefined ? [`value ${JSON.stringify(c.value)}`] : []),
      ...(c.attribute !== undefined ? [`attribute ${c.attribute.name}${c.attribute.value !== undefined ? `=${JSON.stringify(c.attribute.value)}` : ""}`] : []),
    ];
    const state = effectiveState(c);
    if (state) tests.unshift(state);
    parts.push(`${what} ${tests.join(", ")}${c.frame !== undefined ? ` in frame ${frameLabel(c.frame)}` : ""}`);
  } else if (c.frame !== undefined) parts.push(`frame ${frameLabel(c.frame)} loaded`);
  if (c.url !== undefined) parts.push(`URL ${c.url.startsWith("/") && c.url.length > 1 ? "matches" : "contains"} ${c.url}`);
  if (c.idle) parts.push("network idle");
  return parts.join(", ");
}

/**
 * The state the elements must be in: the one given, else "visible", except that count, value and
 * attribute don't need the element visible (a hidden input still has a value), so alone they
 * apply no state.
 */
export function effectiveState(c: WaitCondition): WaitState | undefined {
  if (c.state !== undefined) return c.state;
  return c.count !== undefined || c.value !== undefined || c.attribute !== undefined ? undefined : "visible";
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
