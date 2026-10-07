import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import type { RegisterDeviceBody } from "@harness/shared";
import { apnsEnvironment, loadDeviceId, PushRegistrar, ticketKeyFromDelivered, ticketKeyFromPush, ticketRoute } from "./push";

describe("ticketKeyFromPush", () => {
  test("the custom ticketKey wins over the thread id", () => {
    expect(ticketKeyFromPush({ aps: { alert: { title: "x" }, "thread-id": "OTHER-1" }, ticketKey: "HARNESS-342" })).toBe("HARNESS-342");
  });

  test("falls back to aps.thread-id", () => {
    expect(ticketKeyFromPush({ aps: { "thread-id": "HARNESS-12" } })).toBe("HARNESS-12");
  });

  test("unwraps the launch info of a click that opened the app (a UNNotificationResponse)", () => {
    expect(ticketKeyFromPush({ actionIdentifier: "com.apple.UNNotificationDefaultActionIdentifier", date: 1, identifier: "abc", userInfo: { aps: {}, ticketKey: "NYT-7" } })).toBe("NYT-7");
  });

  test("upper-cases a key and trims it", () => {
    expect(ticketKeyFromPush({ ticketKey: " nyt-7 " })).toBe("NYT-7");
  });

  test("rejects what isn't a ticket key, so a payload can't steer the route", () => {
    expect(ticketKeyFromPush({ ticketKey: "../settings" })).toBeNull();
    expect(ticketKeyFromPush({ ticketKey: "NYT-7/changes" })).toBeNull();
    expect(ticketKeyFromPush({ ticketKey: 42 })).toBeNull();
    expect(ticketKeyFromPush({ aps: { "thread-id": "no-key" } })).toBeNull();
  });

  test("nothing usable: a launch that wasn't from a notification, or junk", () => {
    expect(ticketKeyFromPush({})).toBeNull();
    expect(ticketKeyFromPush(null)).toBeNull();
    expect(ticketKeyFromPush("HARNESS-1")).toBeNull();
    expect(ticketKeyFromPush({ userInfo: "HARNESS-1" })).toBeNull();
  });
});

describe("ticketKeyFromDelivered", () => {
  test("the group (thread id) first, then the key the title starts with", () => {
    expect(ticketKeyFromDelivered({ groupId: "HARNESS-9", title: "OTHER-1 · Title" })).toBe("HARNESS-9");
    expect(ticketKeyFromDelivered({ groupId: "", title: "HARNESS-9 · Fix the thing · now" })).toBe("HARNESS-9");
    expect(ticketKeyFromDelivered({ groupId: "", title: "Something else" })).toBeNull();
  });
});

test("ticketRoute opens the ticket on All projects, like a harness:// link", () => {
  expect(ticketRoute("HARNESS-342")).toBe("#/board/all/ticket/HARNESS-342");
});

test("apnsEnvironment is production unless asked for sandbox", () => {
  expect(apnsEnvironment({})).toBe("production");
  expect(apnsEnvironment({ HARNESS_APNS_ENVIRONMENT: "sandbox" })).toBe("sandbox");
  expect(apnsEnvironment({ HARNESS_APNS_ENVIRONMENT: "nope" })).toBe("production");
});

describe("loadDeviceId", () => {
  test("makes one, then keeps returning it", () => {
    const path = join(tempDir("device-id-"), "sub", "device-id");
    const first = loadDeviceId(path, () => "11111111-2222-4333-8444-555555555555");
    expect(first).toBe("11111111-2222-4333-8444-555555555555");
    expect(loadDeviceId(path, () => "99999999-2222-4333-8444-555555555555")).toBe(first);
  });

  test("replaces a stored id that isn't a UUID", () => {
    const path = join(tempDir("device-id-"), "device-id");
    writeFileSync(path, "garbage");
    expect(loadDeviceId(path, () => "11111111-2222-4333-8444-555555555555")).toBe("11111111-2222-4333-8444-555555555555");
    expect(readFileSync(path, "utf8").trim()).toBe("11111111-2222-4333-8444-555555555555");
  });
});

describe("PushRegistrar", () => {
  const conn = (baseUrl = "http://a", token = "t") => ({ baseUrl, token, source: "env" as const });
  function setup(opts: { token?: () => Promise<string>; register?: () => Promise<unknown> } = {}) {
    const calls: { baseUrl: string; body: RegisterDeviceBody }[] = [];
    const logs: string[] = [];
    let apns = "aa11";
    const reg = new PushRegistrar({
      token: opts.token ?? (async () => apns),
      register: async (c, body) => {
        calls.push({ baseUrl: c.baseUrl, body });
        return opts.register?.();
      },
      deviceId: "dev-1",
      name: async () => "Mark's Mac",
      environment: "production",
      log: (m) => logs.push(m),
    });
    return { reg, calls, logs, setToken: (t: string) => (apns = t) };
  }

  test("registers once per connection and token", async () => {
    const { reg, calls, setToken } = setup();
    await reg.sync(conn());
    await reg.sync(conn());
    expect(calls).toEqual([{ baseUrl: "http://a", body: { id: "dev-1", platform: "mac", name: "Mark's Mac", apnsToken: "aa11", environment: "production" } }]);
    await reg.sync(conn("http://b"));
    setToken("bb22");
    await reg.sync(conn("http://b"));
    expect(calls.map((c) => [c.baseUrl, c.body.apnsToken])).toEqual([
      ["http://a", "aa11"],
      ["http://b", "aa11"],
      ["http://b", "bb22"],
    ]);
  });

  test("a connection error registers nothing", async () => {
    const { reg, calls } = setup();
    await reg.sync({ error: "no service", output: "" });
    expect(calls).toEqual([]);
  });

  test("an unsigned build's APNs failure is logged, not thrown", async () => {
    const { reg, calls, logs } = setup({ token: async () => Promise.reject(new Error("3000 NSCocoaErrorDomain no valid aps-environment")) });
    await reg.sync(conn());
    expect(calls).toEqual([]);
    expect(logs[0]).toContain("aps-environment");
  });

  test("a failed POST is retried on the next sync", async () => {
    let fail = true;
    const { reg, calls, logs } = setup({ register: async () => (fail ? Promise.reject(new Error("404")) : undefined) });
    await reg.sync(conn());
    fail = false;
    await reg.sync(conn());
    await reg.sync(conn());
    expect(calls.length).toBe(2);
    expect(logs.length).toBe(1);
  });

  test("a sync during another runs after it, with the latest connection", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { reg, calls } = setup({ token: async () => (first ? ((first = false), await gate, "aa11") : "aa11") });
    const one = reg.sync(conn("http://a"));
    void reg.sync(conn("http://b"));
    void reg.sync(conn("http://c"));
    release();
    await one;
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => c.baseUrl)).toEqual(["http://a", "http://c"]);
  });
});
