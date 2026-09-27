import { BrowserManager, type BrowserManagerOptions } from "./manager.ts";
import type { BrowserService } from "./types.ts";

export { BrowserManager, normalizeUrl, type BrowserManagerOptions } from "./manager.ts";
export { CdpClient, CdpSession, CdpError, CdpTimeoutError, CdpClosedError } from "./cdp.ts";
export { ChromeProcess, findChrome } from "./chrome.ts";
export type { BrowserFrame, BrowserService } from "./types.ts";

/** Create the service's browser. Chrome launches lazily on first use. */
export function createBrowserService(opts: { profileDir: string; chromePath?: string; headless?: boolean } & Partial<BrowserManagerOptions>): BrowserService {
  return new BrowserManager(opts);
}
