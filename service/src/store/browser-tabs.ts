import type { Database } from "bun:sqlite";
import type { BrowserTabStore, StoredBrowserTab, StoredBrowserTabs } from "../browser/types";
import { fromJson, now } from "./util";

/** Each session's browser tabs (DESIGN.md "Browser tabs"): what reloads once their pages are gone. */
export class BrowserTabRepo implements BrowserTabStore {
  constructor(private db: Database) {}

  load(sessionId: string): StoredBrowserTabs | null {
    const row = this.db.query("SELECT next_tab_id, tabs FROM browser_tabs WHERE session_id = $id").get({ id: sessionId }) as
      | { next_tab_id: number; tabs: string }
      | null;
    if (!row) return null;
    const tabs = fromJson<unknown>(row.tabs, []);
    return {
      nextTabId: row.next_tab_id,
      tabs: (Array.isArray(tabs) ? tabs : []).filter(
        (t): t is StoredBrowserTab => !!t && Number.isInteger(t.id) && t.id > 0 && typeof t.url === "string" && typeof t.title === "string",
      ),
    };
  }

  /** Replace the session's tabs. Throws for a session that doesn't exist (the foreign key). */
  save(sessionId: string, state: StoredBrowserTabs) {
    this.db
      .query(
        `INSERT INTO browser_tabs (session_id, next_tab_id, tabs, updated_at) VALUES ($id, $next, $tabs, $t)
         ON CONFLICT(session_id) DO UPDATE SET next_tab_id = excluded.next_tab_id, tabs = excluded.tabs, updated_at = excluded.updated_at`,
      )
      .run({ id: sessionId, next: state.nextTabId, tabs: JSON.stringify(state.tabs.map(({ id, url, title }) => ({ id, url, title }))), t: now() });
  }

  delete(sessionId: string) {
    this.db.query("DELETE FROM browser_tabs WHERE session_id = $id").run({ id: sessionId });
  }
}
