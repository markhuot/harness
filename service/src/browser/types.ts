// Browser contract. The service owns one headless Chrome; each session gets its own tabs.
// Clients see a tab through a CDP screencast relayed over the WebSocket, and can drive it.
//
// Tabs are numbered per session from 1 and never reuse a number. A call without `tab` uses the
// session's lowest tab, creating tab 1 when the session has none.
//
// A tab outlives its Chrome page. Idle tabs nobody watches, and a done ticket's tabs, are
// suspended: the page closes, the tab keeps its number, URL and title (in the database, so it
// also survives a restart), and watching or using it reloads the URL. Only closing a tab, or
// deleting its session, removes it.

import type { BrowserDevice, BrowserElement, BrowserElementQuery, BrowserInput, BrowserScreenshot, BrowserSize, BrowserState, BrowserTab } from "@harness/shared";

export interface BrowserFrame {
  sessionId: string;
  tabId: number;
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

/** A tab as stored: enough to reload its page once Chrome no longer has it. */
export interface StoredBrowserTab {
  id: number;
  url: string;
  title: string;
  /** Its input mode and viewport, and whether it follows a viewer's pane (absent: it does). Absent: a new tab's, desktop Responsive. */
  size?: { device: BrowserDevice; width: number; height: number; responsive?: boolean };
}

/**
 * A size set by a button, the width × height inputs or an agent (browser_open, browser_resize). A
 * new `device` starts from its preset size; `width`/`height` override it, or alone keep the mode.
 */
export interface BrowserSizeChange {
  device?: BrowserDevice;
  width?: number;
  height?: number;
}

/** One network request of a tab's page, for browser_tabs. */
export interface BrowserRequest {
  method: string;
  url: string;
  /** CDP's resource type: Document, Script, Fetch, XHR, Image… */
  type: string;
  /** The response status; absent until (or unless) a response arrives. */
  status?: number;
  /** Why it failed ("net::ERR_CONNECTION_REFUSED", "canceled", "blocked (…)"); absent when it didn't. */
  failure?: string;
  /** From sent to finished or failed; absent while it's still loading. */
  durationMs?: number;
}

/** A console error or warning, or an uncaught exception, of a tab's page. */
export interface BrowserConsoleEntry {
  level: "error" | "warning";
  text: string;
  /** "url:line" where it came from, when Chrome says. */
  source?: string;
}

/** A tab in the session's list, with how many of its requests failed and how many console errors and warnings it has. */
export interface BrowserTabSummary extends BrowserTab {
  failedRequests?: number;
  consoleErrors?: number;
}

/** One tab in full (browser_tabs with a tab): its page's recent requests and console messages since it last navigated. */
export interface BrowserTabInfo {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  suspended?: boolean;
  size: BrowserSize;
  /** With size.responsive: a viewer has the tab open and it follows that viewer's pane. */
  following?: boolean;
  /** The page's scroll position in CSS px; absent for a suspended tab or a page that didn't answer. */
  scroll?: { x: number; y: number };
  requests: BrowserRequest[];
  console: BrowserConsoleEntry[];
}

export interface StoredBrowserTabs {
  /** The number the session's next tab gets (numbers are never reused). */
  nextTabId: number;
  tabs: StoredBrowserTab[];
}

/** Where sessions' tabs are kept across suspensions and restarts (the database's browser_tabs). */
export interface BrowserTabStore {
  load(sessionId: string): StoredBrowserTabs | null;
  save(sessionId: string, state: StoredBrowserTabs): void;
  delete(sessionId: string): void;
}

/** Which tab a call acts on. An explicit tab that isn't open throws. */
export interface TabOption {
  tab?: number;
}

export interface BrowserService {
  /** Navigate a tab (`newTab`: a new one) and wait for load; `size` is applied before it loads. */
  open(sessionId: string, url: string, opts?: TabOption & { newTab?: boolean; size?: BrowserSizeChange }): Promise<BrowserState>;
  /** A tab's state, or null if the session has no tab yet (or no such tab). */
  state(sessionId: string, opts?: TabOption): Promise<BrowserState | null>;
  /** The session's tabs, by id, with each one's size and (live ones) its failed-request and console counts. */
  tabs(sessionId: string): Promise<BrowserTabSummary[]>;
  /** One tab in full. A suspended tab isn't reopened for it. Throws when the session has no such tab. */
  tabInfo(sessionId: string, tab: number): Promise<BrowserTabInfo>;
  /**
   * Change a tab's input mode and size (browser_resize): switches Responsive off; a `device` reloads
   * the page, as the Desktop | Mobile buttons do. Any tab of the session, whoever opened it.
   */
  resize(sessionId: string, change: BrowserSizeChange, opts?: TabOption): Promise<BrowserState>;
  /**
   * Page content. With a selector, returns content of all matches (joined by blank lines).
   * format "text" = innerText, "html" = outerHTML. Throws if nothing matches the selector.
   */
  content(sessionId: string, opts?: TabOption & { selector?: string; format?: "text" | "html"; maxChars?: number }): Promise<string>;
  click(sessionId: string, selector: string, opts?: TabOption): Promise<void>;
  type(sessionId: string, selector: string, text: string, opts?: TabOption & { submit?: boolean }): Promise<void>;
  /** Evaluate a JS expression in the page; returns JSON-serialized result. */
  evaluate(sessionId: string, expression: string, opts?: TabOption): Promise<string>;
  /** PNG screenshot as base64 */
  screenshot(sessionId: string, opts?: TabOption): Promise<string>;
  /**
   * A PNG of the tab's viewport (not the full page) with what's needed to map its pixels back onto
   * the page: the PNG's size, the viewport in CSS pixels, the device scale, and the tab's
   * number, URL and title (GET /browser/:sessionId/screenshot, for annotating).
   */
  capture(sessionId: string, opts?: TabOption): Promise<BrowserScreenshot>;
  /**
   * The element under (x, y) CSS px of tab `query.tabId` (POST /browser/:sessionId/element): a
   * selector for it and its text, or null when nothing is there or the tab has moved on from the
   * screenshot (another URL, or scrolled). Reads the page only; it never scrolls or changes it.
   * Throws when the session has no such tab.
   */
  elementAt(sessionId: string, query: BrowserElementQuery): Promise<BrowserElement | null>;
  /** Close one tab (live or suspended) for good. Viewers on it move to the lowest open tab; when it was the last one and someone is watching, a blank tab replaces it. */
  closeTab(sessionId: string, tab: number): Promise<void>;
  /**
   * Apply user input coming from a client viewer. Without `tab` it goes to the tab `subscriberId`
   * watches. `newTab` moves that subscriber to the tab it opens.
   */
  input(sessionId: string, input: BrowserInput, opts?: TabOption & { subscriberId?: string }): Promise<void>;
  /**
   * Start relaying one tab's frames and the session's state to a subscriber (`tab` omitted, or not
   * open: the lowest open tab). Subscribing again with the same id switches its tab. Screencasts
   * run only for tabs someone watches.
   */
  subscribe(
    sessionId: string,
    subscriberId: string,
    onFrame: (f: BrowserFrame) => void,
    onState: (s: BrowserState) => void,
    opts?: TabOption,
  ): Promise<void>;
  unsubscribe(sessionId: string, subscriberId: string): Promise<void>;
  /**
   * The ticket is done: close the pages of the session's tabs and keep the tabs (each reloads its
   * URL when watched or used). A tab someone is watching keeps its page until the viewer leaves.
   */
  suspendTabs(sessionId: string): Promise<void>;
  /** Close all of the session's tabs and forget them, stored ones included (the session is deleted). */
  close(sessionId: string): Promise<void>;
  /** Shut down Chrome. */
  shutdown(): Promise<void>;
}
