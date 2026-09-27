import { expect, test } from "bun:test";
import { HarnessApiError } from "@harness/shared";
import { describeError, isUnauthorized, probeServer } from "./connection";

type Route = (url: string, init?: { headers?: Record<string, string> }) => { status: number; body: string } | "throw" | "hang";

function fakeFetch(route: Route) {
  const calls: { url: string; auth?: string }[] = [];
  const f = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    calls.push({ url, auth: init?.headers?.authorization });
    const r = route(url, init);
    if (r === "throw") return Promise.reject(new TypeError("Network request failed"));
    if (r === "hang")
      return new Promise<never>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))),
      );
    return Promise.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body });
  };
  return { f, calls };
}

const health = { status: 200, body: JSON.stringify({ data: { ok: true, version: "0.1.0", pid: 1 } }) };

test("healthy service + good token: ok with version; token only sent to the authenticated route", async () => {
  const { f, calls } = fakeFetch((url) => (url.endsWith("/health") ? health : { status: 200, body: '{"data":{}}' }));
  expect(await probeServer("http://100.64.0.2:7717/", "tok", { fetch: f })).toEqual({ ok: true, version: "0.1.0" });
  expect(calls).toEqual([
    { url: "http://100.64.0.2:7717/health", auth: undefined },
    { url: "http://100.64.0.2:7717/settings", auth: "Bearer tok" },
  ]);
});

test("401 on the authenticated route → unauthorized", async () => {
  const { f } = fakeFetch((url) => (url.endsWith("/health") ? health : { status: 401, body: '{"error":"unauthorized"}' }));
  const r = await probeServer("http://h:7717", "old", { fetch: f });
  expect(r).toMatchObject({ ok: false, kind: "unauthorized" });
});

test("network failure → unreachable, naming the host and the Network setting", async () => {
  const { f, calls } = fakeFetch(() => "throw");
  const r = await probeServer("http://100.64.0.2:7717", "t", { fetch: f });
  expect(r).toMatchObject({ ok: false, kind: "unreachable" });
  if (!r.ok) expect(r.message).toContain("100.64.0.2:7717");
  if (!r.ok) expect(r.message).toContain("Settings → Network");
  expect(calls).toHaveLength(1); // never sends the token to a host that didn't answer /health
});

test("a hung host times out", async () => {
  const { f } = fakeFetch(() => "hang");
  expect(await probeServer("http://h:1", "t", { fetch: f, timeoutMs: 20 })).toMatchObject({ ok: false, kind: "timeout" });
});

test("something else on that port → not-harness, token not sent", async () => {
  for (const res of [{ status: 200, body: "<html>router login</html>" }, { status: 404, body: "" }, { status: 200, body: '{"data":{"ok":false}}' }]) {
    const { f, calls } = fakeFetch(() => res);
    expect(await probeServer("http://h:80", "t", { fetch: f })).toMatchObject({ ok: false, kind: "not-harness" });
    expect(calls.every((c) => !c.auth)).toBe(true);
  }
});

test("describeError", () => {
  expect(describeError(new HarnessApiError(401, "unauthorized"))).toMatch(/401/);
  expect(describeError(new HarnessApiError(409, "Key taken"))).toBe("Key taken");
  expect(describeError(new TypeError("Network request failed"), "http://h:1")).toMatch(/Couldn't reach h:1/);
  expect(describeError(new Error("boom"))).toBe("boom");
  expect(isUnauthorized(new HarnessApiError(401, "x"))).toBe(true);
  expect(isUnauthorized(new HarnessApiError(403, "x"))).toBe(false);
});
