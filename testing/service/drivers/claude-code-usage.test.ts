import { describe, expect, test } from "bun:test";
import { CLAUDE_USAGE_EXPIRED, ClaudeCodeDriver, retryAfterMs } from "../../../service/src/drivers/claude-code";
import { PlanUsageError } from "../../../service/src/drivers/types";
import { DEFAULT_SETTINGS } from "../../../service/src/orchestrator/settings";

const body = { five_hour: { utilization: 20, resets_at: "2026-10-10T11:00:00+00:00" } };
const json = (status: number, b: unknown = body) => new Response(JSON.stringify(b), { status });

function driver(answers: (token: string) => Response | Promise<Response>, over: { stored?: string | null; login?: string[] } = {}) {
  const seen: string[] = [];
  const d = new ClaudeCodeDriver({
    settings: () => ({ ...DEFAULT_SETTINGS, claudeOauthToken: over.stored ?? null }),
    fetch: (async (_url: string, init: RequestInit) => {
      const token = new Headers(init.headers).get("authorization")!.replace("Bearer ", "");
      seen.push(token);
      return answers(token);
    }) as never,
    loginTokens: async () => over.login ?? [],
  });
  return { d, seen };
}

describe("ClaudeCodeDriver.planUsage", () => {
  test("tries the stored token first and falls back to the CLI's login when it's refused", async () => {
    const { d, seen } = driver((t) => (t === "stored" ? json(401, {}) : json(200)), { stored: "stored", login: ["login-token"] });
    await d.planUsage();
    expect(seen).toEqual(["stored", "login-token"]);
  });

  test("with no token anywhere it asks to sign in; when every token is refused it says the same", async () => {
    await expect(driver(() => json(200)).d.planUsage()).rejects.toThrow("Sign in to Claude Code to see plan usage");
    await expect(driver(() => json(401, {}), { login: ["a", "b"] }).d.planUsage()).rejects.toThrow("Sign in to Claude Code to see plan usage");
  });

  test("a login whose access token has lapsed says it expired, not that nobody signed in", async () => {
    const expired = () => json(401, { type: "error", error: { type: "authentication_error", message: "OAuth access token has expired. Re-authenticate to continue." } });
    await expect(driver(expired, { login: ["kc"] }).d.planUsage()).rejects.toThrow(CLAUDE_USAGE_EXPIRED);
    // A refused setup token after an expired login doesn't hide the expiry
    await expect(driver((t) => (t === "kc" ? expired() : json(401, {})), { login: ["kc", "file"] }).d.planUsage()).rejects.toThrow(CLAUDE_USAGE_EXPIRED);
    await expect(driver((t) => (t === "stored" ? json(401, {}) : expired()), { stored: "stored", login: ["kc"] }).d.planUsage()).rejects.toThrow(CLAUDE_USAGE_EXPIRED);
  });

  test("a 429 carries the Retry-After the server sent", async () => {
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "1200" } });
    const err = await driver(limited, { login: ["t"] }).d.planUsage().catch((e) => e);
    expect((err as PlanUsageError).retryAfterMs).toBe(1_200_000);
    const none = await driver(() => json(429, {}), { login: ["t"] }).d.planUsage().catch((e) => e);
    expect((none as PlanUsageError).retryAfterMs).toBeUndefined();
  });

  test("retryAfterMs reads seconds or an HTTP date, and ignores junk", () => {
    expect(retryAfterMs("90")).toBe(90_000);
    expect(retryAfterMs("Wed, 21 Oct 2026 07:30:00 GMT", Date.parse("Wed, 21 Oct 2026 07:00:00 GMT"))).toBe(1_800_000);
    for (const v of [null, "", "soon", "-5", "0"]) expect(retryAfterMs(v)).toBeUndefined();
  });

  test("a 429 or 5xx is transient (the poller backs off); a network failure too", async () => {
    for (const status of [429, 503]) {
      const err = await driver(() => json(status, {}), { login: ["t"] }).d.planUsage().catch((e) => e);
      expect(err).toBeInstanceOf(PlanUsageError);
      expect((err as PlanUsageError).transient).toBe(true);
    }
    const down = await driver(() => Promise.reject(new Error("offline")), { login: ["t"] }).d.planUsage().catch((e) => e);
    expect((down as PlanUsageError).transient).toBe(true);
    expect((down as PlanUsageError).message).toContain("offline");
  });
});
