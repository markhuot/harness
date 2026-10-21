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
  for (const kind of ["plan", "work", "review", "complete", "conductor", "triage", "chat"] as const) expect(args(kind)).not.toContain("--disallowedTools");
});

test("only planning and review runs are allowed to launch the adviser sub-agent", () => {
  for (const kind of ["plan", "review"] as const) expect(listAfter(args(kind), "--allowedTools")).toEqual(expect.arrayContaining(["Agent", "Task"]));
  for (const kind of ["work", "conductor", "cos"] as const) expect(listAfter(args(kind), "--allowedTools")).not.toContain("Agent");
});
