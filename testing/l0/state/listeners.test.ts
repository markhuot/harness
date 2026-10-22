import { describe, expect, test } from "bun:test";
import type { Watcher } from "../../../shared/src/protocol";
import { chiefListeners, listenerCommand, listenerError, listenerNextRun, listenerOwner, listenerSchedule, listenerStatus } from "../../../shared/src/state/listeners";

const w = (id: string, patch: Partial<Watcher> = {}): Watcher => ({
  id, name: id, command: "run", args: [], prompt: "", cwd: null, env: {}, mode: "interval", intervalSec: 300, enabled: true, driver: null,
  lastRunAt: null, lastError: null, createdAt: 1, updatedAt: 1, ...patch,
});
const all = { ticketId: "cos-all", scope: "all" as const };
const work = { ticketId: "cos-work", scope: "group:g1" as const };

describe("chiefListeners", () => {
  const list = [w("b", { cosId: "cos-work" }), w("a", { cosId: "cos-all" }), w("orphan"), w("off", { cosId: "cos-work", enabled: false }), w("z", { cosId: null })];
  test("a group's chief gets only the watchers it owns; a deleted chief's watchers (cosId null) are not its", () => {
    expect(chiefListeners(list, work).map((x) => x.id)).toEqual(["b", "off"]);
  });
  test("the All chief gets every watcher, paused last, each group by name", () => {
    expect(chiefListeners(list, all).map((x) => x.id)).toEqual(["a", "b", "orphan", "z", "off"]);
  });
  test("a watcher from an older service with no cosId belongs to the All chief only", () => {
    expect(chiefListeners([w("x")], work)).toEqual([]);
    expect(chiefListeners([w("x")], all)).toHaveLength(1);
  });
});

describe("listenerCommand", () => {
  test("drops leading VAR=value assignments and never shows env", () => {
    expect(listenerCommand({ command: 'TOKEN=abc FOO="a b" watch-jira --project FOO', args: [] })).toBe("watch-jira --project FOO");
  });
  test("masks flags, headers, bearer tokens, key assignments and URL passwords", () => {
    expect(listenerCommand({ command: "curl -H 'Authorization: Bearer abc123' https://u:pw@host/x", args: [] })).toBe("curl -H 'Authorization: ***' https://u:***@host/x");
    expect(listenerCommand({ command: "cli --api-key=abc --token xyz --name ok", args: [] })).toBe("cli --api-key=*** --token *** --name ok");
    expect(listenerCommand({ command: "env GH_TOKEN=abc gh pr list", args: [] })).toBe("env GH_TOKEN=*** gh pr list");
    expect(listenerCommand({ command: "git fetch https://u:pw@host/x.git", args: [] })).toBe("git fetch https://u:***@host/x.git");
  });
  test("a legacy executable with args reads as one line, and a loop shows its first line cut to length", () => {
    expect(listenerCommand({ command: "watch-prs", args: ["--project", "my repo"] })).toBe("watch-prs --project 'my repo'");
    const out = listenerCommand({ command: `while true; do\n${"x".repeat(200)}\ndone`, args: [] }, 20);
    expect(out).toBe("while true; do");
    expect(listenerCommand({ command: "x".repeat(200), args: [] }, 20)).toHaveLength(20);
  });
});

describe("listenerError", () => {
  test("is the first line, masked and short", () => {
    expect(listenerError({ lastError: null })).toBe("");
    expect(listenerError({ lastError: "auth failed: Bearer sk-123\nstack…" })).toBe("auth failed: Bearer ***");
    expect(listenerError({ lastError: "e".repeat(300) }).length).toBe(120);
  });
});

describe("status, schedule, next run", () => {
  const live = (state: "running" | "waiting" | "stopped", nextRunAt: number | null = null) => ({ state, since: 1, nextRunAt, failures: 0 });
  test("paused beats running beats error beats active", () => {
    expect(listenerStatus(w("a", { enabled: false, lastError: "x", live: live("running") }))).toBe("paused");
    expect(listenerStatus(w("a", { lastError: "x", live: live("running") }))).toBe("running");
    expect(listenerStatus(w("a", { lastError: "x", live: live("waiting") }))).toBe("error");
    expect(listenerStatus(w("a"))).toBe("active");
  });
  test("intervals read in the largest whole unit; loops run continuously", () => {
    expect(listenerSchedule({ mode: "interval", intervalSec: 45 })).toBe("Every 45s");
    expect(listenerSchedule({ mode: "interval", intervalSec: 300 })).toBe("Every 5m");
    expect(listenerSchedule({ mode: "interval", intervalSec: 7200 })).toBe("Every 2h");
    expect(listenerSchedule({ mode: "interval", intervalSec: 90 })).toBe("Every 90s");
    expect(listenerSchedule({ mode: "loop", intervalSec: 300 })).toBe("Runs continuously");
  });
  test("a paused listener has no next run", () => {
    expect(listenerNextRun({ enabled: true, live: live("waiting", 5) })).toBe(5);
    expect(listenerNextRun({ enabled: false, live: live("waiting", 5) })).toBeNull();
    expect(listenerNextRun({ enabled: true })).toBeNull();
  });
});

describe("listenerOwner", () => {
  const name = (id: string) => (id === "cos-work" ? "Work" : null);
  test("tags a watcher another chief owns, not the viewer's own or an unowned one", () => {
    expect(listenerOwner({ cosId: "cos-work" }, all, name)).toBe("Work");
    expect(listenerOwner({ cosId: "cos-all" }, all, name)).toBeNull();
    expect(listenerOwner({ cosId: null }, all, name)).toBeNull();
    expect(listenerOwner({}, all, name)).toBeNull();
  });
});
