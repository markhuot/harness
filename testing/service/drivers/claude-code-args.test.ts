import { expect, test } from "bun:test";
import type { RunKind } from "@harness/shared";
import { buildClaudeArgs } from "../../../service/src/drivers/claude-code";
import { DEFAULT_SETTINGS } from "../../../service/src/orchestrator/settings";

const args = (kind: RunKind) => buildClaudeArgs({ kind, systemPrompt: "sys", mcp: { url: "http://127.0.0.1:1/mcp", headers: {} } }, DEFAULT_SETTINGS, null);
const listAfter = (a: string[], flag: string) => {
  const from = a.indexOf(flag);
  if (from < 0) return [];
  const to = a.findIndex((x, i) => i > from && x.startsWith("--"));
  return a.slice(from + 1, to < 0 ? undefined : to);
};

test("a chief of staff run has the CLI's sub-agent tools turned off; no other run does", () => {
  expect(listAfter(args("cos"), "--disallowedTools")).toEqual(["Agent", "Task"]);
  expect(listAfter(args("cos"), "--allowedTools")).not.toContain("Agent");
  for (const kind of ["plan", "work", "review", "complete", "conductor", "chat"] as const) expect(args(kind)).not.toContain("--disallowedTools");
});

test("only planning and review runs are allowed to launch the adviser sub-agent", () => {
  for (const kind of ["plan", "review"] as const) expect(listAfter(args(kind), "--allowedTools")).toEqual(expect.arrayContaining(["Agent", "Task"]));
  for (const kind of ["work", "conductor", "cos"] as const) expect(listAfter(args(kind), "--allowedTools")).not.toContain("Agent");
});

test("a chief of staff run has no built-in tool at all, so only the harness server is left; no other run is narrowed", () => {
  const a = args("cos");
  expect(a[a.indexOf("--tools") + 1]).toBe("");
  for (const kind of ["plan", "work", "review", "complete", "conductor", "chat"] as const) expect(args(kind)).not.toContain("--tools");
});

test("a triage run reads: Bash only, the user's MCP servers loaded, no sub-agents or web, a turn limit, and every other call asked of the harness", () => {
  const a = buildClaudeArgs({ kind: "triage", systemPrompt: "sys", maxTurns: 40, mcp: { url: "http://127.0.0.1:1/mcp", headers: {} } }, DEFAULT_SETTINGS, null);
  expect(a[a.indexOf("--tools") + 1]).toBe("Bash");
  expect(a).not.toContain("--strict-mcp-config"); // Jira and the rest must load
  expect(listAfter(a, "--disallowedTools")).toEqual(["Agent", "Task", "WebFetch", "WebSearch"]);
  expect(a[a.indexOf("--max-turns") + 1]).toBe("40");
  // The user's allow rules and hooks must not answer before the harness's gate does.
  expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
  expect(args("work")).not.toContain("--setting-sources");
  expect(a[a.indexOf("--permission-mode") + 1]).toBe("default");
  expect(a[a.indexOf("--permission-prompt-tool") + 1]).toMatch(/permission_prompt$/);
  // Runs that set no limit pass none.
  expect(args("work")).not.toContain("--max-turns");
});

test("triage runs in the CLI's auto mode only when its own setting says auto, never from the app's default mode", () => {
  const triage = (permissionMode?: "auto" | "read_only") => buildClaudeArgs({ kind: "triage", systemPrompt: "sys", permissionMode, mcp: { url: "http://127.0.0.1:1/mcp", headers: {} } }, { ...DEFAULT_SETTINGS, permissionMode: "auto" }, null);
  const mode = (a: string[]) => a[a.indexOf("--permission-mode") + 1];
  expect(mode(triage("auto"))).toBe("auto");
  expect(mode(triage("read_only"))).toBe("default");
  expect(mode(triage())).toBe("default");
  // Either way the prompt tool stays, so what the CLI doesn't judge itself reaches the harness.
  for (const a of [triage("auto"), triage("read_only")]) expect(a[a.indexOf("--permission-prompt-tool") + 1]).toMatch(/permission_prompt$/);
});
