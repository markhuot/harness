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

import type { BrowserInput, BrowserScreenshot, BrowserState, BrowserTab } from "@harness/shared";

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
  /** Navigate a tab (`newTab`: a new one) and wait for load. */
  open(sessionId: string, url: string, opts?: TabOption & { newTab?: boolean }): Promise<BrowserState>;
  /** A tab's state, or null if the session has no tab yet (or no such tab). */
  state(sessionId: string, opts?: TabOption): Promise<BrowserState | null>;
  /** The session's open tabs, by id. */
  tabs(sessionId: string): Promise<BrowserTab[]>;
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
