import { describe, expect, test } from "bun:test";
import { CHAT_MODE_TTL_MS, closeChatMode, isChatMode, moveSwitchLabel, openChatMode, setChatMode, type ChatModes } from "./chatMode";

describe("chat mode per ticket", () => {
  test("off by default; turning the switch off chats until it's turned back on", () => {
    const m: ChatModes = new Map();
    expect(isChatMode(m, "A-1", 0)).toBe(false);
    setChatMode(m, "A-1", true);
    expect(isChatMode(m, "A-1", 0)).toBe(true);
    expect(isChatMode(m, "A-2", 0)).toBe(false);
    // While the ticket is open it never lapses.
    expect(isChatMode(m, "A-1", 10 * CHAT_MODE_TTL_MS)).toBe(true);
    setChatMode(m, "A-1", false);
    expect(isChatMode(m, "A-1", 0)).toBe(false);
  });

  test("closing starts a 5 minute timer; it lapses exactly at the TTL", () => {
    const m: ChatModes = new Map();
    setChatMode(m, "A-1", true);
    closeChatMode(m, "A-1", 1000);
    expect(isChatMode(m, "A-1", 1000 + CHAT_MODE_TTL_MS - 1)).toBe(true);
    expect(isChatMode(m, "A-1", 1000 + CHAT_MODE_TTL_MS)).toBe(false);
  });

  test("re-opening within the TTL holds it again and the timer starts over on the next close", () => {
    const m: ChatModes = new Map();
    setChatMode(m, "A-1", true);
    closeChatMode(m, "A-1", 0);
    openChatMode(m, "A-1", CHAT_MODE_TTL_MS - 1);
    expect(isChatMode(m, "A-1", 3 * CHAT_MODE_TTL_MS)).toBe(true); // open: no expiry
    closeChatMode(m, "A-1", 3 * CHAT_MODE_TTL_MS);
    expect(isChatMode(m, "A-1", 4 * CHAT_MODE_TTL_MS - 1)).toBe(true);
    expect(isChatMode(m, "A-1", 4 * CHAT_MODE_TTL_MS)).toBe(false);
  });

  test("re-opening after the TTL is back to moving the ticket, and stays that way", () => {
    const m: ChatModes = new Map();
    setChatMode(m, "A-1", true);
    closeChatMode(m, "A-1", 0);
    openChatMode(m, "A-1", CHAT_MODE_TTL_MS);
    expect(m.has("A-1")).toBe(false);
    expect(isChatMode(m, "A-1", CHAT_MODE_TTL_MS)).toBe(false);
  });

  test("opening or closing a ticket that never chatted records nothing", () => {
    const m: ChatModes = new Map();
    openChatMode(m, "A-1", 0);
    closeChatMode(m, "A-1", 0);
    expect(m.size).toBe(0);
  });
});

describe("moveSwitchLabel", () => {
  test("offered where a message would change the ticket, never in progress, done, or on a pending approval", () => {
    const at = (status: "planning" | "in_progress" | "blocked" | "review" | "done", pendingApproval: object | null = null) =>
      moveSwitchLabel({ status, pendingApproval: pendingApproval as never });
    expect(at("planning")).toBe("Revise the plan");
    expect(at("blocked")).toBe("Move to in progress");
    expect(at("review")).toBe("Move to in progress");
    expect(at("in_progress")).toBeNull();
    expect(at("done")).toBeNull();
    expect(at("blocked", { toolName: "Bash" })).toBeNull();
  });
});
