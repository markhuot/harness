import { describe, expect, test } from "bun:test";
import { fakeContext, fakeOps } from "./fakes";
import { permissionPrompt } from "./permission";
import type { ToolResult } from "./types";

const decision = (r: ToolResult) => {
  expect(r.isError).toBeUndefined(); // the CLI always needs a parseable answer
  expect(r.content).toHaveLength(1);
  return JSON.parse((r.content[0] as { text: string }).text);
};

describe("permission_prompt", () => {
  test("passes tool_name and input to requestApproval and returns allow with updatedInput", async () => {
    const ops = fakeOps({ requestApproval: async (_c: unknown, _t: string, input: any) => ({ behavior: "allow", updatedInput: { ...input, command: "git init -q" } }) });
    const r = await permissionPrompt.execute({ tool_name: "Bash", input: { command: "git init" }, tool_use_id: "toolu_1" }, fakeContext({ ops }));
    expect(ops.calls).toEqual([{ method: "requestApproval", args: ["Bash", { command: "git init" }, { viaPromptTool: true }] }]);
    expect(decision(r)).toEqual({ behavior: "allow", updatedInput: { command: "git init -q" } });
  });

  test("allow without a usable updatedInput falls back to the original input", async () => {
    const ops = fakeOps({ requestApproval: async () => ({ behavior: "allow", updatedInput: null }) });
    const r = await permissionPrompt.execute({ tool_name: "Write", input: { file_path: "/x" } }, fakeContext({ ops }));
    expect(decision(r)).toEqual({ behavior: "allow", updatedInput: { file_path: "/x" } });
  });

  test("deny carries the ops message", async () => {
    const ops = fakeOps({ requestApproval: async () => ({ behavior: "deny", message: "Blocked pending human approval. Stop now." }) });
    const r = await permissionPrompt.execute({ tool_name: "Bash", input: { command: "rm -rf /" } }, fakeContext({ ops }));
    expect(decision(r)).toEqual({ behavior: "deny", message: "Blocked pending human approval. Stop now." });
  });

  test("ops failures and a missing tool_name become denials, not errors", async () => {
    const ops = fakeOps({ requestApproval: async () => { throw new Error("no ticket"); } });
    const failed = decision(await permissionPrompt.execute({ tool_name: "Bash", input: {} }, fakeContext({ ops })));
    expect(failed.behavior).toBe("deny");
    expect(failed.message).toContain("no ticket");
    const missing = decision(await permissionPrompt.execute({ input: {} }, fakeContext({ ops: fakeOps() })));
    expect(missing.behavior).toBe("deny");
  });

  test("missing input is sent as {}", async () => {
    const ops = fakeOps();
    await permissionPrompt.execute({ tool_name: "WebFetch" }, fakeContext({ ops }));
    expect(ops.calls[0]!.args).toEqual(["WebFetch", {}, { viaPromptTool: true }]);
  });
});
