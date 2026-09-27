// Browser contract. The service owns one headless Chrome; each session gets its own tab.
// Clients see the tab through a CDP screencast relayed over the WebSocket, and can drive it.

import type { BrowserInput, BrowserState } from "@harness/shared";

export interface BrowserFrame {
  sessionId: string;
  /** base64 JPEG */
  data: string;
  width: number;
  height: number;
}

export interface BrowserService {
  /** Navigate the session's tab (creating it if needed) and wait for load. */
  open(sessionId: string, url: string): Promise<BrowserState>;
  /** Current state, or null if the session has no tab yet. */
  state(sessionId: string): Promise<BrowserState | null>;
  /**
   * Page content. With a selector, returns content of all matches (joined by blank lines).
   * format "text" = innerText, "html" = outerHTML. Throws if nothing matches the selector.
   */
  content(sessionId: string, opts?: { selector?: string; format?: "text" | "html"; maxChars?: number }): Promise<string>;
  click(sessionId: string, selector: string): Promise<void>;
  type(sessionId: string, selector: string, text: string, opts?: { submit?: boolean }): Promise<void>;
  /** Evaluate a JS expression in the page; returns JSON-serialized result. */
  evaluate(sessionId: string, expression: string): Promise<string>;
  /** PNG screenshot as base64 */
  screenshot(sessionId: string): Promise<string>;
  /** Apply user input coming from a client viewer. */
  input(sessionId: string, input: BrowserInput): Promise<void>;
  /** Start/stop relaying frames for the session. Ref-counted by caller identity. */
  subscribe(sessionId: string, subscriberId: string, onFrame: (f: BrowserFrame) => void, onState: (s: BrowserState) => void): Promise<void>;
  unsubscribe(sessionId: string, subscriberId: string): Promise<void>;
  /** Close the session's tab. */
  close(sessionId: string): Promise<void>;
  /** Shut down Chrome. */
  shutdown(): Promise<void>;
}
