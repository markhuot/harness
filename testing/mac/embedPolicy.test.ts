import { describe, expect, test } from "bun:test";
import { embedFailurePage, embedRequestHeaders, embedResponseHeaders, embedUpstream, externalOpenAllowed, frameNavigation, MAX_EXTERNAL_OPENS, OPEN_WINDOW_MS, opensExternally, permissionAllowed } from "../../app/src/main/embeds";

const BASE = "http://127.0.0.1:7717";
const ID = "3f2a9c1e-0000-4000-8000-000000000001";

describe("harness-embed: requests map to the page's files on the service", () => {
  test("the entry, a nested asset and a query go to /embeds/<id>/", () => {
    expect(embedUpstream(`harness-embed://${ID}/`, BASE)?.url).toBe(`${BASE}/embeds/${ID}/`);
    expect(embedUpstream(`harness-embed://${ID}/assets/app.js?v=2`, BASE)?.url).toBe(`${BASE}/embeds/${ID}/assets/app.js?v=2`);
    expect(embedUpstream(`harness-embed://${ID}/`, BASE)?.path).toBe("");
  });
  test("a path can't climb out of the page to the rest of the API", () => {
    for (const p of ["../../tickets", "%2e%2e/%2e%2e/tickets", "a/..%2f..%2ftickets", "..%5c..%5ctickets"]) {
      const url = embedUpstream(`harness-embed://${ID}/${p}`, BASE)?.url;
      if (url !== undefined) expect(url.startsWith(`${BASE}/embeds/${ID}/`)).toBe(true);
    }
    expect(embedUpstream(`harness-embed://${ID}/a%2f..%2f..%2fx`, BASE)).toBeNull();
  });
  test("anything but a harness-embed: URL with a well-formed id is refused", () => {
    expect(embedUpstream(`http://${ID}/`, BASE)).toBeNull();
    expect(embedUpstream("harness-embed://-bad/", BASE)).toBeNull();
    expect(embedUpstream("not a url", BASE)).toBeNull();
  });
  test("the token goes to the service and only the range comes from the page", () => {
    const h = embedRequestHeaders(new Headers({ range: "bytes=0-9", cookie: "x=1", authorization: "Bearer page-guess" }), "tok");
    expect(h.get("authorization")).toBe("Bearer tok");
    expect(h.get("range")).toBe("bytes=0-9");
    expect(h.get("cookie")).toBeNull();
  });
  test("responses keep type and range, add nosniff and open CORS, and drop the rest", () => {
    const h = embedResponseHeaders(new Headers({ "content-type": "text/css", "content-range": "bytes 0-9/20", "set-cookie": "a=b" }));
    expect(h.get("content-type")).toBe("text/css");
    expect(h.get("content-range")).toBe("bytes 0-9/20");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("access-control-allow-origin")).toBe("*");
    expect(h.get("set-cookie")).toBeNull();
  });
  test("a failed entry tells the embed so, keeping the status", async () => {
    const res = embedFailurePage(401);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("harnessEmbedFailed: 401");
    expect(embedFailurePage(0).status).toBe(502);
  });
});

describe("embeds stay inside their frame", () => {
  test("permissions go to the app's own pages only", () => {
    expect(permissionAllowed("file:///Applications/Harness.app/index.html")).toBe(true);
    expect(permissionAllowed("http://127.0.0.1:7717/plugins/x/")).toBe(true);
    expect(permissionAllowed(`harness-embed://${ID}/`)).toBe(false);
    expect(permissionAllowed("https://example.com/")).toBe(false);
    expect(permissionAllowed("http://127.0.0.1.evil.com/")).toBe(false);
    expect(permissionAllowed(undefined)).toBe(false);
  });
  test("the app window never leaves its page, and an embed never leaves its own files", () => {
    expect(frameNavigation({ isMainFrame: true, frameUrl: "file:///a/index.html", url: `harness-embed://${ID}/` })).toBe("deny");
    expect(frameNavigation({ isMainFrame: true, frameUrl: "file:///a/index.html", url: "file:///a/index.html#/board" })).toBe("allow");
    expect(frameNavigation({ isMainFrame: false, frameUrl: `harness-embed://${ID}/`, url: `harness-embed://${ID}/next.html` })).toBe("allow");
    expect(frameNavigation({ isMainFrame: false, frameUrl: `harness-embed://${ID}/`, url: "harness-embed://other-page/" })).toBe("deny");
    expect(frameNavigation({ isMainFrame: false, frameUrl: `harness-embed://${ID}/`, url: "https://example.com/" })).toBe("deny");
    expect(frameNavigation({ isMainFrame: false, frameUrl: `harness-embed://${ID}/`, url: "http://127.0.0.1:7717/tickets" })).toBe("deny");
    // A frame's first load (about:blank before its src) and plugin frames keep their own rules.
    expect(frameNavigation({ isMainFrame: false, frameUrl: "about:blank", url: `harness-embed://${ID}/` })).toBe("allow");
    expect(frameNavigation({ isMainFrame: false, frameUrl: "http://127.0.0.1:7717/plugins/x/", url: "http://127.0.0.1:7717/plugins/x/b" })).toBe("allow");
  });
  test("popups open in the browser only for http(s)", () => {
    expect(opensExternally("https://example.com/")).toBe(true);
    expect(opensExternally("file:///etc/passwd")).toBe(false);
    expect(opensExternally(`harness-embed://${ID}/`)).toBe(false);
  });
});

test("frames open the system browser at most MAX_EXTERNAL_OPENS times in a window, then again once it passes", () => {
  const opened: number[] = [];
  const t0 = 1_000_000;
  const results = Array.from({ length: MAX_EXTERNAL_OPENS + 2 }, (_, i) => externalOpenAllowed(opened, t0 + i));
  expect(results).toEqual([...Array(MAX_EXTERNAL_OPENS).fill(true), false, false]);
  expect(externalOpenAllowed(opened, t0 + OPEN_WINDOW_MS - 1)).toBe(false);
  expect(externalOpenAllowed(opened, t0 + OPEN_WINDOW_MS)).toBe(true);
});
