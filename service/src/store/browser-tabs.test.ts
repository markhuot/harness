import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { Store } from "./index";

const mk = () => new Store(openDb(":memory:"));
const session = (s: Store, key = "S-1") => s.sessions.create({ key, kind: "ticket", ticketId: null, driver: "dummy", cwd: "/tmp", title: key });

describe("browser tabs", () => {
  test("save replaces a session's tabs; load reads them back; other sessions are separate", () => {
    const s = mk();
    const a = session(s, "A-1");
    const b = session(s, "B-1");
    expect(s.browserTabs.load(a.id)).toBeNull();
    s.browserTabs.save(a.id, { nextTabId: 3, tabs: [{ id: 1, url: "http://a/", title: "A" }, { id: 2, url: "http://a/2", title: "" }] });
    s.browserTabs.save(b.id, { nextTabId: 2, tabs: [{ id: 1, url: "http://b/", title: "B" }] });
    s.browserTabs.save(a.id, { nextTabId: 4, tabs: [{ id: 2, url: "http://a/moved", title: "Moved" }] });
    expect(s.browserTabs.load(a.id)).toEqual({ nextTabId: 4, tabs: [{ id: 2, url: "http://a/moved", title: "Moved" }] });
    expect(s.browserTabs.load(b.id)).toEqual({ nextTabId: 2, tabs: [{ id: 1, url: "http://b/", title: "B" }] });
    s.browserTabs.delete(a.id);
    expect(s.browserTabs.load(a.id)).toBeNull();
    expect(s.browserTabs.load(b.id)).not.toBeNull();
  });

  test("a session that doesn't exist is refused, and deleting a session deletes its tabs", () => {
    const s = mk();
    expect(() => s.browserTabs.save("no-such-session", { nextTabId: 2, tabs: [{ id: 1, url: "x", title: "" }] })).toThrow(/FOREIGN KEY/);
    const a = session(s);
    s.browserTabs.save(a.id, { nextTabId: 2, tabs: [{ id: 1, url: "http://a/", title: "A" }] });
    s.sessions.delete(a.id);
    expect(s.db.query("SELECT COUNT(*) AS n FROM browser_tabs").get()).toEqual({ n: 0 });
  });

  test("load skips malformed tabs and survives broken JSON", () => {
    const s = mk();
    const a = session(s, "A-1");
    const b = session(s, "B-1");
    const put = (id: string, tabs: string) =>
      s.db.query("INSERT INTO browser_tabs (session_id, next_tab_id, tabs, updated_at) VALUES ($id, 5, $tabs, 0)").run({ id, tabs });
    put(a.id, JSON.stringify([{ id: 1, url: "http://ok/", title: "ok" }, { id: 0, url: "x", title: "" }, { id: 2, url: 7, title: "" }, null, { id: 3, url: "y" }]));
    put(b.id, "{not json");
    expect(s.browserTabs.load(a.id)).toEqual({ nextTabId: 5, tabs: [{ id: 1, url: "http://ok/", title: "ok" }] });
    expect(s.browserTabs.load(b.id)).toEqual({ nextTabId: 5, tabs: [] });
  });

  test("a tab's size round-trips; a missing or broken one loads without a size (Desktop)", () => {
    const s = mk();
    const a = session(s, "A-1");
    const b = session(s, "B-1");
    s.browserTabs.save(a.id, {
      nextTabId: 3,
      tabs: [
        { id: 1, url: "http://a/", title: "A", size: { device: "mobile", width: 1280, height: 800 } },
        { id: 2, url: "http://a/2", title: "B" },
      ],
    });
    expect(s.browserTabs.load(a.id)!.tabs).toEqual([
      { id: 1, url: "http://a/", title: "A", size: { device: "mobile", width: 1280, height: 800 } },
      { id: 2, url: "http://a/2", title: "B" },
    ]);
    const bad = [
      { id: 1, url: "x", title: "", size: { device: "tablet", width: 800, height: 600 } },
      { id: 2, url: "x", title: "", size: { device: "mobile", width: "393", height: 852 } },
      { id: 3, url: "x", title: "", size: { device: "desktop", width: 0, height: 800 } },
      { id: 4, url: "x", title: "", size: "mobile" },
    ];
    s.db.query("INSERT INTO browser_tabs (session_id, next_tab_id, tabs, updated_at) VALUES ($id, 5, $tabs, 0)").run({ id: b.id, tabs: JSON.stringify(bad) });
    expect(s.browserTabs.load(b.id)!.tabs.map((t) => t.size)).toEqual([undefined, undefined, undefined, undefined]);
  });
});
