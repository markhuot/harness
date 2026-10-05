// The element under a point of a page (POST /browser/:sessionId/element), so a mark the human
// drew on a browser screenshot can name what it points at (AnnotationMark.path and .text) and the
// agent can find it in the page and in the source. The finder runs inside the page; it reads the
// DOM and never scrolls or otherwise changes it.

import { MAX_ANNOTATION_PATH, MAX_ANNOTATION_TEXT, type BrowserElement } from "@harness/shared";

// The page's DOM, as far as findElement touches it. Not every tsconfig that reaches this file loads
// the DOM lib (it changes Bun's stream types), so these module-scoped names stand in for it.
interface PageNode {
  id: string;
  localName: string;
  parentElement: PageNode | null;
  firstElementChild: PageNode | null;
  nextElementSibling: PageNode | null;
  textContent: string | null;
  innerText?: string;
}
declare const document: {
  elementFromPoint(x: number, y: number): PageNode | null;
  querySelectorAll(selector: string): { length: number };
  body: PageNode | null;
  documentElement: PageNode;
};
declare const location: { href: string };
declare const window: { scrollX: number; scrollY: number };
declare const CSS: { escape(value: string): string };

/** What the page reports: where it is, and what's under the point (null when nothing is). */
export interface PageElementReport {
  href: string;
  scroll: { x: number; y: number };
  element: BrowserElement | null;
}

/**
 * Runs in the page (serialized with toString, so it must stay self-contained plain JS). The
 * selector starts at the nearest element, the target itself included, whose id is unique in the
 * document (`#id`, CSS.escape'd), else at `body` (`html` for the root), then steps down one child
 * at a time as `tag`, with `:nth-of-type(n)` when siblings share the tag. Past `maxPath`
 * characters the leading steps are dropped, so the tail that names the element itself remains.
 * The text is innerText (textContent where there's none, as for SVG), whitespace collapsed,
 * trimmed and cut to `maxText`.
 */
export function findElement(x: number, y: number, maxPath: number, maxText: number): PageElementReport {
  const report = (element: BrowserElement | null): PageElementReport => ({ href: location.href, scroll: { x: window.scrollX, y: window.scrollY }, element });
  const target = document.elementFromPoint(x, y);
  if (!target) return report(null);
  const uniqueId = (el: PageNode) => !!el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1;
  const steps: string[] = [];
  let anchor = "";
  for (let el: PageNode | null = target; el; el = el.parentElement) {
    if (uniqueId(el)) {
      anchor = `#${CSS.escape(el.id)}`;
      break;
    }
    const tag = el.localName;
    if (el === document.body || el === document.documentElement) {
      anchor = tag;
      break;
    }
    let n = 1;
    let same = false;
    let before = true;
    for (let s: PageNode | null = el.parentElement?.firstElementChild ?? null; s; s = s.nextElementSibling) {
      if (s === el) {
        before = false;
        continue;
      }
      if (s.localName !== tag) continue;
      same = true;
      if (before) n++;
    }
    steps.unshift(same ? `${CSS.escape(tag)}:nth-of-type(${n})` : CSS.escape(tag));
  }
  const parts = anchor ? [anchor, ...steps] : steps;
  while (parts.length > 1 && parts.join(" > ").length > maxPath) parts.shift();
  const raw = typeof target.innerText === "string" ? target.innerText : (target.textContent ?? "");
  const text = raw.replace(/\s+/g, " ").trim().slice(0, maxText).trim();
  return report({ path: parts.join(" > ").slice(0, maxPath), text });
}

/** The expression that runs findElement at (x, y) in the page. */
export function findElementExpression(x: number, y: number): string {
  return `(${findElement.toString()})(${JSON.stringify(x)}, ${JSON.stringify(y)}, ${MAX_ANNOTATION_PATH}, ${MAX_ANNOTATION_TEXT})`;
}

/** How far the scroll may have drifted (CSS px, sub-pixel rounding) and still be the same view. */
export const SCROLL_TOLERANCE = 1;

/**
 * The element when the page is still the one the screenshot showed: the same URL (the tab's
 * tracked one or the page's own) and the same scroll position within SCROLL_TOLERANCE. Otherwise
 * null: what's under the point now isn't what the human marked.
 */
export function sameView(report: PageElementReport, tabUrl: string, query: { url: string; scroll: { x: number; y: number } }): BrowserElement | null {
  if (query.url !== report.href && query.url !== tabUrl) return null;
  if (Math.abs(report.scroll.x - query.scroll.x) > SCROLL_TOLERANCE || Math.abs(report.scroll.y - query.scroll.y) > SCROLL_TOLERANCE) return null;
  return report.element;
}
