import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeForLink, WIDGET_HOST_FILE, widgetGroupDir, widgetHost, WidgetReloader, writeWidgetHost } from "./widgets";

const themes = { lightTheme: "pierre-light", darkTheme: "pierre-dark" };
const conn = { baseUrl: "http://127.0.0.1:7717", token: "tok", source: "service" as const };

describe("widgetHost", () => {
  test("hands the widget the connection and the theme picks", () => {
    expect(widgetHost(conn, themes)).toEqual({ baseUrl: "http://127.0.0.1:7717", token: "tok", name: "This Mac", ...themes });
  });

  test("no connection, a failed one or one without a token is no host", () => {
    expect(widgetHost(null, themes)).toBeNull();
    expect(widgetHost({ error: "no service", output: "" }, themes)).toBeNull();
    expect(widgetHost({ ...conn, token: "" }, themes)).toBeNull();
  });
});

describe("writeWidgetHost", () => {
  test("writes the host for this user only, and null removes it", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "widgets-")), "group");
    writeWidgetHost(dir, widgetHost(conn, themes));
    const file = join(dir, WIDGET_HOST_FILE);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("tok");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeWidgetHost(dir, null);
    expect(existsSync(file)).toBe(false);
    writeWidgetHost(dir, null); // nothing to remove is fine
  });

  test("the group container is the team-prefixed one", () => {
    expect(widgetGroupDir("/Users/m")).toBe("/Users/m/Library/Group Containers/47P4ZSALX4.com.markhuot.harness");
  });
});

describe("WidgetReloader", () => {
  function harness() {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    let reloads = 0;
    const r = new WidgetReloader(() => reloads++, 5_000, () => now, (fn, ms) => {
      timers.push({ at: now + ms, fn });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers.splice(0).filter((x) => x.at <= now)) timer.fn();
    };
    return { r, advance, reloads: () => reloads, timers };
  }

  test("reloads at once the first time, and never for the same signature", () => {
    const h = harness();
    h.r.changed("a");
    expect(h.reloads()).toBe(1);
    h.r.changed("a");
    h.advance(10_000);
    expect(h.reloads()).toBe(1);
  });

  test("a burst within the gap reloads once more, with the last signature", () => {
    const h = harness();
    h.r.changed("a");
    h.advance(1_000);
    h.r.changed("b");
    h.r.changed("c");
    expect(h.reloads()).toBe(1);
    expect(h.timers.length).toBe(1);
    h.advance(4_000);
    expect(h.reloads()).toBe(2);
    h.r.changed("c");
    expect(h.reloads()).toBe(2);
  });

  test("changing back before the trailing call skips it", () => {
    const h = harness();
    h.r.changed("a");
    h.r.changed("b");
    h.r.changed("a");
    h.advance(5_000);
    expect(h.reloads()).toBe(1);
  });
});

describe("routeForLink", () => {
  test("a ticket link opens the ticket on the All projects board", () => {
    expect(routeForLink("harness://ticket/HARNESS-283")).toBe("#/board/all/ticket/HARNESS-283");
    expect(routeForLink("harness://ticket/A%20B")).toBe("#/board/all/ticket/A%20B");
    expect(routeForLink("harness://board")).toBe("#/board/all");
  });

  test("anything else isn't routed", () => {
    expect(routeForLink("harness://ticket/")).toBeNull();
    expect(routeForLink("harness://ticket/A/B")).toBeNull();
    expect(routeForLink("harness://settings")).toBeNull();
    expect(routeForLink("https://ticket/A-1")).toBeNull();
    expect(routeForLink("not a url")).toBeNull();
  });
});
