import { expect, test } from "bun:test";
import { StreamJsonParser } from "../../../service/src/drivers/claude-code";

const call = { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "git push" } }] } };
const result = (text: string, isError = true) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", is_error: isError, content: text }] } });

test("a denial by Claude Code's auto mode classifier is logged and reported as a classifier denial with its reason", () => {
  const parser = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
  parser.handle(call);
  const events = parser.handle(result("Permission for this action has been denied by the Claude Code auto mode classifier. Reason: Pushes to a remote. If you have other tasks…"));
  expect(events.find((e) => e.type === "permission")).toMatchObject({ log: { tool: "Bash", decision: "deny", source: "classifier", reason: "Pushes to a remote" } });
  expect(events.find((e) => e.type === "permission_denied")).toMatchObject({ toolName: "Bash", input: { command: "git push" }, reason: "Pushes to a remote", source: "classifier" });
});

test("an ordinary failed call is no permission event at all", () => {
  const parser = new StreamJsonParser(null, { requested: "auto", mode: "auto" });
  parser.handle(call);
  const events = parser.handle(result("fatal: no upstream configured"));
  expect(events.some((e) => e.type === "permission" || e.type === "permission_denied")).toBe(false);
});
