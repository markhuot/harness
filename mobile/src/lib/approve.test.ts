import { describe, expect, test } from "bun:test";
import { completionOptions } from "@harness/shared";
import { approveMenuChoices, approveRequest, completeBody, completionActionOptions, primaryApproveRequest } from "./approve";

const git = { isGit: true, pullRequestHost: "github.com" };
const plain = { isGit: false };

describe("approveMenuChoices", () => {
  test("a git project with a PR host lists merge, PR, custom, then no action", () => {
    expect(approveMenuChoices(completionOptions({}, git)).map((c) => c.value)).toEqual(["merge", "pr", "custom", "none"]);
  });

  test("without a PR host there's no Open PR row", () => {
    expect(approveMenuChoices(completionOptions({}, { isGit: true, pullRequestHost: null })).map((c) => c.label)).toEqual(["Approve and merge", "Approve and…", "Approve and take no action"]);
  });

  test("a child on its parent's branch only offers taking no action", () => {
    expect(approveMenuChoices(completionOptions({}, git, { branch: "harness/web-1" })).map((c) => c.value)).toEqual(["none"]);
  });
});

describe("approveRequest", () => {
  test("no action completes without a run", () => {
    expect(approveRequest("none", "ignored")).toEqual({ via: "complete", body: { skipAgent: true } });
  });

  test("custom sends trimmed instructions with the action", () => {
    expect(approveRequest("custom", "  squash it  ")).toEqual({ via: "review", body: { decision: "approve", action: "custom", instructions: "squash it" } });
  });

  test("blank instructions are left out", () => {
    expect(approveRequest("custom", "   ")).toEqual({ via: "review", body: { decision: "approve", action: "custom" } });
  });

  test("merge never carries instructions", () => {
    expect(approveRequest("merge", "stray")).toEqual({ via: "review", body: { decision: "approve", action: "merge" } });
  });
});

describe("primaryApproveRequest", () => {
  test("approves with the preselected action", () => {
    const opts = completionOptions({ pullRequestUrl: "https://github.com/o/r/pull/1" }, git);
    expect(primaryApproveRequest(opts, {})).toEqual({ via: "review", body: { decision: "approve", action: "pr" } });
  });

  test("a child on its parent's branch merges", () => {
    const opts = completionOptions({ completionAction: "pr" }, git, { branch: "harness/web-1" });
    expect(primaryApproveRequest(opts, { completionAction: "pr" }).body).toEqual({ decision: "approve", action: "merge" });
  });

  test("a re-approval of a custom choice keeps its instructions", () => {
    const t = { completionAction: "custom" as const, completionInstructions: "deploy to staging" };
    expect(primaryApproveRequest(completionOptions(t, git), t).body).toEqual({ decision: "approve", action: "custom", instructions: "deploy to staging" });
  });

  test("a plain no-git Approve with no earlier choice sends custom without instructions", () => {
    expect(primaryApproveRequest(completionOptions({}, plain), { completionInstructions: "stale" }).body).toEqual({ decision: "approve", action: "custom" });
  });
});

describe("completionActionOptions", () => {
  test("names the parent's branch on merge", () => {
    expect(completionActionOptions(["merge"], "harness/web-1")).toEqual([{ value: "merge", label: "Merge into harness/web-1" }]);
    expect(completionActionOptions(["merge", "pr", "custom"]).map((o) => o.label)).toEqual(["Merge", "Open PR", "Custom"]);
  });
});

describe("completeBody", () => {
  test("sends the action only when the sheet offered the choice", () => {
    expect(completeBody(true, "pr", "")).toEqual({ action: "pr" });
    expect(completeBody(false, "pr", " note ")).toEqual({ instructions: "note" });
  });
});
